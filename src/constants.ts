/**
 * Known Entity IDs from the Knowledge Graph Ontology
 *
 * These are system properties and types defined in the root space.
 * See knowledge-graph-ontology.md for the full registry.
 */

export const ROOT_SPACE_ID = "a19c345ab9866679b001d7d2138d88a1";

/** Alias — a topic whose `spaceIds` include this is a "canonical topic" (rule 2). */
export const ROOT_GEO_SPACE_ID = ROOT_SPACE_ID;

// ─── Deterministic topic selection ──────────────────────────────────────────
// Constants for choosing which duplicate topic is canonical. See
// skills/actionable/geo-clean/SKILL.md (Main-selection cascade) for the full
// priority order; ported from geo-explorers/geo-merge-topics (SELECTION_RULES.md).

/**
 * Canonical spaces. Each such space has a representative topic entity, resolved
 * at startup via `space(id){ topicId }`. A candidate whose id equals one of those
 * topicIds wins rule 1 (e.g. Crypto space c9f267dc… → topic 0fcd62b5…).
 */
export const CANONICAL_SPACE_IDS = new Set<string>([
  "c9f267dcb0d270718c2a3c45a64afd32",  // Crypto
  "41e851610e13a19441c4d980f2f2ce6b",  // AI
  "52c7ae149838b6d47ce0f3b2a5974546",  // Health
  "19f11bc6f1a62ac434936af814d1f8b5",  // Pharma
  "870e3b3068661e6280fad2ab456829bc",  // Technology
  "89bd89bf28ff8a0963faf92a8c905e20",  // World affairs
  "4582fbbee28a16589154f7e36f1ee3c5",  // U.S. Politics
  "d69608290513c2a91102c939b3265bd7",  // Industries
  "ec349623f33236aee13c12dcd629ee81",  // Education
  "9b611b848b12491b9b6b43f3cf019b8b",  // Software
  "84a679ce188f061ac9a92380bac2bab5",  // Places
  "784bfddae3f3976118c561bf28195b44",  // Documentation
  "b5a31f8182b042437ede0f84ee02f104",  // Podcasts
]);

/**
 * Dataset (bulk-import) spaces. A candidate that lives in any of these is never
 * selected as canonical AND is left untouched by the merge (hard exclusion).
 */
export const DATASET_SPACE_IDS = new Set<string>([
  "5908c73ad336472ccbd983491d2d17e4",  // Crypto datasets
  "941964642f4d3e70ef48f54a3915277d",  // AI datasets
  "44eb138f564fbed6ed9ce543de1b849c",  // Health datasets
  "da96a4c26e718bfa6c27c3b1f3c316cd",  // World affairs datasets
  "1b3d2963d14de99d4e440000125edb65",  // U.S. Politics datasets
]);

/**
 * Score property — "net upvotes minus downvotes" for a topic within a space.
 * Presence marks a topic as scored. If ≥2 eligible candidates are scored the
 * group is NOT merged but escalated for human review.
 */
export const SCORE_PROPERTY_ID = "85a4668a42fa4f488969c0a9de0c294b";

// ─── Voting data (system-maintained — NEVER migrated) ───────────────────────
// Geo's entity-voting feature: a user's up/down vote is recorded as a
// "Rank Votes" relation from a Rank entity (usually in the voter's personal
// space) to the voted entity, and aggregated into the "Score" value property
// ("net upvotes minus downvotes … maintained automatically and not
// user-editable"). None of this belongs to the entities we operate on, so
// merge/move/copy must not copy, redirect, or delete it. Score stays readable
// for selection; it just never appears in generated ops.

/** "Rank Votes" — relation type linking a Rank to a voted entity (SDK: RANK_VOTES_RELATION_TYPE). */
export const RANK_VOTES_RELATION_TYPE_ID = "19a4cfff45f24150abf2af0f43eb2eec";
/** "Vote Ordinal Value" — fractional-index position on a vote relation entity. */
export const VOTE_ORDINAL_VALUE_PROPERTY_ID = "49ee1b8918204e75a1ae38a2dcaad4a5";
/** "Vote Weighted Value" — numeric score on a vote relation entity. */
export const VOTE_WEIGHTED_VALUE_PROPERTY_ID = "103701ddcabe4a8e835b10345327b647";

/** Value properties our ops must never set, copy, or unset. */
export const EXCLUDED_VALUE_PROPERTY_IDS = new Set<string>([
  SCORE_PROPERTY_ID,
  VOTE_ORDINAL_VALUE_PROPERTY_ID,
  VOTE_WEIGHTED_VALUE_PROPERTY_ID,
]);

/** Relation types our ops must never create, redirect, or delete. */
export const EXCLUDED_RELATION_TYPE_IDS = new Set<string>([
  RANK_VOTES_RELATION_TYPE_ID,
]);

