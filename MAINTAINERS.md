# MAINTAINERS.md — geo-skills

For the people who maintain this repository. Editors and agents do not need this file.

This repository is a **skills library**. The agents moved to `geo-explorers/geo-agents` in migration step 6. This file records what belongs here and what does not. It also holds the procedures for changing a skill and for cutting a release.

## Bucket list — what belongs in this repository

**Inventory date:** 13 October 2026 · **commit:** `4aa5d75` · **tracked files:** 234.

Every tracked file sits in exactly one bucket. The rule for each bucket:

| Bucket | Rule | Files |
|---|---|---|
| **A · Skill** | Inside a skill folder, or one of the three skill index files. Stays. | 88 |
| **B · Shared code** | Outside a skill folder, and at least one skill calls it or points to it, or it maintains such a file. Stays for now. | 14 |
| **C · Library tooling** | Needed to build, check or install the library itself. Stays. | 21 |
| **D · Removed at cut-over** | Neither a skill nor called by one. Removed in migration step 6. | 49 |
| **E · Temporary** | Migration working notes. Removed when the migration finished, 15 October 2026. | 62 |

The migration plan names three buckets: skill, shared code, neither. Bucket C is added here because files such as `package.json` and `skill-dev/` are none of the three. Bucket E is separate from D because it leaves later.

### A · Skills — stay (88 files)

| Path | Files | Note |
|---|---|---|
| `skills/actionable/geo-claim-grouping/` | 6 | |
| `skills/actionable/geo-clean/` | 4 | |
| `skills/actionable/geo-discovery/` | 16 | |
| `skills/actionable/geo-mirror/` | 12 | |
| `skills/actionable/geo-orchestrate/` | 2 | |
| `skills/actionable/geo-publish/` | 2 | |
| `skills/non-actionable/daily-report/` | 3 | |
| `skills/non-actionable/geo-claim-grouping-notion/` | 7 | |
| `skills/non-actionable/geo-describe/` | 7 | |
| `skills/non-actionable/geo-mirror-and-group/` | 3 | |
| `skills/non-actionable/geo-press-review/` | 2 | |
| `skills/non-actionable/geo-query/` | 2 | |
| `skills/non-actionable/image-banner-recompose/` | 5 | |
| `skills/non-actionable/notion-operations/` | 5 | |
| `skills/non-actionable/ontology-advisor/` | 9 | |
| `skills/README.md` | 1 | Skills index |
| `skills/SKILL-VERSIONS.json` | 1 | Integrity manifest |
| `skills/versions.md` | 1 | Changelog |

Fifteen skills, 85 files, plus three index files.

### B · Shared code a skill calls — stays for now (14 files)

Each row names the skills that depend on the file. A file leaves this bucket only when no skill depends on it.

| Path | Used by |
|---|---|
| `src/functions.ts` | geo-publish, geo-clean, geo-claim-grouping, geo-claim-grouping-notion, geo-mirror, geo-orchestrate, geo-query |
| `src/constants.ts` | geo-clean, geo-claim-grouping, geo-orchestrate, geo-query |
| `src/entity_ops.ts` | geo-clean, geo-orchestrate |
| `src/select_canonical.ts` | geo-clean |
| `src/xlsx-to-csv.cjs` | geo-publish |
| `lib/gql.mjs` | geo-query, geo-claim-grouping-notion |
| `lib/gql-cli.mjs` | geo-query |
| `lib/inject.ts` | geo-publish (inject mode) |
| `validate_migration.ts` | geo-clean |
| `scripts/notion-read.mjs` | notion-operations |
| `scripts/press-review-coverage-map.ts` | geo-press-review |
| `scripts/inject-publish-example.ts` | geo-publish (named as the inject-mode example) |
| `scripts/check-space-list.ts` | No skill. Read-only check that the space list in `src/constants.ts` still matches Geo; kept as upkeep for that file |
| `knowledge-graph-ontology.md` | geo-publish, geo-query (reference document) |

