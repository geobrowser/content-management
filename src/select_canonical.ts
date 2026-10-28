// ─── Deterministic canonical-topic selection ────────────────────────────────
// Given a group of duplicate topic entity IDs (possibly spanning spaces), decide
// which one is canonical (kept/referenced) and which are secondaries (merged in).
//
// Priority cascade (highest first), applied AFTER excluding any candidate that
// lives in a personal or dataset space:
//   1. canonical space     — id is a canonical space's representative topic
//   2. canonical topic     — lives in Root (Geo) space
//   3. properly placed     — NOT Podcasts-only (the catch-all space is demoted)
//   4. featured            — has Tags → Featured topic
//   5. scored              — has a Score value (see escalation below)
//   6. curated             — has Tags → Curated topic
//   7. backlinks (desc)    — true totalCount across all spaces
//   8. data count (desc)   — values + relations
//   9. createdAt (asc)     — older wins
//  10. id (localeCompare)  — stable deterministic floor
//
// Escalation: if ≥2 eligible candidates are scored, the group is NOT merged —
// it is escalated for human review (see SELECTION_RULES.md). This is the key
// divergence from the reference impl (postgres_to_geo PR #15), which always picks.

import { gql } from './functions.ts';
import {
  ROOT_GEO_SPACE_ID,
  CANONICAL_SPACE_IDS,
  DATASET_SPACE_IDS,
  PODCASTS_SPACE_ID,
  SCORE_PROPERTY_ID,
  TAGS_RELATION_TYPE_ID,
  FEATURED_TOPIC_ENTITY_ID,
  CURATED_TOPIC_ENTITY_ID,
  type ScoringContext,
} from './constants.ts';

/** Run async tasks with bounded concurrency. */
async function pMap<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency = 12): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

// ─── Candidate metadata ─────────────────────────────────────────────────────

export interface CandidateMeta {
  id: string;
  name: string;
  found: boolean;
  spaceIds: string[];
  /** Spaces whose representative topic (space.topicId) IS this entity. An entity is
   * never vacated from a space it represents — that topic is part of the space's
   * identity, not duplicate data. */
  representsSpaces: string[];
  createdAt: number;        // unix seconds; Infinity when unknown (sorts last on age)
  backlinkCount: number;    // true totalCount across all spaces
  dataCount: number;        // values + relations (cross-space totals)
  hasFeatured: boolean;
  hasCurated: boolean;
  scoreValues: number[];    // one per space where a Score value exists
}

/** True if the candidate carries a Score value in any space. */
export function hasScore(m: CandidateMeta): boolean {
  return m.scoreValues.length > 0;
}

/** Best (max) score across spaces, or null when unscored. Informational only. */
export function scoreOf(m: CandidateMeta): number | null {
  return m.scoreValues.length ? Math.max(...m.scoreValues) : null;
}