// ─── Anchored (identity) entities ─────────────────────────────────────────────
// A space's IDENTITY lives on its `page` (home) entity: the space name,
// description, Avatar (profile photo) and Cover images. These are "anchored" —
// deleting them empties the space's identity even if the rest is repopulated.
// A space wipe must SKIP them by default (see getAnchoredEntityIds() in
// functions.ts). Historical context: the Aug-2026 personal-space wipe deleted
// the profile photo + space description because no anchored-entity guard existed
// — the bulk script processed the page entity + Avatar/Cover images as ordinary
// rows. Removing them requires an explicit, separate override.
/** Avatar (profile photo) relation type — SDK ContentIds.AVATAR_PROPERTY. */
export const AVATAR_PROPERTY_ID = "1155befffad549b7a2e0da4777b8792c";
/** Cover image relation type — SDK SystemIds.COVER_PROPERTY. */
export const COVER_PROPERTY_ID = "34f535072e6b42c5a84443981a77cfa2";
/** Relation types that anchor a space's identity image entities. */
export const ANCHORED_IMAGE_RELATION_TYPE_IDS = new Set<string>([
  AVATAR_PROPERTY_ID,
  COVER_PROPERTY_ID,
]);

/**
 * The Podcasts space is a catch-all: every entity touched by a podcast episode
 * gets published here rather than its proper topical space. A topic whose ONLY
 * home is Podcasts is therefore "not yet properly placed" — so when a duplicate
 * exists in a proper space, the Podcasts-only copy is demoted from canonical
 * selection (it still merges in as a secondary).
 */
export const PODCASTS_SPACE_ID = "b5a31f8182b042437ede0f84ee02f104";

// ─── Tag relations (Featured / Curated topic) ───────────────────────────────
// A topic is "featured"/"curated" if it has a Tags relation (in any space)
// pointing to the corresponding tag entity.
export const TAGS_RELATION_TYPE_ID    = "257090341ba5406f94e4d4af90042fba";
export const FEATURED_TOPIC_ENTITY_ID = "b69b8b1659df4e6d99d79956a30e8932";
export const CURATED_TOPIC_ENTITY_ID  = "7f796eb5bfc5449c98649bf7d996a2ca";

/**
 * Run-scoped context for selection, built once at startup (`buildScoringContext`).
 * Avoids re-querying per candidate.
 */
export interface ScoringContext {
  /** Entity IDs that represent a canonical space (resolved via `space.topicId`). */
  canonicalSpaceTopicIds: Set<string>;
  /** Space IDs whose `type === 'PERSONAL'` — candidates in any are excluded. */
  personalSpaceIds: Set<string>;
}

/** Empty context — selection falls back to rules that need no startup lookups. */
export const EMPTY_SCORING_CONTEXT: ScoringContext = {
  canonicalSpaceTopicIds: new Set(),
  personalSpaceIds: new Set(),
};

// ─── Spaces (ranked, highest priority first) ────────────────────────────────

export const SPACES = [

  { name: 'Root',           id: 'a19c345ab9866679b001d7d2138d88a1' },
  { name: 'Podcasts',       id: 'b5a31f8182b042437ede0f84ee02f104' },
  { name: 'Geo Education',  id: '784bfddae3f3976118c561bf28195b44' },
  { name: 'Crypto',         id: 'c9f267dcb0d270718c2a3c45a64afd32' },
  { name: 'AI',             id: '41e851610e13a19441c4d980f2f2ce6b' },
  { name: 'Health',         id: '52c7ae149838b6d47ce0f3b2a5974546' },
  { name: 'Software',       id: '9b611b848b12491b9b6b43f3cf019b8b' },
  { name: 'Technology',     id: '870e3b3068661e6280fad2ab456829bc' },
  { name: 'Industries',     id: 'd69608290513c2a91102c939b3265bd7' },
  { name: 'World Affairs',  id: '89bd89bf28ff8a0963faf92a8c905e20' },
  //{ name: 'Podcasts',  id: '24cd3c3b36efb0e13ea53fead3f7d2b9' },
  //{ name: 'Podcasts',  id: 'bd5529695e011fdf76637d4addca733a' },

];

// ─── Type IDs ────────────────────────────────────────────────────────────────

