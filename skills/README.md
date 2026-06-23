# Geo Skills

Skills for working with the Geo knowledge graph from Claude Code / Codex / browser assistants. Each skill is a folder with a `SKILL.md`.

Skills are organized by **what they can do to Geo**, because that's the safety-critical distinction:

- **`non-actionable/`** — skills that only *read* Geo (and the web). They cannot create, update, delete, or publish anything. Safe for anyone, including non-technical curators.
- **`actionable/`** — skills that *change* Geo (publish, merge, delete). Only for trained editors. Every write goes through safeguards (dry-run, duplicate/existence check, explicit publish confirmation). Never give these to someone who hasn't been onboarded.

## Index

### non-actionable/ — read-only, can't break anything

| Skill | What it does | Runs in |
|---|---|---|
| **geo-query** | Find entities, inspect properties/relations, traverse the graph, discover schemas, and review/fact-check a submission page. Plain GraphQL over HTTP — runs anywhere, **including claude.ai in the browser** (no SDK/wallet/repo needed for queries). | Anywhere (GraphQL) |
| **ontology-advisor** | Advise on modelling — should this be a type/property/relation? duplicate/drift checks, missing descriptions, export types to CSV. Grounded in ONTOLOGY.md + the live graph. Suggests text, never writes. | Repo (Python + GraphQL) |
| **geo-press-review** | Compare external press (Google News/web) vs what's on Geo → ranked "publish next" list (already on Geo / needs update / not on Geo yet). Recommends only. | Repo (coverage script + web search) |
| **qa-report-workflow** | Triage a **UI/UX bug** an editor hit while using the app (real? / not an issue / known / fixed), rewrite it, and emit copy-paste Linear + Notion + Slack reports. Doesn't scan or touch Geo. | Anywhere (text in/out) |

### actionable/ — changes Geo, editors only

| Skill | What it does | Runs in |
|---|---|---|
| **geo-publish** | Create/update/delete entities and relations via the GRC-20 SDK. | Repo + wallet key |
| **geo-clean** | Find/merge duplicates, delete orphans, fix data types, fix stale relations, etc. Safeguards before any destructive op. | Repo + wallet key |
| **geo-orchestrate** | Editor entry point. Turns "I want to X" into a plan → generates a script → dry-run → confirm → publish. Routes to query + publish. | Repo + wallet key |
| **geo-discovery** | Run a gap-discovery pass over a space's daily stream → ranked coverage/depth/freshness/structural/trending gaps as Gap finding entities. Read-only until the human-reviewed publish stage. | Repo (Python; publish stage needs wallet key) |

`geo-publish` is portable — one skill for Claude Code, Codex (CLI + Desktop), and Claude cowork (any local-execution agent). Browser-only assistants can't publish.

## Which to give whom

- **Non-technical curator / domain expert** → `non-actionable/` only. They explore and review; they can't damage production.
- **Trained editor** → `non-actionable/` + `actionable/`, with the wallet key set up per the setup guide. Start them on dry-runs.
- **Browser-only user (no terminal)** → `geo-query` works with nothing installed (it's just GraphQL over HTTP). Writing still requires the repo.

## Adding a skill

One folder per skill, containing `SKILL.md` (+ any `bin/`, `examples/`, `reference.md`). Put it in `non-actionable/` or `actionable/` by whether it can change Geo. Frontmatter must have `name`, `description` (packed with trigger phrases), `metadata`. Then add a row to the index above.

> **Maintainers:** the skill-authoring standard and a linter to check a skill against it live in `../skill-dev/skill-quality-check/` (not shipped to editors). Run it before adding or editing a skill.

## Notes

- These skills assume the `content-management` repo is cloned locally **unless** the "Runs in" column says Browser. Cloning instructions live in the repo setup guide.
- `write/` skills need a wallet key. Never paste the key into chat — see each write skill's prerequisites for the `.env` handoff.