/** Fetch selection metadata for a set of candidate IDs (deduped, concurrent). */
export async function fetchCandidateMeta(ids: string[]): Promise<Map<string, CandidateMeta>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, CandidateMeta>();

  await pMap(unique, async (id) => {
    const data = await gql(`{
      e: entities(filter: { id: { is: "${id}" } }) {
        id
        name
        spaceIds
        createdAt
        score: values(filter: { propertyId: { is: "${SCORE_PROPERTY_ID}" } }) {
          nodes { integer float decimal text }
        }
        tags: relations(filter: {
          typeId:     { is: "${TAGS_RELATION_TYPE_ID}" }
          toEntityId: { in: ["${FEATURED_TOPIC_ENTITY_ID}", "${CURATED_TOPIC_ENTITY_ID}"] }
        }) { nodes { toEntityId } }
      }
      bl: relationsConnection(filter: { toEntityId:   { is: "${id}" } }) { totalCount }
      vc: valuesConnection(filter:    { entityId:     { is: "${id}" } }) { totalCount }
      rc: relationsConnection(filter: { fromEntityId: { is: "${id}" } }) { totalCount }
      rep: spaces(filter: { topicId: { is: "${id}" } }) { id }
    }`);

    const e = data?.e?.[0];
    if (!e) {
      out.set(id, {
        id, name: '', found: false, spaceIds: [], representsSpaces: [], createdAt: Number.POSITIVE_INFINITY,
        backlinkCount: 0, dataCount: 0, hasFeatured: false, hasCurated: false, scoreValues: [],
      });
      return;
    }

    const scoreValues: number[] = [];
    for (const n of e.score?.nodes ?? []) {
      const raw = n.integer ?? n.float ?? n.decimal ?? n.text;
      if (raw != null && raw !== '') {
        const num = Number(raw);
        if (Number.isFinite(num)) scoreValues.push(num);
      }
    }

    const tagTargets = new Set<string>((e.tags?.nodes ?? []).map((n: any) => n.toEntityId));
    const createdNum = Number(e.createdAt);

    out.set(id, {
      id: e.id,
      name: (e.name == null || e.name === 'null') ? '' : e.name,
      found: true,
      spaceIds: e.spaceIds ?? [],
      representsSpaces: ((data?.rep ?? []) as Array<{ id: string }>).map(s => String(s.id)),
      createdAt: Number.isFinite(createdNum) ? createdNum : Number.POSITIVE_INFINITY,
      backlinkCount: data?.bl?.totalCount ?? 0,
      dataCount: (data?.vc?.totalCount ?? 0) + (data?.rc?.totalCount ?? 0),
      hasFeatured: tagTargets.has(FEATURED_TOPIC_ENTITY_ID),
      hasCurated: tagTargets.has(CURATED_TOPIC_ENTITY_ID),
      scoreValues,
    });
  });

  return out;
}

// ─── Scoring context (startup lookups) ──────────────────────────────────────

/**
 * Resolve the run-scoped context: each canonical space's representative topic ID
 * (rule 1) and the set of personal spaces among `candidateSpaceIds` (exclusion).
 */
export async function buildScoringContext(candidateSpaceIds: Iterable<string>): Promise<ScoringContext> {
  const canonicalSpaceTopicIds = new Set<string>();
  await pMap([...CANONICAL_SPACE_IDS], async (spaceId) => {
    try {
      const data = await gql(`{ space(id: "${spaceId}") { topicId } }`);
      const topicId = data?.space?.topicId;
      if (topicId) canonicalSpaceTopicIds.add(String(topicId));
    } catch {
      // A canonical space we can't resolve simply won't promote its topic via rule 1.
    }
  });

  const personalSpaceIds = new Set<string>();
  await pMap([...new Set(candidateSpaceIds)], async (spaceId) => {
    try {
      const data = await gql(`{ space(id: "${spaceId}") { type } }`);
      if (data?.space?.type === 'PERSONAL') personalSpaceIds.add(spaceId);
    } catch {
      // Unclassifiable spaces default to non-personal (safer: never wrongly drop a
      // DAO candidate; worst case a personal candidate slips through).
    }
  });

  return { canonicalSpaceTopicIds, personalSpaceIds };
}

// ─── Predicates & comparator ────────────────────────────────────────────────

const isCanonicalSpace = (m: CandidateMeta, ctx: ScoringContext) => ctx.canonicalSpaceTopicIds.has(m.id);
const isCanonicalTopic = (m: CandidateMeta) => m.spaceIds.includes(ROOT_GEO_SPACE_ID);

/**
 * True when the candidate's ONLY home is the Podcasts catch-all space. Such a
 * topic isn't properly placed, so it's demoted below any duplicate that lives in
 * a proper space (rule 3). A topic also present in another space (e.g. World
 * affairs, or Root) is NOT Podcasts-only and is unaffected. When every candidate
 * is Podcasts-only this ties for all and the cascade falls through.
 */
const isPodcastsOnly = (m: CandidateMeta) =>
  m.spaceIds.length > 0 && m.spaceIds.every(s => s === PODCASTS_SPACE_ID);

