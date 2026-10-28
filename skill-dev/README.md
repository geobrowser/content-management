# skill-dev — maintainer tooling

Developer-facing tools for **building** Geo skills. **Not shipped to editors** — editors only pull `../skills/`.

## ✅ Before you commit a skill change (every time)

Any add/edit to a skill under `../skills/` must end with these, or **CI fails the PR**:

```bash
# 1. (recommended) lint the skill against the authoring standard
python3 skill-dev/skill-quality-check/scripts/check_skill.py skills/<tier>/<skill> --format table

# 2. (required) bump version + add a versions.md changelog bullet  — see ../skills/versions.md

# 3. (required) re-approve: commit the skill change, then regenerate the manifest and commit it IN THE SAME PULL REQUEST
python3 skill-dev/skill_versions.py generate
python3 skill-dev/skill_versions.py verify        # must print "✅ All skills match"
git add skills/SKILL-VERSIONS.json
```

Skip step 3 and CI's `verify-skills` job rejects the PR as `DRIFT` (you changed a skill) or `UNLISTED` (you added one). The manifest **must** be committed in the same pull request as the skill change. The full procedure, including adding a new skill, is in [`../MAINTAINERS.md`](../MAINTAINERS.md). Details below.

---

- **`skill-quality-check/`** — the Agent Skill authoring **standard** + a linter that checks a skill against it (dangling references, frontmatter, missing evals/ToC, weak descriptions). Form/quality only; it never judges domain content.

Run it before adding or editing anything under `../skills/`:

```bash
python3 skill-dev/skill-quality-check/scripts/check_skill.py skills/non-actionable/geo-query --format table
```

The full rule set is in `skill-quality-check/references/skill-quality-standard.md` — treat it as the standard for skill development in this repo.

## `check_md_manifest.py` — Markdown manifest verification

Checks `MD-FILES.md` against the repo: every tracked `.md` is listed, no listed file has been deleted, and each `SKILL.md` version matches the one recorded. Runs in CI on changes under `skills/` or `agents/`.

```bash
python3 skill-dev/check_md_manifest.py          # exit 0 = matches, 1 = drift
python3 skill-dev/check_md_manifest.py --list   # counts
```

A stale manifest is worse than none, because people check it instead of the files. Add a new `.md` to the right section in the same commit that creates it.

## `skill_versions.py` — approved-version verification

Proves an editor is running the exact skill version the team approved (not tampered, not stale) — important because `actionable/` skills can publish/delete on Geo.

How it works: `skills/SKILL-VERSIONS.json` records, per skill, the commit it was approved at + a sha256 content hash of its files. `verify` recomputes the hashes from the working copy and compares.

```bash
# maintainer — after reviewing/approving a skill change, on a CLEAN (committed) tree:
python3 skill-dev/skill_versions.py generate   # updates skills/SKILL-VERSIONS.json

# editor / CI — confirm local skills match the approved versions:
python3 skill-dev/skill_versions.py verify     # exit 0 = all match, 1 = drift
```

`verify` reports per skill: `OK` · `DRIFT` (modified since approval) · `MISSING` · `UNLISTED`. **CI runs it on every PR** (`.github/workflows/verify-skills.yml`) — any unreviewed change to a shipped skill fails the build. Re-run `generate` whenever you intentionally approve a change, and commit the updated manifest in the same pull request.
