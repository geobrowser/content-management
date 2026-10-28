#!/usr/bin/env python3
"""skill_versions.py — record & verify the approved version of every Geo skill.

Why: editors pull skills that can publish/delete on Geo. This proves the skill
they're running is exactly the version the team reviewed and approved — not
modified, not stale.

Two modes:
  generate  (maintainer, on approval)  — write skills/SKILL-VERSIONS.json from the
            current committed state: per skill, the commit it was last changed in
            + a content hash of its files.
  verify    (editor / CI)              — recompute each skill's content hash from the
            working copy and compare to the manifest. Reports OK / DRIFT / MISSING /
            UNLISTED. Exit code 0 = all good, 1 = drift found.

Run generate ONLY on a clean tree (commit first) so the recorded commit and the
content hash agree.

Usage:
  python3 skill-dev/skill_versions.py generate
  python3 skill-dev/skill_versions.py verify
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

REPO = Path(subprocess.check_output(
    ["git", "rev-parse", "--show-toplevel"], text=True).strip())
SKILLS_DIR = REPO / "skills"
MANIFEST = SKILLS_DIR / "SKILL-VERSIONS.json"


def find_skills():
    """Every directory under skills/ that contains a SKILL.md."""
    return sorted(p.parent for p in SKILLS_DIR.rglob("SKILL.md"))


def tracked_files(skill_dir):
    """git-tracked files under a skill dir (excludes junk / untracked)."""
    rel = skill_dir.relative_to(REPO).as_posix()
    out = subprocess.check_output(["git", "ls-files", rel], text=True).splitlines()
    return sorted(f for f in out if not f.endswith(".DS_Store"))


def content_hash(skill_dir):
    """Deterministic sha256 over the skill's tracked files (path + bytes).

    CRLF is normalized to LF before hashing so a Windows checkout
    (core.autocrlf) produces the same hash as the LF checkouts on macOS/CI.
    No-op for LF files, so existing manifest hashes are unchanged."""
    h = hashlib.sha256()
    for f in tracked_files(skill_dir):
        h.update(f.encode() + b"\0")
        h.update((REPO / f).read_bytes().replace(b"\r\n", b"\n") + b"\0")
    return h.hexdigest()


def last_commit(skill_dir):
    rel = skill_dir.relative_to(REPO).as_posix()
    return subprocess.check_output(
        ["git", "log", "-1", "--format=%H", "--", rel], text=True).strip()


def declared_version(skill_dir):
    """Read the version from SKILL.md frontmatter (metadata.version or top-level version)."""
    text = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    if text.startswith("---"):
        fm = text.split("---", 2)[1]
        for line in fm.splitlines():
            s = line.strip()
            if s.startswith("version:"):
                return s.split("version:", 1)[1].strip().strip('"').strip("'")
    return "unversioned"


def build():
    """Current state of every tracked skill: name -> {approved_commit, content_sha256}."""
    entries = {}
    for s in find_skills():
        files = tracked_files(s)
        name = s.relative_to(SKILLS_DIR).as_posix()
        if not files:
            print(f"  ! skipping {name} — untracked (commit it before approving)")
            continue
        entries[name] = {
            "version": declared_version(s),
            "approved_commit": last_commit(s),
            "content_sha256": content_hash(s),
        }
    return entries


def generate():
    data = {
        "_doc": "Approved version of each editor-facing skill. Regenerate with "
                "skill-dev/skill_versions.py generate after reviewing a change.",
        "skills": build(),
    }
    MANIFEST.write_text(json.dumps(data, indent=2) + "\n")
    print(f"Wrote {MANIFEST.relative_to(REPO)} — {len(data['skills'])} skills approved.")


def verify():
    if not MANIFEST.exists():
        print("No manifest. Run: python3 skill-dev/skill_versions.py generate")
        sys.exit(2)
    approved = json.loads(MANIFEST.read_text(encoding="utf-8"))["skills"]
    current = build()
    drift = []
    print(f"Verifying {len(current)} skills against {MANIFEST.relative_to(REPO)}:\n")
    for name in sorted(set(approved) | set(current)):
        a, c = approved.get(name), current.get(name)
        if a is None:
            print(f"  ⚠ UNLISTED  {name} — present locally but not in manifest")
            drift.append(name)
        elif c is None:
            print(f"  ✗ MISSING   {name} — in manifest but not found locally")
            drift.append(name)
        elif a["content_sha256"] == c["content_sha256"]:
            print(f"  ✓ OK        {name}  v{a.get('version','?')}  @ {a['approved_commit'][:10]}")
        else:
            print(f"  ✗ DRIFT     {name} — modified since approval "
                  f"(approved {a['approved_commit'][:10]})")
            drift.append(name)
    print()
    if drift:
        print(f"❌ {len(drift)} skill(s) do not match the approved version.")
        sys.exit(1)
    print("✅ All skills match their approved version.")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "generate":
        generate()
    elif cmd == "verify":
        verify()
    else:
        print(__doc__)
        sys.exit(2)
