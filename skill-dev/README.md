# skill-dev — maintainer tooling

Developer-facing tools for **building** Geo skills. **Not shipped to editors** — editors only pull `../skills/`.

## ✅ Before you commit a skill change (every time)

Any add/edit to a skill under `../skills/` must end with these, or **CI fails the PR**:

```bash
# 1. (recommended) lint the skill against the authoring standard
python3 skill-dev/skill-quality-check/scripts/check_skill.py skills/<tier>/<skill> --format table

# 2. (required) bump version + add a versions.md changelog bullet  — see ../skills/versions.md

# 3. (required) re-approve: regenerate the integrity manifest and stage it IN THE SAME COMMIT
python3 skill-dev/skill_versions.py generate
python3 skill-dev/skill_versions.py verify        # must print "✅ All skills match"
git add skills/SKILL-VERSIONS.json
```

Skip step 3 and CI's `verify-skills` job rejects the PR as `DRIFT` (you changed a skill) or `UNLISTED` (you added one). The manifest **must** be committed together with the skill change. Details below.

---

- **`skill-quality-check/`** — the Agent Skill authoring **standard** + a linter that checks a skill against it (dangling references, frontmatter, missing evals/ToC, weak descriptions). Form/quality only; it never judges domain content.

Run it before adding or editing anything under `../skills/`:

```bash
python3 skill-dev/skill-quality-check/scripts/check_skill.py skills/non-actionable/geo-query --format table
```

The full rule set is in `skill-quality-check/references/skill-quality-standard.md` — treat it as the standard for skill development in this repo.

## `skill_versions.py` — approved-version verification

Proves an editor is running the exact skill version the team approved (not tampered, not stale) — important because `actionable/` skills can publish/delete on Geo.

How it works: `skills/SKILL-VERSIONS.json` records, per skill, the commit it was approved at + a sha256 content hash of its files. `verify` recomputes the hashes from the working copy and compares.

```bash
# maintainer — after reviewing/approving a skill change, on a CLEAN (committed) tree:
python3 skill-dev/skill_versions.py generate   # updates skills/SKILL-VERSIONS.json

# editor / CI — confirm local skills match the approved versions:
python3 skill-dev/skill_versions.py verify     # exit 0 = all match, 1 = drift
```

`verify` reports per skill: `OK` · `DRIFT` (modified since approval) · `MISSING` · `UNLISTED`. **CI runs it on every PR** (`.github/workflows/verify-skills.yml`) — any unreviewed change to a shipped skill fails the build. Re-run `generate` whenever you intentionally approve a change, and commit the updated manifest in the same commit.
