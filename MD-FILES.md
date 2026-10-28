# MD file manifest — geo-skills

Every Markdown file in this repository: what it contains, who reads it, and when it is loaded. This is the repo-side answer to "provide a list of all MD files and their contents"; the Notion [Agent Composition](https://app.notion.com/p/3dc273e214eb814088b8de2e3184f988) catalog links to the same files and must not become a second copy of them.

**The repository is the canonical source.** Where a Notion row and a file disagree, the file wins. Never distribute a file by pasting it somewhere else; link to it, and re-sync installs with `bash skill-dev/sync-skills.sh`.

**Loading trigger** is how a file reaches an agent:
- **Automatic** — the host loads it without being asked (`CLAUDE.md` in Claude Code).
- **On routing** — the agent opens it because an entry point or skill points at it.
- **On demand** — read when the task calls for it.
- **Not distributed** — kept in the repo for maintainers; never part of an agent's instructions.

---

## 1. Entry points — read first

| File | Contents | Read by | Trigger |
|---|---|---|---|
| `CLAUDE.md` | Skill routing table, the four hard rules (no hand-written Geo writes, stop when a skill is missing, deletes only via geo-clean, never touch the private key), where the agents went, the short procedure for changing, adding and releasing a skill | Every agent | Automatic in Claude Code; other hosts reach it from `README.md` |
| `README.md` | Setup runbook: install, the security contract, where skills go per host, skills index, shared-code reference, project structure | Every agent and every human setting up | On routing — first file for a non-Claude agent |

## 2. Skills — `skills/`

Each skill is one `SKILL.md` with YAML frontmatter (`name`, `version`, `description`). The description decides when a skill is triggered. Versions below were current on **18 September 2026** (re-checked after the 18 Sep merge); `skills/versions.md` holds the changelog and `skills/SKILL-VERSIONS.json` the approved hashes.

| Skill | Version | Contents | Key needed |
|---|---|---|---|
| `skills/non-actionable/geo-query/SKILL.md` | 0.2.11 | Query the graph over GraphQL: lookups, type/space scoping, relations, schema discovery, performance rules, canonical space IDs | no |
| `skills/non-actionable/ontology-advisor/SKILL.md` | 0.1.0 | Modelling advice: reuse vs new type, property choices, relation vs value, duplicate and drift checks | no |
| `skills/non-actionable/geo-press-review/SKILL.md` | 0.5.3 | Compare press coverage with Geo and recommend what to publish next | no |
| `skills/non-actionable/geo-describe/SKILL.md` | 0.2.0 | Verified, original entity descriptions at scale, with copyright and accuracy gates | no |
| `skills/non-actionable/image-banner-recompose/SKILL.md` | 0.2.1 | Recompose any image into a 2364×640 Geo banner | no |
| `skills/non-actionable/daily-report/SKILL.md` | 0.1.0 | The editor's end-of-day Notion update routine | no |
| `skills/non-actionable/notion-operations/SKILL.md` | 1.0.1 | How to read and write Notion correctly from this toolkit: which identity to use, API limits and the traps | no |
| `skills/non-actionable/geo-claim-grouping-notion/SKILL.md` | 0.2.0 | Write claim-grouping results into a Notion Claims mirror as review columns instead of publishing to Geo | no |
| `skills/non-actionable/geo-mirror-and-group/SKILL.md` | 1.0.1 | Run the whole Geo → Notion → claim-grouping pipeline from one request | no |
| `skills/actionable/geo-publish/SKILL.md` | 0.12.1 | Create and update entities and relations (entity deletes go to geo-clean). Mandatory gates (ontology/type, duplicate, schema, relation-target, type-required) and the two-phase dry-run report → publish | **yes** |
| `skills/actionable/geo-clean/SKILL.md` | 0.5.1 | Merge duplicates, delete orphans, move entities, fix data types, with anchored-entity protection | **yes** |
| `skills/actionable/geo-mirror/SKILL.md` | 0.13.0 | Geo ⇄ Notion. Part 1 mirrors any entity type into Notion; Part 2 publishes changes back from any table with a `Geo ID` column | **yes** (Part 2) |
| `skills/actionable/geo-claim-grouping/SKILL.md` | 0.7.1 | Group claims: adjudicate Similar/Duplicate relations and publish the decisions | **yes** |
| `skills/actionable/geo-orchestrate/SKILL.md` | 0.2.1 | Turn natural-language intent into a query plan, publish plan and script | **yes** |
| `skills/actionable/geo-discovery/SKILL.md` | 0.1.1 | Gap-discovery passes over a space, published as Gap finding entities | **yes** |

### Skill reference files — loaded by their own skill only

| File | Contents |
|---|---|
| `skills/actionable/geo-claim-grouping/references/adjudication-rubric.md` | How to decide Similar vs Duplicate vs neither |
| `skills/actionable/geo-claim-grouping/references/ops-script-template.md` | Ops-script template and the decisions contract |
| `skills/actionable/geo-claim-grouping/references/queries-and-signals.md` | Verified query shapes, signals and scoring |
| `skills/actionable/geo-clean/reference.md` | Long-form geo-clean reference kept out of the main body |
| `skills/actionable/geo-clean/big-merge.md` | Manual procedure for a large merge |
| `skills/actionable/geo-discovery/references/discovery-schema.md` | Gap finding entity schema |
| `skills/actionable/geo-discovery/references/drafting-conventions.md` | Drafting conventions for gap findings |
| `skills/actionable/geo-discovery/references/ner_prompt.md` | Candidate-extraction prompt |
| `skills/actionable/geo-discovery/references/stage6-publish.md` | DAO publish mechanics and gotchas |
| `skills/non-actionable/geo-describe/references/description-rules.md` | The Geo description rules |
| `skills/non-actionable/geo-describe/references/accuracy-verification.md` | How facts are verified before writing |
| `skills/non-actionable/geo-describe/references/closeness-and-accuracy-checks.md` | Copyright-closeness and accuracy gates |
| `skills/non-actionable/geo-describe/references/copyright-and-licensing.md` | Copyright and licensing rules |
| `skills/non-actionable/image-banner-recompose/references/strategies.md` | Recomposition strategies |
| `skills/non-actionable/image-banner-recompose/references/qa_check.md` | QA pipeline for the output |
| `skills/non-actionable/image-banner-recompose/references/api_endpoints.md` | API endpoints used |
| `skills/non-actionable/notion-operations/references/api-versions-and-limits.md` | Notion API versions, rate limits and page-size caps |
| `skills/non-actionable/notion-operations/references/notion-traps.md` | Notion behaviours that bite: capped relation reads, case-insensitive options, linked views |
| `skills/non-actionable/notion-operations/references/toolkit-scripts.md` | The repo's Notion scripts and when to use each |
| `skills/non-actionable/geo-claim-grouping-notion/references/column-contract.md` | Which Notion columns the grouping results are written into |
| `skills/non-actionable/ontology-advisor/README.md` | How to run the ontology-advisor scripts |

## 3. Ontology and standards — the judgment layer

| File | Contents | Read by | Trigger |
|---|---|---|---|
| `skills/non-actionable/ontology-advisor/references/ONTOLOGY.md` | The full Geo ontology guide: principles, rules, types vs properties vs relations, worked judgments. The prior for every modelling decision | Content, data and quality agents | On demand, and by ontology-advisor |
| `knowledge-graph-ontology.md` | The ontology specification: entities, properties, relations, data types, spaces. Structural reference behind the SDK | Data and schema agents | On demand |
| `skill-dev/skill-quality-check/references/skill-quality-standard.md` | The skill authoring and validation standard the linter enforces | Anyone writing or reviewing a skill | On demand |

## 4. Maintainer documents — not agent instructions

| File | Contents |
|---|---|
| `skills/README.md` | What the skills folder is, the actionable/non-actionable split, how to add a skill |
| `skills/versions.md` | Per-skill changelog: what changed, why, and the evidence. Paired with `SKILL-VERSIONS.json` |
| `skill-dev/README.md` | Maintainer tooling: version manifest generator, quality linter, `sync-skills.sh` |
| `MAINTAINERS.md` | What belongs in this repository (the bucket list), how to change a skill, how to cut a release |
| `MD-FILES.md` | This manifest |
| `skill-dev/skill-quality-check/SKILL.md` | The linter itself, packaged as a skill |

---

## Keeping this current

- **CI enforces this file.** `python3 skill-dev/check_md_manifest.py` fails if a tracked `.md` is missing here, if a listed file no longer exists, or if a `SKILL.md` version differs from the one recorded above. It runs on every pull request as part of the required `verify` check, so run it before you push.
- **Adding an MD file:** add a row here in the same pass, and a row in the Notion catalog only if agents outside this repo need to find it.
- **Changing a skill:** bump `version` in its `SKILL.md`, add a line to `skills/versions.md`, regenerate `skills/SKILL-VERSIONS.json`, and update the version in section 3.
- **Before trusting an install:** compare the installed `SKILL.md` version with this file. A mismatch means the install is stale — run `bash skill-dev/sync-skills.sh` and restart the host. Two agents running different versions of the same skill will overwrite each other's work.

*Counts on 15 October 2026: **47** tracked `.md` files — 2 entry points, 15 skills, 21 skill reference files, 3 ontology/standard documents and 6 maintainer documents. Every tracked file appears in exactly one section above. The agents, their workflow guide and the research documents moved to `geo-agents` in migration step 6; the migration's working notes were removed when it finished.*
