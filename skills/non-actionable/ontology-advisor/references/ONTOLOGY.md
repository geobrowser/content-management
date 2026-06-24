# Geo Ontology — Principles, Rules, and Guide

## About this document

This is a reference for understanding how knowledge is structured in Geo's knowledge graph. It is written for an LLM that needs to reason about, query, or contribute to the graph — not as an exhaustive catalog of every type and property that exists.

It covers:
- the core data model (entities, types, properties, relations)
- the principles that govern how knowledge should be structured
- the design strategies behind the type system
- concrete do/don't rules and common modeling patterns
- a reference for canonical core types and how the domain extensions relate to them

When the document refers to "the current state" of the graph, it reflects what is actually published, which is not always identical to what the principles aspire to. Where the gap matters, it is noted.

---

## Glossary

| Term | Definition |
|---|---|
| **Entity** | A uniquely-identified node in the graph representing a real-world thing, concept, or abstraction. Every entity has a UUID. |
| **Type** | A categorization of an entity (e.g. `Person`, `Country`, `Claim`). Defines a suggested schema of properties. An entity can have one or more types. |
| **Property** | A named attribute of an entity. Has a data type (immutable) and optionally a renderable type (mutable). Properties are themselves entities. |
| **Non-relation property** | A property whose value is a literal: text, number, date, boolean, point. |
| **Relation property** | A property whose value links to another entity. Creates an intermediary relation entity. |
| **Relation** | A typed, directed link between two entities. Always backed by an intermediary relation entity. |
| **Relation entity** | The intermediary entity created when a relation is made. Can carry its own properties that describe the relationship rather than either endpoint. |
| **Data type** | How a value is stored: `TEXT`, `NUMBER`, `TIME`, `POINT`, `BOOLEAN`, `RELATION`. Immutable once a property is published. |
| **Renderable type** | How a value is displayed: `URI`, `Geo location`, `Image`, `Video`, `Place`, `Address`, etc. Mutable. |
| **Schema** | The set of properties suggested (not enforced) by a type. Inherited automatically by entities of that type. |
| **Space** | A collaborative environment in which entities are published. An entity with one ID can appear in multiple spaces, each with its own perspective on it. |
| **Source space** | The space an entity originates from. Unchanged data in a derivative space falls back to the source space's values. |
| **Hypergraph edge** | When two relations share the same relation entity, letting both endpoints attach context to the relationship. |

---

## The data model

### Entities

- Every entity has a unique UUID.
- Entities represent real-world objects, people, organizations, ideas, places, events, or any other identifiable thing.
- Entities are composable: blocks of content, properties, and related entities are themselves entities linked together.
- Entities must have **at least one type**. They may have more than one — this is intentional and is how an entity inherits properties from multiple categorizations.
- The same entity (same ID) can exist in multiple spaces with different perspectives. Each space stores its own modifications; unchanged data is inherited from the entity's source space.

### Types

- A type is itself an entity (with `Types: Type`).
- A type defines a **suggested** schema of properties that any entity assigned that type will inherit.
- By default every type provides `Name`, `Cover`, and `Description`.
- A type's schema is editable: adding properties to a type propagates them to all entities of that type.
- Schemas are **suggested, not enforced**. The system does not reject entities that omit suggested properties or that carry properties not on the schema. This flexibility is deliberate.
- Types can have a `Properties` relation (which properties belong to the type) and a `Property groups` relation (for grouping related properties into sub-sections on the type entity).
- A relation property can have `Is type property` set to `true`. When true, an entity that uses that relation property inherits the schema of the entity it points to. Example: a `Person` with a `Roles` relation pointing to a `Pilot` entity inherits whatever default properties `Pilot` defines.

### Properties

There are two property categories:

**Non-relation properties** carry a literal value. Each property–value pair is attached directly to the entity. Data types: `TEXT`, `NUMBER`, `TIME`, `POINT`, `BOOLEAN`.

**Relation properties** link to another entity. When the link is created, an intermediary **relation entity** is also created. The relation entity is a full entity in its own right — it has its own ID and can carry properties that describe the relationship itself rather than either endpoint.

Each property has:
- A **data type** (how stored — immutable once published)
- An optional **renderable type** (how displayed — mutable; can be changed or removed)

Renderable types map onto data types:
- `TEXT` → `URI`
- `POINT` → `Geo location`
- `RELATION` → `Entity Card` (default when no specific renderable is set), `Image`, `Video`, `Place`, `Address`

`NUMBER`, `BOOLEAN`, and `TIME` have no renderable type options — they are always displayed in their default format (with optional `Format` and `Unit` for `NUMBER`, and optional `Format` for `TIME`).

Selecting a renderable type in the UI (e.g. choosing "Image") creates a property with the underlying data type (`RELATION`) and the renderable type (`Image`). The data type cannot be changed later; the renderable type can.

**Additional property specifications:**