export const TYPES = {
  type: "e7d737c536764c609fa16aa64a8c90ad",  // Type — meta-type for type definitions
  property: "808a04ceb21c4d888ad12e240613e5ca",  // Property — meta-type for property definitions
  text_block: "76474f2f00894e77a0410b39fb17d0bf",  // Text Block — rich markdown content
  data_block: "b8803a8665de412bbb357e0c84adf473",  // Data Block — renders query or collection results
  image: "ba4e41460010499da0a3caaa7f579d0e",  // Image — media entity with IPFS URL
  role: "e4e366e9d5554b6892bf7358e824afd2",
  skill: "9ca6ab1f3a114e49bbaf72e0c9a985cf",
  topic: "5ef5a5860f274d8e8f6c59ae5b3e89e2",
  claim: "96f859efa1ca4b229372c86ad58b694b",
  quote: "043a171c69184dc3a7dbb8471ca6fcc2",
  article: "a2a5ed0cacef46b1835de457956ce915",
  person: "7ed45f2bc48b419e8e4664d5ff680b0d",
  podcast: "4c81561d1f9541319cdddd20ab831ba2",
  episode: "972d201ad78045689e01543f67b26bee",
  exercise: "1362f6523665771634fafe2cd9a5854f",
  muscle_group: "ace998708d25f56dbc8e72a784526a11",
  training_category: "ef193dcb3282afebe466b46b8441c479",
  excercise_equipment: "ed834cda5168124075774c543866e81d",
  page: "480e3fc267f3499385fbacdf4ddeaa6b"
};

// ─── Property IDs ────────────────────────────────────────────────────────────

export const PROPERTIES = {
  name: "a126ca530c8e48d5b88882c734c38935",
  description: "9b1f76ff9711404c861e59dc3fa7d037",
  types: "8f151ba4de204e3c9cb499ddf96f48f1",
  blocks: "beaba5cba67741a8b35377030613fc70",  // Blocks relation — attaches blocks to a parent entity
  markdown_content: "e3e363d1dd294ccb8e6ff3b76d99bc33",  // Markdown body for a text block
  data_source_type: "1f69cc9880d444abad493df6a7b15ee4",  // Declares query vs collection data source
  filter: "14a46854bfd14b1882152785c2dab9f3",  // JSON-encoded filter for data blocks
  collection_item: "a99f9ce12ffa4dac8c61f6310d46064a",  // Points to an entity in a collection
  view: "1907fd1c81114a3ca378b1f353425b65",  // View preference on a Blocks relation
};

// ─── Data Source Singletons ──────────────────────────────────────────────────

export const QUERY_DATA_SOURCE = "3b069b04adbe4728917d1283fd4ac27e";
export const COLLECTION_DATA_SOURCE = "1295037a5d9c4d09b27c5502654b9177";

// ─── Data Type Entity IDs ───────────────────────────────────────────────────
// These entities describe the underlying storage type for a property.
// A property with no Data Type relation is a relation-only property.

export const DATA_TYPES = {
  text: "9edb6fcce4544aa5861139d7f024c010",  // Text
  boolean: "7aa4792eeacd41868272fa7fc18298ac",  // Checkbox
  integer: "149fd752d9d04f80820d1d942eea7841",  // Integer
  float: "9b597aaec31c46c88565a370da0c2a65",  // Float64
  decimal: "a3288c22a0564f6fb409fbcccb2c118c",  // Decimal
  date: "e661d10292794449a22367dbae1be05a",  // Date
  time: "ad75102b03c04d59903813ede9482742",  // Time
  datetime: "167664f668f840e1976b20bd16ed8d47",  // Datetime
  schedule: "caf4dd12ba4844b99171aff6c1313b50",  // Schedule
  point: "df250d17e364413d97792ddaae841e34",  // Point
  bytes: "66b433247667496899b48a89bd1de22b",  // Bytes
  embedding: "f732849378ba4577a33fac5f1c964f18",  // Embedding
  relation: "4b6d9fc1fbfe474c861c83398e1b50d9",  // Relation
};


/** The Data Type property — a relation on a Property entity pointing to a Data Type entity. */
export const DATA_TYPE_PROPERTY = "6d29d57849bb4959baf72cc696b1671a";

/** Map from Data Type entity ID → SDK value type discriminant */
export const DATA_TYPE_TO_SDK: Record<string, string> = {
  [DATA_TYPES.text]: 'text',
  [DATA_TYPES.boolean]: 'boolean',
  [DATA_TYPES.integer]: 'integer',
  [DATA_TYPES.float]: 'float',
  [DATA_TYPES.date]: 'date',
  [DATA_TYPES.time]: 'time',
  [DATA_TYPES.datetime]: 'datetime',
  [DATA_TYPES.schedule]: 'schedule',
};

// ─── View Type IDs ───────────────────────────────────────────────────────────

export const VIEWS = {
  table: "cba271cef7c140339047614d174c69f1",  // Table view (default)
  list: "7d497dba09c249b8968f716bcf520473",  // List view
  gallery: "ccb70fc917f04a54b86e3b4d20cc7130",  // Gallery / grid view
  bullets: "0aaac6f7c916403eaf6d2e086dc92ada",  // Bulleted list view
};
