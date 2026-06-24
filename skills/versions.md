# Skill versions & changelog

Per-skill version history. Pairs with `SKILL-VERSIONS.json` (machine-checkable integrity: approved commit + content hash) — this file is the **human "what changed and why"**.

**On every approved change to a skill:**
1. Bump the `version` in that skill's `SKILL.md` frontmatter (semver: patch = wording/fix, minor = new capability, major = breaking workflow change).
2. Add a dated bullet under that skill below.
3. Regenerate the manifest: `python3 skill-dev/skill_versions.py generate`.
4. Commit all three together.

---

## non-actionable/

### geo-query — 0.1.0
- 2026-06 · Initial. GraphQL-over-HTTP querying (Nick's version); runs anywhere incl. browser. Folded in submission review/fact-check (merged from the retired geo-query-web). Person-ID corrected to `7ed45f2b…`.

### ontology-advisor — 0.1.0
- 2026-06 · Initial. Conversational modelling advice grounded in ONTOLOGY.md + live graph; read-only.

### geo-press-review — 0.2.0
- 2026-06 · Editor-friendly labels ("Not on Geo yet" instead of "not covered"); all sources rendered as clickable links.
- 2026-06 · Initial. External press (Google News/web) vs Geo coverage; three-bucket ranked output.

### qa-report-workflow — 0.1.0
- 2026-06 · Initial. Triage + report UI/UX bugs (editor-reported, or active hunting via Playwright MCP); copy-paste Linear/Notion/Slack output; markdown report file. *(Not yet committed/shipped.)*

### image-banner-recompose — 0.2.0
- 2026-06 · Initial in-repo. Recomposes an uploaded image (e.g. a book cover) into a 2364×640 banner — smart crop / outpaint / blurred backdrop / solid-edge extend, auto-picked per image; strategy-aware QA, unsharp finishing, low-res warning. Author: Armando; reviewed + rebuilt into a full skill by Moh. No graph writes.

### geo-describe — 0.1.0
- 2026-06 · Initial. Writes accurate, original, rules-compliant entity descriptions at scale: fact-extract → tiered parallel accuracy research → compose source-hidden → originality+accuracy+rules gate (`scripts/check_similarity.py`) → emit vetted description + Source for geo-publish. Makes no graph writes itself (hands off to geo-publish); advanced/needs the fuller Claude env (see `compatibility`). Author: Armando (spec), Moh (build).

## actionable/

### geo-publish — 0.3.0
- 2026-06 · Consolidated to one portable skill (GEO_PRIVATE_KEY, PK_SW fallback) + strong safeguards (dup check, schema gate, two-phase dry-run→confirm). Retired geo-publish-codex.
- earlier · 0.1–0.2 pre-consolidation publish skills.

### geo-clean — 0.1.0
- 2026-06 · Initial. Find/merge duplicates, delete orphans, fix data types/stale relations; bundled reference.md + big-merge.md; Discovery→Gates→Plan→dry-run→publish safeguards.

### geo-orchestrate — 0.1.0
- 2026-06 · Initial. Intent → plan → generate script → dry-run → confirm → publish; routes to query + publish.

### geo-discovery — 0.1.0
- 2026-06 · Initial. 6-stage gap-discovery pass over a space's daily stream → ranked Gap findings; read-only until human-reviewed publish stage. (Version normalized from `latest`.)