For relation properties:
- `To entity types` — which type(s) the property should point to (e.g. `Spouse` → `Person`)
- `Relation entity types` — which type(s) the relation entity should be (e.g. `Spouse` relation entity → `Marriage`)
- `Reverse relation types` — the property on the other entity that creates the reciprocal link, establishing a bidirectional relationship that shares the same relation entity (e.g., `Spouse` on Person A ↔ `Spouse` on Person B both share a single `Marriage` relation entity).
- `Is type property` — whether the relation grants schema inheritance from the entity it points to

For `TIME` properties: an optional display `Format` (e.g. `MMMM d, yyyy`).

For `NUMBER` properties: an optional display `Format` and `Unit`.

### Relations

- A relation is created by attaching a relation property to a source entity and pointing it at a target entity.
- The intermediary relation entity is what makes relations expressive: any context that belongs to the relationship — start/end dates, role, terms, wedding venue, audit findings — lives on the relation entity, not on either endpoint.
- Two relations can share the same relation entity, forming a **hypergraph edge**. Example: `James → Spouse → Kamila` and `Kamila → Spouse → James` share a single `Marriage` relation entity that holds the wedding date, venue, vows, and guest list.

### Property groups

A `Property group` is a primitive for nesting properties under a sub-heading on a type. Use it when a type has many properties that naturally cluster (e.g. financial properties, technical specs, contact info). The group is itself an entity with a `Properties` relation and a `Collapsed` flag.

### Per-space values and canonical ownership

Every value record carries a `spaceId` — the space whose perspective wrote that value. Because the same entity ID can be attached to multiple spaces (Principle 10: Pluralism), the same property on the same entity can have **different values in different spaces**, and one space may have a value while another has none.

This produces a non-obvious failure mode that agents and curators must handle explicitly:

- The plain `entity.description` field returned by the GraphQL API **aggregates whatever value exists**, with no indication of which space set it.
- If the canonical space (geo-root for canonical types) hasn't set a value, but a niche space has, the API will surface the niche-space value as if it were the entity's description. Anyone reading the API without per-space awareness mistakes a domain-specific override for the canonical definition.

**Worked example.** The canonical `Person` type entity (id `7ed45f2bc48b419e8e4664d5ff680b0d`) is attached to 4 spaces — geo-root, Industries, Baseball, Men's work. Only Baseball has written a `Description` value: *"A person in baseball history — player, manager, coach, umpire, or official scorer."* Geo-root, Industries, and Men's work have no `Description` value at all. The GraphQL API returns Baseball's value as the entity's description for every caller — and that's wrong: the canonical (geo-root) anchor is empty.

**Rules.**

- **Canonical types MUST have a non-empty `Description` value set in the canonical space.** An empty canonical description means agents and curators have nothing authoritative to anchor on, and any domain-space override silently becomes the de-facto canonical description. This is the failure mode above.
- **Domain spaces SHOULD NOT write canonical-property values that redefine canonical semantics.** If a domain space needs domain-specific guidance for how it uses a canonical type, capture it on a domain-specific child type, on a relation entity, or in block content — don't override the canonical Description/Name/etc.
- **Agents fetching descriptions for advisory or import work MUST prefer the canonical-space value.** If only domain-space overrides exist, advisory output MUST flag this as a graph-quality issue ("no canonical description; only domain-space overrides exist") rather than treating any one override as authoritative.

This rule applies to any canonical property, not just `Description` — `Name`, `Avatar`, and `Cover` carry the same risk on canonical types.

---

## The content layer

Every entity page in Geo has two layers:

1. **Block content** — sits at the top of the page, below the entity name and description. It provides narrative context, rich media, and dynamic views. Block content is what makes an entity readable and informative, but it is not graph data in the same way properties are.
2. **Properties** — sit in the properties container below all block content. They hold structured, typed data (dates, relations, URLs, numbers) and are what make entities queryable, connected, and machine-readable.

### Block types

- **Text:** free-form narrative content supporting Markdown.
- **Image:** standalone images for visual context.
- **Video:** embedded video content.
- **Code:** formatted code snippets.
- **Data:** dynamic views over knowledge graph data (see below).

### Data blocks

Data blocks surface entities, relations, and queries directly from the graph and stay up to date automatically. There are three kinds:

- **Collection blocks:** a manually curated list of entities — you control the contents explicitly.
- **Relation blocks:** automatically display all relations of a specific type from the current entity — updates as relations change.
- **Query blocks:** live queries that return all entities matching defined criteria (e.g., all `Person` entities in a given space) — fully dynamic.

### Tabs

Block content is organized under the **Overview** tab by default. Additional tabs can be added to break content into structured sections (e.g., News, Research, Timeline). Each tab is backed by a dedicated entity of type `Page`, added via a `Tabs` relation on the parent entity. Tabs are reorderable.

### When to use block content vs. properties

- Use **properties** for structured, typed data that belongs in the graph and should be queryable (dates, links, relations, numbers).
- Use **block content** for narrative context, rich media, and dynamic views that enhance understanding but are not themselves graph data.
- A well-structured entity has both: rich properties that connect it to the graph, and block content that makes it readable and informative.

---

## Ontology principles

