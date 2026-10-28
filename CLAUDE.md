# CLAUDE.md — geo-skills

**This repo is operated through skills, not by improvising. On EVERY request, first decide which skill applies, then invoke it.** Do not hand-write scripts to do a job a skill covers — the skills carry mandatory safeguards, and bypassing them is how duplicates and bad data reach Geo.

## Skill routing — check this before doing anything

| If the user wants to… | Use skill |
|---|---|
| **publish / create / update** entities, relations, or content; "add X to Geo"; "publish…"; submit a proposal | **geo-publish** |
| **look up / search / inspect / query** the graph; "what type is…"; "show relations"; review or fact-check a submission | **geo-query** |
| **delete** entities; find/merge **duplicates**, delete orphans, fix data types, move/copy entities, clean the graph | **geo-clean** |
| compare external press vs Geo — "what should we publish next" | **geo-press-review** |
| write **claim-grouping results** (exact / semantic duplicates, related, supporting / opposing) into a **Notion Claims mirror** as review columns instead of Geo proposals; "claim grouping to Notion" | **geo-claim-grouping-notion** |

If a request is ambiguous, ask which skill — don't guess and improvise.

## Agents live in `geo-agents`

The agents, the Agents flow workflow guide and the Notion tracker ids moved to [geo-explorers/geo-agents](https://github.com/geo-explorers/geo-agents). If the task involves **creating, editing or invoking an agent**, or any work in the **Agents flow** Notion teamspace, do it from a checkout of `geo-agents`, and read its `CLAUDE.md` and `workflow/AGENT-WORKFLOW.md` first. This repository holds only the skills, the shared code they call, and the tools that check them.

Two rules from that guide that are easy to get wrong:
- **Log the task BEFORE starting work**, in the Work tracker, with `Projects` set to **Agent flows** — every view filters on it, so a task without it is invisible to the team.
- **Problems go in the QA issue tracker**, with severity + urgency + evidence — never buried in a task note.

## Hard rules

1. **Never write to Geo by hand.** Every Geo write happens inside one of four gated skill flows, each with its own dry run and the editor's explicit approval: **geo-publish** (create / update), **geo-clean** (delete, merge, clean-up — rule 3), **geo-claim-grouping** (claim edges) or **geo-mirror Part 2** (reviewed edits from a mirrored Notion table). Outside those flows, never write or run a raw SDK/publish script yourself. geo-publish runs the mandatory safeguards (semantic-duplicate check, schema check, type-required check, dry-run → explicit confirm); a raw script skips all of them. geo-publish may remove values or relations as part of an update; deleting an entity, merging, or any bulk removal goes through geo-clean. geo-mirror Part 2 (`plan-notion-changes.mjs` → `sync-to-geo.mjs`) publishes changes an editor or agent made in a mirrored Notion table (any table with a `Geo ID` column), with its own approval, live-value checks and dry run; creating entities and changing relations still go through geo-publish.

2. **If the matching skill's `SKILL.md` is missing, STOP — do not improvise, and do not download a replacement yourself.** Tell the user, verbatim:
   > "The **geo-publish** skill isn't available. Run `bash skill-dev/sync-skills.sh` from this folder, restart the app (or start a new chat), then try again."
   A missing skill means no safeguards; publishing without a **genuine** skill is not allowed. Never fabricate skill content to fill the gap. Skills are updated only by a person, from a reviewed release — never by an agent in the middle of a task. See [`MAINTAINERS.md`](MAINTAINERS.md).

3. **Deletion is the highest-risk operation — treat it as a red line.** NEVER hand-write a delete, and NEVER write a loop that deletes many entities (an improvised script once mass-deleted an entire personal space). Any delete/merge/cleanup MUST go through **geo-clean**, which runs an orphan check + explicit human confirmation first. As a backstop, `publishOps` refuses any batch that removes data from more than ~50 relations/values unless `CONFIRM_DESTRUCTIVE=1` is set — **do not set that flag to route around the skill.** If a user asks to "clear/delete/reset my space", route to geo-clean; do not build it yourself.

4. **Secrets:** never read, print, or accept the user's private key — see the security contract in `README.md`. `.claude/settings.json` blocks reading `.env`, so a blocked `.env` check does not mean the key is missing: say the check was blocked and carry on. The publish itself is the real test.

## Changing, adding or releasing a skill

This applies when the task is to **edit the skills themselves**, not to use them. Read [`MAINTAINERS.md`](MAINTAINERS.md) first: "Changing a skill", "Adding a skill" and "Cutting a release". The short version:

- **Every change goes through a pull request.** `main` is protected: the required `verify` check must pass and a teammate must approve. Never push to `main`.
- **Updating a skill**, all in the same pull request:
  1. Lint it: `python3 skill-dev/skill-quality-check/scripts/check_skill.py skills/<tier>/<skill> --format table`.
  2. Bump `version` in its `SKILL.md`: patch for wording or a fix, minor for a new capability, major for a breaking change.
  3. Add a dated line for it in `skills/versions.md`: what changed and why.
  4. Update its version in `MD-FILES.md`, and add a row for any new Markdown file.
  5. Commit the change, then re-approve it: `python3 skill-dev/skill_versions.py generate`, then `python3 skill-dev/skill_versions.py verify` and `python3 skill-dev/check_md_manifest.py` must both pass. Commit `skills/SKILL-VERSIONS.json`.
- **Adding a skill** is the same, plus: put it in `skills/actionable/` if it can change Geo, otherwise in `skills/non-actionable/`; give `SKILL.md` frontmatter with `name`, a `description` full of trigger phrases, and `version: 0.1.0`; add a row to the index in `skills/README.md`; add a section for it in `skills/versions.md`; and add a row to the routing table above if editors should be sent to it by default. `verify` reports it as `UNLISTED` until the manifest is regenerated.
- **If `verify` reports `DRIFT` on a skill you did not mean to change, undo that change. Do not regenerate.** Regenerating approves whatever changed.
- **A skill built for one agent starts in that agent's folder** in `geo-agents` (`agents/<name>/`), not here. It moves into this library, as a new skill, once it is stable and evaluated.
- **A change reaches the agents only through a release.** A maintainer tags `main` (`vX.Y.Z`), and `geo-agents` takes that tag in its own pull request with `node tools/sync-skills.mjs --ref vX.Y.Z`. Never edit the copies under `geo-agents/.claude/skills/`. Never create, move or delete a release tag yourself.