/** Reason a candidate is canonical-INELIGIBLE, or null if eligible.
 *
 * ROOT EXCEPTION (v3): the Root space has the highest priority — a Root-resident
 * candidate is ALWAYS eligible (and rule 2 then prefers it), regardless of any
 * personal/dataset residencies it also has. Those unmanaged residencies are simply
 * never touched. Rationale: the Root copy IS the graph's canonical entity; vacating
 * it in favor of a "cleaner" twin was backwards. */
export function exclusionReason(m: CandidateMeta, ctx: ScoringContext): string | null {
  if (m.spaceIds.includes(ROOT_GEO_SPACE_ID)) return null;
  for (const s of m.spaceIds) {
    if (DATASET_SPACE_IDS.has(s)) return `dataset space ${s}`;
    if (ctx.personalSpaceIds.has(s)) return `personal space ${s}`;
  }
  return null;
}

/**
 * The candidate's residencies we may vacate: not personal, not dataset, and NOT a
 * space this entity represents (space.topicId === entity). A space's representative
 * topic is part of the space's identity — vacating it from its own space would gut
 * the space, so it survives there like a personal-space copy does.
 */
export function managedSpaces(m: CandidateMeta, ctx: ScoringContext): string[] {
  return m.spaceIds.filter(
    s => !DATASET_SPACE_IDS.has(s) && !ctx.personalSpaceIds.has(s) && !m.representsSpaces.includes(s),
  );
}

/** Spaces where the candidate SURVIVES a merge (never receives ops): personal,
 * dataset, and self-represented residencies. */
export function survivingSpaces(m: CandidateMeta, ctx: ScoringContext): string[] {
  return m.spaceIds.filter(s => !managedSpaces(m, ctx).includes(s));
}

/** The 9-level priority comparator. Negative ⇒ `a` ranks higher (wins). */
export function buildPriorityComparator(ctx: ScoringContext): (a: CandidateMeta, b: CandidateMeta) => number {
  return (a, b) => {
    const bool = (av: boolean, bv: boolean) => (av === bv ? 0 : av ? -1 : 1);
    let c: number;
    if ((c = bool(isCanonicalSpace(a, ctx), isCanonicalSpace(b, ctx)))) return c;   // 1
    if ((c = bool(isCanonicalTopic(a), isCanonicalTopic(b)))) return c;             // 2
    if ((c = bool(!isPodcastsOnly(a), !isPodcastsOnly(b)))) return c;               // 3 properly placed
    if ((c = bool(a.hasFeatured, b.hasFeatured))) return c;                         // 4
    if ((c = bool(hasScore(a), hasScore(b)))) return c;                            // 5
    if ((c = bool(a.hasCurated, b.hasCurated))) return c;                          // 6
    if (a.backlinkCount !== b.backlinkCount) return b.backlinkCount - a.backlinkCount; // 7
    if (a.dataCount !== b.dataCount) return b.dataCount - a.dataCount;             // 8
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;             // 9 older wins
    return a.id.localeCompare(b.id);                                               // 10
  };
}

// ─── Anchor space ───────────────────────────────────────────────────────────
// The merge runs the existing same-space dedup logic in ONE anchor space and
// redirects backlinks globally. Pick a space the canonical shares with every
// secondary so each secondary's data is merged via the safe same-space path
// (changeEntityId blind-recreates and would collide where the canonical already
// has data). Prefer a topical canonical space over Root.

function rankSpace(spaceId: string): number {
  // Lower = preferred. Topical canonical spaces first (by declared order),
  // then Root, then everything else.
  const canon = [...CANONICAL_SPACE_IDS];
  const idx = canon.indexOf(spaceId);
  if (idx >= 0) return idx;
  if (spaceId === ROOT_GEO_SPACE_ID) return canon.length;     // Root after topical
  return canon.length + 1;
}

function pickPreferred(spaces: string[]): string {
  return [...spaces].sort((a, b) => rankSpace(a) - rankSpace(b) || a.localeCompare(b))[0];
}

