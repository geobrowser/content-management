/**
 * Known Entity IDs from the Knowledge Graph Ontology
 *
 * These are system properties and types defined in the root space.
 * See knowledge-graph-ontology.md for the full registry.
 */

export const ROOT_SPACE_ID = "a19c345ab9866679b001d7d2138d88a1";

// ─── Type IDs ────────────────────────────────────────────────────────────────

export const TYPES = {
  type:       "e7d737c536764c609fa16aa64a8c90ad",  // Type — meta-type for type definitions
  property:   "808a04ceb21c4d888ad12e240613e5ca",  // Property — meta-type for property definitions
  text_block: "76474f2f00894e77a0410b39fb17d0bf",  // Text Block — rich markdown content
  data_block: "b8803a8665de412bbb357e0c84adf473",  // Data Block — renders query or collection results
  image:      "ba4e41460010499da0a3caaa7f579d0e",  // Image — media entity with IPFS URL
};

// ─── Property IDs ────────────────────────────────────────────────────────────

export const PROPERTIES = {
  name:             "a126ca530c8e48d5b88882c734c38935",
  description:      "9b1f76ff9711404c861e59dc3fa7d037",
  types:            "8f151ba4de204e3c9cb499ddf96f48f1",
  blocks:           "beaba5cba67741a8b35377030613fc70",  // Blocks relation — attaches blocks to a parent entity
  markdown_content: "e3e363d1dd294ccb8e6ff3b76d99bc33",  // Markdown body for a text block
  data_source_type: "1f69cc9880d444abad493df6a7b15ee4",  // Declares query vs collection data source
  filter:           "14a46854bfd14b1882152785c2dab9f3",  // JSON-encoded filter for data blocks
  collection_item:  "a99f9ce12ffa4dac8c61f6310d46064a",  // Points to an entity in a collection
  view:             "1907fd1c81114a3ca378b1f353425b65",  // View preference on a Blocks relation
};

// ─── Data Source Singletons ──────────────────────────────────────────────────

export const QUERY_DATA_SOURCE      = "3b069b04adbe4728917d1283fd4ac27e";
export const COLLECTION_DATA_SOURCE = "1295037a5d9c4d09b27c5502654b9177";

// ─── Data Type Entity IDs ───────────────────────────────────────────────────
// These entities describe the underlying storage type for a property.
// A property with no Data Type relation is a relation-only property.

export const DATA_TYPES = {
  text:     "db22a933c151866ca01a4d9e471d5797",
  boolean:  "37a13ac05b6887ab83e772d4ece101ab",
  integer:  "4258025c2fa481c3a7acc4cbde4b82c2",
  float:    "d1f0423c3165808d942ff929bf9fc4ce",
  decimal:  "ced1a1c416628b57b3df543ec8ed47b8",
  date:     "31cc314f1c168c1cb49e6396b7510ed8",
  time:     "eef2373859108a4ba8251ad145fdc2f7",
  datetime: "ef3ccb2d52bb8a31b4802b0e6305ac1e",
  schedule: "28df8e42d6f389828d0156c20a9ee183",
  point:    "799dd1cff0068f7db65245cc6ace96ab",
  bytes:    "cf14d6bcd4c683f19139ce65552e99e0",
  rect:     "eb924b1b07ed818984c3596a979113b9",
  embedding:"128a4a5c75a48d2da3255ac7d25a1e11",
};

/** The Data Type property — a relation on a Property entity pointing to a Data Type entity. */
export const DATA_TYPE_PROPERTY = "6d29d57849bb4959baf72cc696b1671a";

/** Map from Data Type entity ID → SDK value type discriminant */
export const DATA_TYPE_TO_SDK: Record<string, string> = {
  [DATA_TYPES.text]:     'text',
  [DATA_TYPES.boolean]:  'boolean',
  [DATA_TYPES.integer]:  'integer',
  [DATA_TYPES.float]:    'float',
  [DATA_TYPES.date]:     'date',
  [DATA_TYPES.time]:     'time',
  [DATA_TYPES.datetime]: 'datetime',
  [DATA_TYPES.schedule]: 'schedule',
};

// ─── View Type IDs ───────────────────────────────────────────────────────────

export const VIEWS = {
  table:   "cba271cef7c140339047614d174c69f1",  // Table view (default)
  list:    "7d497dba09c249b8968f716bcf520473",  // List view
  gallery: "ccb70fc917f04a54b86e3b4d20cc7130",  // Gallery / grid view
  bullets: "0aaac6f7c916403eaf6d2e086dc92ada",  // Bulleted list view
};
