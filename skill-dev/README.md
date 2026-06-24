# skill-dev — maintainer tooling

Developer-facing tools for **building** Geo skills. **Not shipped to editors** — editors only pull `../skills/`.

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