/** Choose the anchor space + whether every secondary lives there. */
function chooseAnchor(canonical: CandidateMeta, secondaries: CandidateMeta[]): { anchorSpaceId: string; allShareAnchor: boolean } {
  const canonSpaces = new Set(canonical.spaceIds);
  let shared = [...canonSpaces];
  for (const s of secondaries) {
    const sset = new Set(s.spaceIds);
    shared = shared.filter(sp => sset.has(sp));
  }
  if (shared.length > 0) return { anchorSpaceId: pickPreferred(shared), allShareAnchor: true };
  // No space common to all — anchor on the canonical's preferred space; secondaries
  // not resident there fall back to cross-space handling.
  const anchor = canonical.spaceIds.length ? pickPreferred(canonical.spaceIds) : ROOT_GEO_SPACE_ID;
  return { anchorSpaceId: anchor, allShareAnchor: false };
}

// ─── Top-level selection ────────────────────────────────────────────────────

export interface SelectionResult {
  status: 'ok' | 'escalate' | 'no-candidate';
  canonicalId?: string;
  canonicalName?: string;
  anchorSpaceId?: string;
  /**
   * Secondaries to merge — ONE ENTRY PER MANAGED RESIDENCY (an entity living in
   * 3 managed spaces yields 3 entries), so every residency we control is vacated.
   * The anchor-space entry takes the full data-merge path; other entries are
   * handled per-space via changeEntityId.
   */
  secondaries?: Array<{ id: string; spaceId: string; crossSpace: boolean }>;
  /** Fully-untouchable candidates (resident ONLY in personal/dataset spaces). */
  excluded: Array<{ id: string; name: string; reason: string }>;
  /**
   * Canonical-ineligible candidates (personal/dataset residency) that DO have
   * managed residencies: vacated from `managedSpaces`, surviving in `keptSpaces`
   * (personal/dataset residencies + spaces the entity represents).
   */
  vacated?: Array<{ id: string; name: string; managedSpaces: string[]; keptSpaces: string[]; representsSpaces: string[]; hasScore: boolean }>;
  /** For status==='escalate': the scored candidates that block the merge. */
  scored?: Array<{ id: string; name: string; score: number | null; spaceIds: string[] }>;
  /** Whether the canonical was a manual override (forcedCanonicalId). */
  forced?: boolean;
}

/** Emit one secondary entry per managed residency (anchor entry first when resident). */
function emitSecondaries(
  metas: CandidateMeta[],
  anchorSpaceId: string,
  ctx: ScoringContext,
): Array<{ id: string; spaceId: string; crossSpace: boolean }> {
  const out: Array<{ id: string; spaceId: string; crossSpace: boolean }> = [];
  for (const m of metas) {
    const managed = managedSpaces(m, ctx);
    // Not-found candidates (no residencies) fall back to a single anchor entry so
    // the merge still redirects any dangling references to the canonical. A FOUND
    // candidate with zero vacatable residencies emits nothing — it survives as-is.
    const spaces = managed.length ? managed : m.found ? [] : [anchorSpaceId];
    const ordered = [...spaces].sort((a, b) => Number(b === anchorSpaceId) - Number(a === anchorSpaceId));
    for (const s of ordered) out.push({ id: m.id, spaceId: s, crossSpace: s !== anchorSpaceId });
  }
  return out;
}

/**
 * Decide the canonical for a duplicate group.
 *
 * @param ids                candidate entity IDs (the CSV group)
 * @param ctx                scoring context from buildScoringContext
 * @param metaMap            metadata from fetchCandidateMeta (must cover all ids)
 * @param forcedCanonicalId  optional manual override (CSV canonical_id) — bypasses
 *                           the rule cascade and the both-scored escalation.
 */