These are the rules that govern how knowledge should be structured. They apply across every type and property.

### 1. Broad over narrow

Default to the most general type that accurately fits. Introduce specificity only when it unlocks properties or behaviors that the broader type cannot support.

A smaller set of well-chosen types is more powerful than a sprawl of narrow ones. Narrow types fragment the graph, create maintenance overhead, and force contributors to make distinctions that don't matter for the knowledge itself.

Resolution heuristic: When choosing between a broad type and a narrower one, check whether the narrower type defines its own schema with properties that the broader type does not carry. If the narrower type adds ≥2 meaningful properties (e.g., `Token` adds `Contract address`, `Total supply`, `Standard` — none of which belong on `Project`), use the narrower type. If it adds no unique properties, the broader type is sufficient.

### 2. Flexible schemas, not rigid ones

Types define **suggested** properties, not enforced ones. An entity can carry properties that aren't on its type's schema, and can omit properties that are. The system will not reject off-schema data.

The tradeoff: flexibility produces inconsistency without editorial coordination. Guidelines, governance, and active editors are what keep a flexible system coherent.

Clarification: Flexibility applies to which properties an entity carries, not to how they are named. An entity may omit schema properties or carry off-schema ones, but property names must still follow the naming conventions in Principle 8. Flexibility without naming discipline produces inconsistency that degrades graph quality.

### 3. Relations over plain text

If a value represents a real-world thing — a person, place, organization, concept — it should be an entity linked via a relation, not a string.

A graph that stores names as text is just a database. A graph that links them to entities is something you can traverse.

If a direct relation exists in the real world between two entities, a direct relation should exist in the graph.

### 4. Properties can live on the relation, not just on the type

Context that only makes sense in the context of a specific relationship belongs on the relation entity, not on the endpoint's type.

Examples:
- Tenure dates of a professorship → on the `Employment` relation entity, not on `Person` or `Project`
- Wedding venue and date → on the `Marriage` relation entity, not on either `Person`
- Audit findings for a protocol audit → on the `Audit` relation entity, not on the protocol

This keeps types lean and prevents schemas from accumulating context that only applies in specific situations.

### 5. No duplication

One entity per real-world thing. If something already exists in the graph, link to it — don't create a new version. Duplicates break traversal, dilute signals, and create maintenance debt.

When duplicates are discovered, they should be merged into a single canonical entity. This applies to types as well as to entity instances.

### 6. Traceability is non-negotiable

Every claim, property, or relation that carries specific factual information must be traceable to a source. A graph without provenance is just a collection of assertions.

In practice this is implemented through `Sources` relations and the `Source` relation entity type, which links a factual entity to the article, paper, book, post, etc. that supports it.

### 7. Quality over volume

A smaller graph with high-signal entities is more useful than a large graph full of noise. Low-signal entities don't just fail to add value — they actively bury the high-signal ones. Every entity published makes the graph slightly harder to navigate. Pay that cost only when the entity is genuinely useful.

### 8. Consistency through shared properties

The same property name should be used across every type where the same kind of information applies. Topics, Tags, Related people, Related projects, Web URL, Publish date, and Avatar are reused across many types deliberately.

Reinventing names for the same concept on different types is a form of fragmentation.

### 9. Clarity and self-containment

Each piece of information should, as much as possible, stand on its own with enough context to be understood independently. Minimize reliance on external references for basic interpretability.

This applies especially to claims (which must be self-contained, avoid pronouns, and not require other claims to be intelligible) and to entity names and descriptions.

### 10. Pluralism

Different people and communities should be able to group, rank, and organize the same set of entities according to their own understanding and values. The ontology should support multiple coexisting perspectives rather than impose a single canonical interpretation.

Multi-space entities and source spaces are the mechanism that makes this possible: the same entity ID can be present in many spaces, each with its own perspective and overlay.

### 11. Universal organization of data

Any list of entities, in any form, should be splittable into meaningful groups and rankable. The ontology should be optimized along three axes simultaneously:
- **Real-world accuracy** — the model should reflect how things actually are
- **Computation and queryability** — structures should support efficient traversal and filtering
- **Average-user comprehension** — names and shapes should be understandable to non-experts

### 12. Open contribution

No one should be able to stop a person from making a claim or a relation, even if it is untrue. The ontology supports modeling disagreement, opposing arguments, and competing claims rather than gatekeeping at the structural layer. Truth is a matter for sources, evidence, and counter-claims — not for the type system.

### 13. Metadata vs. data blocks

- **Metadata** (properties and relations) exists to establish facts and connections. It is not intended to express sort order or prioritization.
- **Data blocks** are the mechanism for organizing, sorting, ordering, and presenting entities and their relations. When a list needs to be ordered or grouped for display, that ordering belongs in a data block, not in metadata.

### Principle priority

When two principles conflict, use this priority order to resolve:

