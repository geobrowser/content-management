/**
 * Known Entity IDs from the Knowledge Graph Ontology
 *
 * These are system properties and types defined in the root space.
 * See knowledge-graph-ontology.md for the full registry.
 */

export const ROOT_SPACE_ID = "a19c345ab9866679b001d7d2138d88a1";

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
];

// ─── Type IDs ────────────────────────────────────────────────────────────────

export const TYPES = {
  type:       "e7d737c536764c609fa16aa64a8c90ad",  // Type — meta-type for type definitions
  property:   "808a04ceb21c4d888ad12e240613e5ca",  // Property — meta-type for property definitions
  text_block: "76474f2f00894e77a0410b39fb17d0bf",  // Text Block — rich markdown content
  data_block: "b8803a8665de412bbb357e0c84adf473",  // Data Block — renders query or collection results
  image:      "ba4e41460010499da0a3caaa7f579d0e",  // Image — media entity with IPFS URL
  role:      "e4e366e9d5554b6892bf7358e824afd2",  
  skill:      "9ca6ab1f3a114e49bbaf72e0c9a985cf", 
  topic:      "5ef5a5860f274d8e8f6c59ae5b3e89e2", 
  claim:      "96f859efa1ca4b229372c86ad58b694b", 
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
  text:      "9edb6fcce4544aa5861139d7f024c010",  // Text
  boolean:   "7aa4792eeacd41868272fa7fc18298ac",  // Checkbox
  integer:   "149fd752d9d04f80820d1d942eea7841",  // Integer
  float:     "9b597aaec31c46c88565a370da0c2a65",  // Float64
  decimal:   "a3288c22a0564f6fb409fbcccb2c118c",  // Decimal
  date:      "e661d10292794449a22367dbae1be05a",  // Date
  time:      "ad75102b03c04d59903813ede9482742",  // Time
  datetime:  "167664f668f840e1976b20bd16ed8d47",  // Datetime
  schedule:  "caf4dd12ba4844b99171aff6c1313b50",  // Schedule
  point:     "df250d17e364413d97792ddaae841e34",  // Point
  bytes:     "66b433247667496899b48a89bd1de22b",  // Bytes
  embedding: "f732849378ba4577a33fac5f1c964f18",  // Embedding
  relation:  "4b6d9fc1fbfe474c861c83398e1b50d9",  // Relation
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