None of these files imports anything from bucket D.

### C · Library tooling and repository files — stay (21 files)

| Path | Files | What it is |
|---|---|---|
| `skill-dev/` | 8 | Linter, integrity manifest tools, Markdown manifest check, local install script |
| `MD-FILES.md` | 1 | Manifest of this library's Markdown files. Moved out of `agents/` in step 6, when that folder was removed |
| `.github/workflows/verify-skills.yml` | 1 | Integrity check |
| `.github/workflows/discord-notify.yml` | 1 | Change feed to Discord |
| `.claude/settings.json` | 1 | Auto-approve allowlist |
| `CLAUDE.md` | 1 | Entry file: routing and hard rules |
| `README.md` | 1 | Setup runbook |
| `LICENSE` | 1 | |
| `package.json`, `package-lock.json`, `bun.lock`, `tsconfig.json` | 4 | Toolchain |
| `.gitignore`, `.env.example` | 2 | |

### D · Removed at cut-over, migration step 6 (49 files)

| Path | Files | Where it goes |
|---|---|---|
| `01_entity_operations.ts` … `11_fix_duplicate_subtopics.ts` | 13 | Deleted. Git history keeps them. Includes `02.3_export_no_type.ts` and `02.5_full_space_scan.ts` |
| `testing.ts` | 1 | Deleted |
| `todo.md` | 1 | Deleted |
| `scripts/2026-07-28-sdk-v020-migration-check.ts` | 1 | Deleted. A dated one-off check for the July SDK migration; no skill calls it |
| `output/` | 26 | Deleted. Output of one past clean-up run |
| `agents/geo-research.md` | 1 | Moves to `geo-agents/agents/geo-research/` in step 5 |
| `agents/geo-mirror-refresh.md` | 1 | Moves to `geo-agents/agents/geo-mirror-refresh/` in step 5 |
| `agents/AGENT-WORKFLOW.md` | 1 | Moves to `geo-agents/workflow/` in step 5; its ids go to `ids.json` |
| `agents/README.md` | 1 | Replaced by the `geo-agents` README |
| `documentation/` | 3 | Moves to `geo-agents/docs/` in step 5. All three files belong to geo-research |

No skill runs any of these files. One skill, geo-orchestrate, names `03_merge_duplicates.ts` in a sentence as a style example.

**Done in the same step 6 pull request.** `MD-FILES.md` moved to the repository root, and its path changed in `skill-dev/check_md_manifest.py` and `.github/workflows/verify-skills.yml`. `CLAUDE.md`, `README.md` and `skill-dev/README.md` now point to `geo-agents` instead of the removed folders, and the README no longer documents the numbered scripts.

### E · Temporary — removed when the migration finished (62 files)

| Path | Files |
|---|---|
| `audit/` | 46 |
| `audit-2/` | 16 |

Working notes from the 9 and 11 October audit sessions. They were the source of the migration plan and were removed on 15 October 2026, once the migration was finished. Git history keeps them.

## Changing a skill

Every change under `skills/` or `skill-dev/` goes through a pull request. Nothing is pushed straight to `main`.

1. **Branch from `main`** and make the change.
2. **Lint the skill** against the authoring standard:
   ```bash
   python3 skill-dev/skill-quality-check/scripts/check_skill.py skills/<tier>/<skill> --format table
   ```
3. **Bump `version`** in the skill's `SKILL.md` frontmatter. Patch for wording or a fix, minor for a new capability, major for a breaking change to how the skill is used.
4. **Add a dated bullet** for the skill in `skills/versions.md`: what changed and why.
5. **Update `MD-FILES.md`** if the version changed or a Markdown file was added or removed.
6. **Commit the change, then re-approve it.** Regenerate the integrity manifest and commit it in the same pull request:
   ```bash
   python3 skill-dev/skill_versions.py generate
   python3 skill-dev/skill_versions.py verify       # must end with "All skills match"
   python3 skill-dev/check_md_manifest.py           # must end with "matches the repo"
   ```