1. **No duplication** (Principle 5) — always wins. Never create a duplicate entity or type.
2. **Relations over plain text** (Principle 3) — if a value is a real-world thing, it must be a relation, even if this means creating a new entity.
3. **Traceability** (Principle 6) — every factual claim must cite a source.
4. **Broad over narrow** (Principle 1) — use the broadest fitting type unless a narrower type adds meaningful schema properties.
5. **Quality over volume** (Principle 7) — better to publish fewer high-signal entities than many low-signal ones.
6. **Consistency through shared properties** (Principle 8) — reuse existing property names across types.

Principles lower on the list yield to those higher on the list when they conflict.

---

## Governance and proposals

Changes to the knowledge graph are made through **proposals**. A proposal is a suggested addition or edit that does not immediately affect published content. Members of a space vote on proposals to approve or reject them.

This mechanism ensures:
- **Quality control** — changes are reviewed before they go live.
- **Transparency** — all proposed changes are visible and auditable.
- **Accountability** — contributors and editors share responsibility for what gets published.

In practice:
- Contributors create entities, properties, and relations as proposals.
- Editors and space members review and vote.
- Approved proposals are published to the graph.
- Rejected proposals do not affect the graph.

When an LLM generates content for Geo, the output is always a proposal — it does not directly modify the published graph. Human review is the final gate.

---

## Design strategies

These are the architectural decisions that shape how the ontology is built.

### Broad universal types with optional specific extensions

The ontology is universal-first. A small set of broad types covers most cases:
- `Person` for any individual
- `Project` for any company, organization, protocol, product, or initiative
- `Topic` for any subject of interest
- `Source` (relation entity) for any cited reference
- `Claim`, `Quote`, `News story` for factual assertions and reporting

More specific types (`Company`, `Nonprofit`, `Protocol`, `Token`, `DAO`, etc.) extend these for domains that need them, but the broad types remain the fallback. If you don't know the exact subtype yet, the broad type is correct.

### Multi-typing instead of subclass trees

An entity can have multiple types. Rather than building deep inheritance hierarchies, the ontology lets an entity accumulate types to reflect its different facets. Albert Einstein could be `Person` + `Public figure`; a hospital could be `Organization` + `Hospital` + `Project`.

### Topics are hierarchical; tags are not

Topics provide semantic categorization with `Broader topics` and `Subtopics`, building a real conceptual hierarchy. Topics are foundational — they map the concepts that organize the graph.

Tags are low-commitment labels for quick groupings and custom filtered tables. They are intended as a stepping stone toward more semantically rich organization, not as a long-term taxonomy.

Use topics when the concept matters conceptually. Use tags for convenience and personal organization.

### Claims, quotes, and posts as first-class units of assertion

Knowledge assertions are publishable entities, not just metadata.

- A **claim** is a self-contained assertion. It has no author — its purpose is to represent the existence of an assertion that may be made by many sources in many wordings.
- A **quote** is a verbatim excerpt with an author and a source. Quotes can support or be linked to claims.
- A **post**, **article**, **book**, **paper**, etc. are content types that can act as sources for claims and quotes.

Claims can have supporting and opposing arguments (which are other claims), supporting quotes, and linked sources. This makes agreement, disagreement, and evidence structural features of the graph rather than free-form prose.

### Source traceability via relation entities

A source citation is itself a relation entity. When a `Claim` cites an `Article`, the link is a `Sources` relation whose relation entity is of type `Source`. The `Source` relation entity carries `Web URL`, `Web archive URL`, and `Source database identifier`. The underlying Article (or Book, Post, Paper, etc.) is a separate top-level entity with its own properties.

This separation — citation-as-relation-entity, content-as-its-own-type — keeps "what is the reference" distinct from "what does the reference link to."

### Property nesting on relation entities

When a group of properties only makes sense in the context of a relationship, model the relationship with a typed relation entity and put those properties on it. This is the preferred pattern going forward.

Compare:
- **Type-based:** Person accumulates types like `Professor`, `Author`, `Investor`, each unlocking properties like `Universities taught at`. The entity collects many types.
- **Relation-based:** Person has a `Roles` relation pointing to a `Professor` entity. The relation entity holds `Universities taught at`, `Tenure period`, etc. The entity stays typed as `Person`; role-specific data lives on the relation.

The relation-based pattern is the direction of travel and is already in use for `Employment`, `Education`, `Works at`, `Audit`, and most crypto/AI/health relations. Older parts of the graph still use the type-based pattern.

### Universal cross-cutting properties

A consistent set of properties appears across most types:

| Property | Meaning |
|---|---|
| `Name` | The canonical name (default on all types) |
| `Description` | A short explanation (default on all types) |
| `Cover` | A header image (default on all types) |
| `Avatar` | A representative image |
| `Tags` | Low-commitment labels |
| `Topics` | Hierarchical conceptual categorization |
| `Related entities` | Catch-all for meaningful connections that don't fit a dedicated relation |
| `Related people` | Connected people |
| `Related projects` | Connected projects/organizations |
| `Related spaces` | Spaces where this entity is relevant |
| `Web URL` | Canonical external URL |
| `Publish date` | When something was published |
| `Sources` | Citations |

Use these names. Do not invent synonyms.