export function selectCanonicalTopic(
  ids: string[],
  ctx: ScoringContext,
  metaMap: Map<string, CandidateMeta>,
  forcedCanonicalId?: string,
): SelectionResult {
  const metas = [...new Set(ids)].map(id => metaMap.get(id)).filter((m): m is CandidateMeta => !!m);

  // Three-way partition:
  //   eligible   — may be canonical, merged fully (no personal/dataset residency)
  //   vacatable  — canonical-INELIGIBLE (personal/dataset residency) but resident in
  //                managed spaces too: vacate those residencies; the twin survives
  //                only in its personal/dataset spaces
  //   excluded   — resident ONLY in personal/dataset spaces: nothing of ours to touch
  const excludedMetas: CandidateMeta[] = [];
  const vacatableMetas: CandidateMeta[] = [];
  const eligible: CandidateMeta[] = [];
  for (const m of metas) {
    const reason = exclusionReason(m, ctx);
    if (!reason) { eligible.push(m); continue; }
    if (m.found && managedSpaces(m, ctx).length > 0) vacatableMetas.push(m);
    else excludedMetas.push(m);
  }
  const excluded = excludedMetas.map(m => ({ id: m.id, name: m.name, reason: exclusionReason(m, ctx)! }));
  const vacatedReport = (anchorless: CandidateMeta[]) =>
    anchorless.map(m => ({
      id: m.id,
      name: m.name,
      managedSpaces: managedSpaces(m, ctx),
      keptSpaces: survivingSpaces(m, ctx),
      representsSpaces: m.representsSpaces,
      hasScore: hasScore(m),
    }));

  // ── Manual override ──
  if (forcedCanonicalId) {
    const forcedMeta = metaMap.get(forcedCanonicalId);
    const forcedExcluded = forcedMeta ? exclusionReason(forcedMeta, ctx) : null;
    // Secondaries = every other touchable candidate: eligible + vacatable.
    const secMetas = [...eligible, ...vacatableMetas].filter(m => m.id !== forcedCanonicalId);
    const canonical = forcedMeta ?? {
      id: forcedCanonicalId, name: '', found: false, spaceIds: [], representsSpaces: [], createdAt: Number.POSITIVE_INFINITY,
      backlinkCount: 0, dataCount: 0, hasFeatured: false, hasCurated: false, scoreValues: [],
    } as CandidateMeta;
    const { anchorSpaceId } = chooseAnchor(canonical, secMetas);
    return {
      status: 'ok',
      canonicalId: forcedCanonicalId,
      canonicalName: canonical.name,
      anchorSpaceId,
      secondaries: emitSecondaries(secMetas, anchorSpaceId, ctx),
      excluded: forcedExcluded ? [...excluded, { id: forcedCanonicalId, name: canonical.name, reason: `forced despite ${forcedExcluded}` }] : excluded,
      vacated: vacatedReport(vacatableMetas.filter(m => m.id !== forcedCanonicalId)),
      forced: true,
    };
  }

  if (eligible.length === 0) return { status: 'no-candidate', excluded };

  // ── Both-scored escalation ──
  const scoredEligible = eligible.filter(hasScore);
  if (scoredEligible.length >= 2) {
    return {
      status: 'escalate',
      excluded,
      scored: scoredEligible.map(m => ({ id: m.id, name: m.name, score: scoreOf(m), spaceIds: m.spaceIds })),
    };
  }

  // ── Rule cascade ──
  const sorted = [...eligible].sort(buildPriorityComparator(ctx));
  const canonical = sorted[0];
  // Losing eligibles are fully merged; vacatable twins are vacated from their
  // managed residencies only (personal/dataset copies survive untouched).
  const secMetas = [...sorted.slice(1), ...vacatableMetas];
  const { anchorSpaceId } = chooseAnchor(canonical, secMetas);

  return {
    status: 'ok',
    canonicalId: canonical.id,
    canonicalName: canonical.name,
    anchorSpaceId,
    secondaries: emitSecondaries(secMetas, anchorSpaceId, ctx),
    excluded,
    vacated: vacatedReport(vacatableMetas),
  };
}