7. **Open the pull request.** It can merge only when the `verify` check passes and another team member has approved. A new commit on the pull request cancels earlier approvals.

What the `verify` check proves: every skill folder matches the content fingerprint recorded for it in `skills/SKILL-VERSIONS.json`, and every Markdown file is listed in the manifest. A skill edited without step 6 fails as `DRIFT`; a new skill fails as `UNLISTED`. The fingerprint covers the skill folders only, not the shared code in `src/`, `lib/` and `scripts/`.

### Adding a skill

Everything in "Changing a skill" applies, plus:

- **Pick the tier.** `skills/actionable/` if the skill can change Geo, otherwise `skills/non-actionable/`.
- **Frontmatter.** `SKILL.md` starts with `name`, a `description` that carries the phrases that should trigger it, and `version: 0.1.0`.
- **List it.** Add a row to the index in `skills/README.md`, a section in `skills/versions.md`, and a row in `MD-FILES.md` for every new Markdown file.
- **Route to it,** if editors should be sent to it by default: add a row to the routing table in `CLAUDE.md`.
- **Expect `UNLISTED`.** `verify` reports the new skill as unlisted until the manifest is regenerated in step 6.

### A skill built for one agent

A skill that only one agent needs starts in that agent's folder in `geo-agents` (`agents/<name>/`). It moves into this library once it is stable and has been evaluated, following "Adding a skill". This keeps unproven skills out of the release that every agent pins.

### How a change reaches the people and agents who use it

- **Nothing downloads skills while it runs.** No agent fetches or overwrites skill files during a task. If a skill is missing, the agent stops and asks a person.
- **A person updates a local install**, from a checkout of a release tag: `bash skill-dev/sync-skills.sh`, then restart the app.
- **`geo-agents` updates through its own pull request.** It keeps a copy of the skills pinned to one release tag and one commit, with a fingerprint per file in `skills.lock.json`. Moving to a newer release is a reviewed pull request in that repository.

## Cutting a release

A release is a signed tag on `main`. It is the only thing consumers pin to, so it is cut on purpose, by a person, from a commit where the check is green.

1. **Pick the commit.** It must be on `main` with a passing `verify` run. Check locally from a clean checkout of that commit:
   ```bash
   python3 skill-dev/skill_versions.py verify
   python3 skill-dev/check_md_manifest.py
   ```
2. **Pick the version.**

   | Bump | When |
   |---|---|
   | Major | A skill is removed or renamed, or the way a skill is used changes in a breaking way |
   | Minor | A skill is added or gains a capability, or files outside the skill folders are added or removed |
   | Patch | Fixes and wording only |

   `v1.0.0` is the library as it stood before the agents moved out. `v1.1.0` follows the cut-over in migration step 6.
3. **Tag and push.** The tag is signed, so signing must be set up in your git configuration first.
   ```bash
   git tag -s vX.Y.Z -m "geo-skills vX.Y.Z" <commit>
   git push origin vX.Y.Z
   ```
4. **Record the commit.** A tag can be moved; a commit hash cannot. Print the full 40-character hash and put it in the release notes:
   ```bash
   git rev-list -n 1 vX.Y.Z
   ```
5. **Write the release notes** on GitHub for that tag: the full commit hash, each skill with its version (from `skills/SKILL-VERSIONS.json`), and what changed since the previous release (from `skills/versions.md`).
6. **Never move or delete a published tag.** A mistake in a release is fixed by the next version.

After a release, `geo-agents` is updated by a pull request there that points its lock file at the new tag and commit.

## Branch protection on `main`

These settings live in the repository settings on GitHub, not in a file. They are what makes the procedures above binding.

| Setting | Value |
|---|---|
| Require a pull request before merging | On |
| Require approvals | On, at least one, from a team member other than the author |
| Dismiss stale pull request approvals when new commits are pushed | On |
| Require status checks to pass before merging | On, with the check `verify` |
| Do not allow bypassing the above settings | On, so the rules apply to administrators too |