When to use `Related entities`: Use it only when the connection is semantically loose or exploratory — the two entities are contextually relevant but the nature of their relationship cannot be named. If you can name the relationship (employs, funds, audits, studies, regulates), use or create a dedicated relation property instead. Dumping nameable relationships into `Related entities` undermines the graph's traversability.

---

## Do / Don't rules

### Type assignment

- **Do** check that the type already exists before creating a new one. The vast majority of needed types already exist somewhere in the graph.
- **Do** assign the broadest type that accurately describes the entity, then add narrower types only if they unlock useful properties.
- **Do** assign multiple types when an entity meaningfully is multiple things.
- **Don't** create `Human`, `Individual`, `Persona`, or any other synonym for `Person`. The same applies to any other existing type.
- **Don't** create a new type just because the existing one doesn't have a property you want — add the property to the existing type if it belongs there, or put it on a relation entity.

### Property modeling

- **Do** use a relation if the value is a real-world thing that could be its own entity.
- **Do** put contextual properties (dates, roles, terms) on the relation entity, not on either endpoint.
- **Do** reuse property names across types when they mean the same thing (`Topics`, `Tags`, `Related people`, etc.).
- **Do** use plural names for relation properties that can hold multiple values (`Topics`, `Authors`, `Roles`).
- **Don't** store a name, place, or organization as plain text if an entity for it exists or could exist.
- **Don't** invent new names for properties that already exist under a standard name.
- **Don't** put every possible property at the top level of a type when grouping or relation-entity nesting would be cleaner.

### Citations and provenance

- **Do** link every factual claim, property, or relation that carries specific information to a `Source`.
- **Do** use the `Source` relation entity to record citation metadata (`Web URL`, `Web archive URL`, etc.).
- **Do** model the underlying article/book/post/paper as its own top-level entity, separate from the citation.
- **Don't** treat `Source` as if it were a content type. It is the relation entity that links a fact to its reference.

### Claims and quotes

- **Do** write claims as self-contained statements that stand on their own without external context.
- **Do** avoid pronouns in claims; name entities explicitly.
- **Do** keep tone neutral and professional; one or two sentences.
- **Do** support a claim with verbatim quotes via `Quotes that support claims`, and with other claims via `Supporting arguments`.
- **Do** model disagreement by creating a separate opposing claim and linking it via `Opposing arguments`.
- **Don't** attribute a claim to an author — claims are unowned. Authors belong on quotes, posts, and articles.
- **Don't** model opposing quotes as a property on the original claim. Instead, attach them as supporting quotes on the opposing claim.

### Topics and tags

- **Do** use topics for semantic categorization that should compose into a hierarchy.
- **Do** use `Broader topics` and `Subtopics` to build the hierarchy.
- **Do** use tags for quick, low-commitment groupings.
- **Don't** use a tag where a topic is more appropriate, or vice versa.

### Duplicates

- **Do** search for an existing entity before creating a new one with the same name.
- **Do** merge duplicates into a single canonical entity when discovered.
- **Don't** create a new entity for a real-world thing that is already in the graph.

---

## Content standards summary

These rules govern how content is written and presented on entity pages. They complement the ontology principles, which govern how knowledge is structured.

### Entity naming

- Use **sentence case**: capitalize only the first word and proper nouns (e.g., `Developer tools`, not `Developer Tools`).
- Use **singular forms** for types (e.g., `Person`, not `People`).
- Do not add parenthetical context or abbreviations to entity names (e.g., avoid `Ethereum (blockchain)` or `Federal Bureau of Investigation (FBI)`). Abbreviations belong in a dedicated property field; type context belongs in the Type and Description fields.
- For people: full name only, no honorifics or titles (no Dr., Mr., President). Titles belong in the `Roles` property.
- For projects and companies: use the official full name as it appears in the project's own materials.

### Descriptions

- One or two sentences, targeting ~50 words.
- Cover: what the entity is and why it is significant.
- Neutral tone — no promotional, negative, or opinionated language.
- Do not start with the entity name, a restatement of it, or an article (`The…`, `A…`, `An…`).
- Write in third person.
- Do not repeat information already captured in properties (e.g., founding date).

### Images

- **Avatar**: square, minimum 400×400 px. Source from X (formerly Twitter), LinkedIn, or official websites. Required for people and project entities.
- **Cover**: ideal dimensions 2364×640 px. Center the subject or logo. Use only licensed or public domain images.
- Do not leave both image fields blank on entities that have Avatar/Cover properties.

### Quality evaluation metrics

Submissions are evaluated against four criteria:
1. **Accuracy & factuality** — all data is verifiably correct.
2. **Structure & ontology** — correct types, relational properties used instead of free text, consistent naming and formatting.
3. **Relevance** — the right entities for the domain, nothing obviously missing or out of place.
4. **Completeness** — volume and coverage match what was asked for.

---

## Common modeling patterns

### Citation pattern

```
Claim → Sources → [relation entity: Source]
                  ├── Web URL
                  └── Web archive URL
                  ↓
                  Article (or Book, Post, Paper, Tweet, Transcript, …)
                  ├── Authors
                  ├── Publish date
                  ├── Publisher
                  └── …
```

