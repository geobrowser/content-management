# Gap finding entity schema (Stage 6)

**Source:** validated against the live graph via ontology-advisor (2026-05-31). The type and
property IDs below are the live, authoritative values — use them directly; this file is
self-contained. (The fuller governance write-up lives in the operator's `ontology-proposal.md`,
which is outside this repo and not needed to run Stage 6.)

**Target space:** AI datasets — `941964642f4d3e70ef48f54a3915277d` (DAO).
**Types:** LIVE as of 2026-05-31 (executed) — wire Stage 6 to these IDs:
- `Gap finding` = `1e621514688144938249bc5fc0aef8be`
- `Gap type` = `956e794255f04072bd505a7c6aa27d85` (members: Coverage/Depth/Freshness/Structural/Trending)
- `Gap status` = `680dbb63a5c544c199e8de245e7fa408` (members: Proposed/Accepted/Deferred/Rejected/Ingested)
- Props: Discoverer `2a9abcaa7fae4f29a6d0124ed5bd1018` · Gap types `90432d30096b4c9c920b96e22622cdeb` · Gap status `6dc322401db14c8e9bb54d1ef239912b` · Gap finding subject `ce1623ae023748faa8e63a3caab68608` · Suggested type `b9297d240dd84010a87e332b9bab062b` · Recommended action `275dbe3feae64036b9bdbe356ed1a1d1`

## `Gap finding`
Reuse canonical properties by ID (do not recreate):
| Property | ID | Data type |
|---|---|---|
| Name | `5b064102b0f14e529dad989a7696309e` | TEXT |
| Description | `9b1f76ff9711404c861e59dc3fa7d037` | TEXT |
| Publish date | `94e43fe8faf241009eb887ab4f999723` | TIME |
| Sources | `49c5d5e1679a4dbdbfd33f618f227c94` | RELATION → Source (`706779bf537744a68694ea06cf87a3a2`) |
| Related people | `5df8e4329cc54f038f854ac82e157ada` | RELATION |
| Related projects | `6e3503fab974460ea3dbab8af9a41427` | RELATION |
| Related entities | `dfa6aebe1ca94bf29faccc4cc7afb24c` | RELATION |
| Topics | `806d52bc27e94c9193c057978b093351` | RELATION |
| Tags | `257090341ba5406f94e4d4af90042fba` | RELATION |

New properties to create:
| Property | Data type | To type | Notes |
|---|---|---|---|
| Discoverer | RELATION | Person | who/what surfaced it |
| **Gap types** | RELATION (multi) | Gap type | plural — multi-value (Topics→Topic pattern) |
| Gap status | RELATION (single) | Gap status | singular — one current status |
| Gap finding subject | RELATION (open) | any | the candidate; empty if to-create |
| Suggested type | RELATION | Type | when candidate is novel |
| Recommended action | TEXT | — | per-gap remedy; flag enrich-vs-create |

## Enums
- **Gap type** (type) → members: Coverage · Depth · Freshness · Structural · Trending
- **Gap status** (type) → members: Proposed · Accepted · Deferred · Rejected · Ingested

## Stage-6 rules
- A "coverage" gap that is a sub-thing of an existing entity → `Recommended action` = enrich the parent, NOT a new entity.
- Structural gaps → `Recommended action` = merge/retype, listing the duplicate IDs.
- Every factual value cites a `Sources` relation. Relations over free text throughout.