The Source relation entity is the citation glue. The Article is a separate entity with its full content metadata.

### Role / employment pattern

```
Person → Employment → [relation entity: Employment]
                      ├── Roles
                      ├── Start date
                      ├── End date
                      ├── Employment status
                      ├── Skills
                      └── Contributions
                      ↓
                      Company (or Organization, Project)
```

Per-stint context lives on the `Employment` relation entity. The `Person` and the `Company` don't accumulate stint-specific fields.

### Claim / quote / source pattern

```
Claim (self-contained assertion)
├── Quotes that support claims → Quote → Sources → [Source relation entity] → Article
├── Supporting arguments → Claim → …
├── Opposing arguments → Claim → …
├── Sources → [Source relation entity] → Article / Book / Paper / …
├── Related topics
├── Related people
└── Related projects
```

### Hierarchical concept pattern

```
Topic (e.g. "Machine Learning")
├── Broader topics → Topic (e.g. "Artificial Intelligence")
├── Subtopics → Topic (e.g. "Deep Learning", "Reinforcement Learning")
├── Related entities
└── Tags
```

### Hypergraph edge pattern

When the same context applies to two reciprocal relations, share a single relation entity:

```
James → Spouse → Kamila ──┐
                          ├──> [shared relation entity: Marriage]
Kamila → Spouse → James ──┘    ├── Wedding date
                               ├── Venue
                               ├── Vows
                               └── Guests
```

### Property group pattern

When a type has many properties that naturally cluster, group them with a `Property group` entity to organize the schema visually without affecting the underlying data model.

### Geography pattern

Use the `Location` relation property when the place is the primary fact (pointing to `Address`, `Place`, or `Region`). Use dedicated geography types (`Country`, `State`, `City`, `Continent`, `Region`, `Address`, `Place`) for entities whose primary identity is geographic. Geographic types form their own hierarchy: a `City` has `Country` and `State`; a `Country` has `Continent` and `States`; a `Continent` has `Countries`.

---

## Worked example: employment relation

This is a real example from the graph showing how a `Person → Employment → Company` relation looks with actual data.

**Person:** Yaniv Tal (`31cfe99fdf3549ef89094548f04858ff`)
**Company:** Hewlett-Packard (`269191a65d7640c5a818f0390cad7e85`)
**Relation property used:** `Employment` (type ID `a2fae35bac864a568b26e69643c68d9d`)
**Relation entity:** `7252ede74d7048f49e40d433b024da67`

### What the relation entity carries

| Property | Value | Data type |
|---|---|---|
| Description | "Designed and developed firmware for Enterprise LaserJet Printers. Specialized in board turn-on, UEFI development, and low-level systems programming." | TEXT |
| Start date | 2011-01-01 | TIME |
| End date | 2013-01-01 | TIME |

### Relations on the relation entity

| Relation property | Points to | Entity type |
|---|---|---|
| Roles | Firmware Engineer | Role |
| Employment status | Former | Employment status |

### What this demonstrates

- The `Person` entity (Yaniv Tal) does not carry tenure dates, role titles, or job descriptions directly. Those belong on the relation entity.
- The `Company` entity (Hewlett-Packard) is not modified either — the employment context exists only on the intermediary.
- `Roles` and `Employment status` are themselves relation properties pointing to typed entities (`Role`, `Employment status`), not plain text. This is Principle 3 (relations over plain text) in action.
- The relation entity has no name — it doesn't need one. Its identity comes from connecting Yaniv Tal to Hewlett-Packard via the `Employment` property.

---

## Canonical core types

This is a reference for the most commonly used types in the root space. Domain-specific types extend these but rarely replace them.

### Person

Represents an individual. Notable properties:

- `Name`, `Description`, `Avatar`, `X`
- `Roles` (relation) — what roles this person has held; the relation entity can carry role-specific context
- `Employment` (relation, multi-stint) — companies, organizations, or projects this person has worked at, with per-stint context on the relation entity
- `Education` (relation, multi-stint) — institutions, with per-stint context on the relation entity
- `Works at` / `Worked at` — current and past projects (legacy pattern; the `Employment` relation entity supersedes this where adopted)
- `Lives in`, `Key contributions`, `Skills`, `Tags`, `Topics`
- `Published`, `Gave talk`, `Appeared on`, `Tweeted` — content this person produced or appeared in

A `Person` entity may appear in multiple spaces. The same ID can be present in `geo-root`, `crypto`, `health`, etc., each with a description tailored to that space's context. The space breadcrumb in Geo Browser lets users switch perspective.

### Project (broad)

Represents any company, protocol, product, organization, initiative, publisher, political party, or other structured entity. The catch-all when something is an "org-like thing." Notable properties:

- `Name`, `Description`, `Avatar`, `Year founded`
- `Tags`, `Topics`
- `Team members`, `Teams` — people involved
- `Products offered`, `Provided services`
- `Funding rounds`
- `Website`, `LinkedIn`, `X`, `Wikipedia`
- `Related projects`, `Related spaces`

If you don't yet know whether something is a company, nonprofit, protocol, etc., assign `Project`. More specific types (`Company`, `Organization`, `Nonprofit`, `Protocol`, `DAO`, etc.) can be added later when the specificity matters.

A separate `Project` type also exists for project-management ("a scoped unit of planned work with milestones and tasks"); this is a known duplication and the broad `Project` is the canonical one for organization-like entities.

When you encounter the project-management `Project` type (used for scoped units of planned work with milestones and tasks), do not use it for companies, protocols, or organizations. If an entity is incorrectly typed with the project-management variant, flag it for human review recommending re-typing to the broad `Project`.

### Organization

A structured entity representing any organized group operating under a defined mission, legal structure, or authority. Used when something is clearly an organization rather than a product or protocol. Properties include `Team members`, `Teams`, `Year founded`, `Website`, `Wikipedia`, plus the standard cross-cutting properties.

### Company

A legally recognized commercial organization. Extends `Organization` with `Legal name`, `Products offered`, `Provided services`, `Funding rounds`.

### Source (relation entity type)

Used **only** as the relation entity for `Sources` relations. Not used as a content type. Properties:

- `Web URL`, `Web archive URL`
- `Source database identifier`
- `Properties sourced`

The actual referenced content (the article, book, post, paper) is a separate top-level entity.

### Article, Book, Post, Paper, Tweet, Transcript, Press release, Report (and similar)

Top-level content types that can be referenced by a `Source` relation entity. Each has its own properties: `Authors`, `Publish date`, `Publisher`, `Web URL`, `Related topics`, etc. These are peers, not subtypes of a parent "Source content" type.

### Claim

A self-contained assertion. Properties:

- `Name` — the assertion itself
- `Quotes that support claims` — verbatim quotes that back the claim
- `Supporting arguments`, `Opposing arguments` — other claims that reinforce or counter this one
- `Sources` — citation relation entities pointing to articles, papers, etc.
- `Location`
- `Related entities`, `Related people`, `Related projects`, `Related topics`
- `Tags`, `Topics`

Claims have no author. They represent the existence of an assertion, independent of who made it. Many real-world posts, articles, and quotes may all express the same underlying claim — the claim is the canonical meta-statement they all map to.

The `Related people` relation on a claim identifies people who are the subject of the claim — people the claim is about — not people who made the claim. Authorship belongs on quotes, posts, and articles, not on claims.

Claims must be self-contained, avoid pronouns, use neutral professional tone, and consist of one or two sentences.

### Quote

A verbatim excerpt from a text, speech, document, or other source. Properties:

- `Name` (or `Text`) — the exact quoted material
- `Authors` — who said or wrote the quote (Person or Project)
- `Sources` — where the quote came from
- `Related entities`, `Related people`, `Related projects`, `Related topics`
- `Tags`, `Topics`

Quotes preserve exact wording. They support claims by providing evidence in the speaker's own words.

### News story

Organizes coverage of a significant development. Properties:

- `Summary`, `Disclaimer`
- `Publish date`
- `Maintainers` — people or projects keeping the story updated
- `Perspectives` — multiple viewpoints on the story
- `Related stories`, `Associated timelines`
- `Sources`
- `Location`
- `Related entities`, `Related people`, `Related projects`, `Related spaces`
- `Tags`, `Topics`

A `News event` type also exists separately, used together with `Claim` to record discrete events ("a claim that something has happened") with a `Date` and `Location`.

When multiple news stories cover the same broader development, a `Topic` can be created to group them together.

### Topic

A concept used to group entities of the same category. Properties:

- `Name`
- `Broader topics`, `Subtopics`
- `Related entities`, `Related people`, `Related projects`, `Related spaces`
- `Tags`, `Topics`

Topics form the conceptual backbone of the graph. They categorize, they nest, and they connect across types.

### Tag

A lightweight label. Properties: just `Name`, plus optional `Tags` and `Topics` for further classification.

Tags are deliberately minimal. They exist for quick groupings and custom filtered views; they are not meant to carry semantic weight.

### Location-related types

- `Location` (property) — a relation pointing to `Address`, `Place`, or `Region`
- `Address` — with `Address line 1/2`, `City`, `State`, `Country`, `ZIP code`, `Geo location`
- `City` — with `Country`, `County`, `State`
- `State`, `Country`, `Continent`, `Region`, `Place`

Geographic types form their own hierarchy via parent/child relations.

### Meta types (model self-description)

- `Type` — the type of types
- `Property` — the type of properties; has `Data type` and `Renderable type`
- `Relation` — the meta-type for relation properties; has `Is type property`, `Related properties`, `Relation entity types`, `To entity types`
- `Data type`, `Renderable type` — the type system's primitives
- `Property group` — for nesting properties on a type
- `Space` — a collaborative space
- `Page`, `Block config`, `Data block`, `Data source`, `View`, `Selector` — UI/structure entities

---

## Domain extensions

The ontology is universal at the root and extended per-domain. Each domain space adds types specific to its subject matter while reusing root types and the universal cross-cutting properties (`Topics`, `Tags`, `Related people`, etc.).

| Domain | Approximate type count | Examples of domain-specific types |
|---|---|---|
| `crypto` | ~36 | `Token`, `Protocol`, `DAO`, `Wallet`, `Audit`, `Exploit`, `Network`, `NFT collection`, `Trading pair`, `Validator` |
| `ai` | ~25 | `Model`, `Model family`, `Benchmark`, `Dataset`, `Lab`, `Provider`, `Agent`, `Embedding`, `Training approach` |
| `health` | ~115 | `Disease`, `Drug`, `Procedure`, `Symptom`, `Protein`, `Gene`, `Lab test`, `Vaccine`, `Hospital`, `Supplement` |
| `world-affairs` | ~9 | `Treaty`, `Conflict event`, `Report`, `Press release`, `Authority model` |
| `technology` | ~6 | `Computing hardware`, `Data center`, `Hardware device`, `Hardware architecture` |

Domain extensions follow the same principles:
- They reuse root types (`Person`, `Project`, `Organization`, `Topic`, etc.) wherever applicable rather than redefining them.
- They favor relation entities for relationship context (e.g. crypto's `Audit` is a relation entity carrying audit findings, scope, and severity).
- They extend the universal property set with domain-specific properties rather than renaming standard ones.

When working in a domain, prefer existing domain types over creating new ones, and prefer root types over creating new domain types when the root type fits.

---

## Building an ontology for a new space

The workflow for designing a space's ontology, generalized:

1. **Define scope and purpose.** What domain does this space cover? What knowledge needs to be captured? What constraints apply (audience, depth, completeness)?

2. **Identify core entity types.** List the major kinds of things the domain contains. Map each to an existing type first; only propose a new type when no existing type fits.

3. **Define properties for each type.** For each type, decide on:
   - Identifying information (`Name`, `Description`)
   - Domain-specific attributes
   - Connections to other entities (relations)
   - Optional enrichment properties (avatars, URLs, social links)

4. **Establish relations between entities.** Decide which entities link to which others, and which relations need relation entities to carry context.

5. **Map properties to data types and renderable types.** Pick the right data type for each property; add a renderable type only when display matters (e.g. `Image`, `Geo location`).

6. **Document the ontology.** Record the types, their properties, relations, and intended use, so other contributors can apply the same model consistently.

7. **Validate against real data.** Test the ontology against actual examples. Check that all necessary attributes and relationships are covered, and that names and structures are consistent with the rest of the graph.

8. **Apply and iterate.** Start publishing entities under the new ontology. Use proposals to suggest additions or edits. Refine as new patterns emerge.

Key habits to maintain quality:
- Standardize names, types, and formats.
- Use relationships effectively — the graph's value comes from its connections.
- Keep the ontology extensible — design for new entities and properties to be added over time.
- Document examples and context so future contributors understand the intent.
- Test the ontology against the queries, views, and workflows it needs to support.

---

## Summary heuristics

A compressed checklist for reasoning about a modeling decision:

- Is this entity already in the graph? → Link to it; don't create a duplicate.
- Is the value a real-world thing? → Make it a relation.
- Is this context specific to a relationship? → Put it on the relation entity.
- Is the type I want already defined? → Use it; don't invent a synonym.
- Is this property name already used elsewhere for the same concept? → Reuse it.
- Is the broad type sufficient? → Use it; add specificity only when it unlocks value.
- Is this a factual claim? → Link it to a `Source`.
- Is this a verbatim excerpt? → It's a `Quote` with `Authors` and `Sources`.
- Is this an assertion with no specific author? → It's a `Claim`.
- Is this a concept that should compose into a hierarchy? → It's a `Topic`.
- Is this a low-commitment label? → It's a `Tag`.
- Is this a geographic place? → Use `Location` (relation) or a dedicated geography type.
- Does this entity belong in multiple spaces? → Reuse the ID; let each space have its own perspective.

---

## Error recovery

When encountering data quality issues in the graph, apply these rules:

### Duplicates

- If two entities represent the same real-world thing, flag for human review with a note identifying both entity IDs and recommending a merge into the entity with the richer data.
- Do not create a third entity to "fix" the duplication.

### Incorrect types

- If an entity has the wrong type (e.g., a company typed as `Person`), flag for human review with a note recommending the correct type.
- If an entity is missing a secondary type it should have (e.g., a protocol that is `Project` but should also be `Protocol`), the additional type can be proposed directly.

### Free text where a relation should exist

- If a property value stores a name as plain text when a corresponding entity exists in the graph, flag for human review recommending conversion to a relation.
- This is the single most common and impactful data quality issue.

### Missing properties

- If an entity of a known type is missing properties that its schema suggests, the missing properties can be added via proposal without special approval.

### General rule

When in doubt, **flag for human review** rather than making an irreversible change. Include:
- The entity ID
- What the issue is
- What the recommended fix is

An LLM should never silently "fix" data without surfacing what it changed and why.
