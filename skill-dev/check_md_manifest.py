#!/usr/bin/env python3
"""Check MD-FILES.md against the repository.

The manifest lists every Markdown file in the repo and, for skills, its version.
Both go stale the moment someone adds a file or bumps a version, and a stale list
is worse than none: it is the thing people check instead of the files.

Fails when:
  1. a tracked .md file is missing from the manifest
  2. the manifest names a .md file that no longer exists
  3. a SKILL.md version differs from the version recorded in the manifest

Usage:
  python3 skill-dev/check_md_manifest.py          # exit 1 on drift
  python3 skill-dev/check_md_manifest.py --list   # show what the manifest records
"""
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MANIFEST = REPO / "MD-FILES.md"


def tracked_md() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "*.md"], cwd=REPO, capture_output=True, text=True, check=True
    ).stdout.split()
    return [f for f in out if "node_modules" not in f]


def skill_version(path: Path) -> str | None:
    for line in path.read_text(encoding="utf-8").splitlines()[:15]:
        m = re.match(r'\s*version:\s*"?([0-9][0-9A-Za-z.\-]*)"?', line)
        if m:
            return m.group(1)
    return None


def main() -> int:
    if not MANIFEST.exists():
        print(f"❌ {MANIFEST.relative_to(REPO)} not found")
        return 1
    text = MANIFEST.read_text(encoding="utf-8")
    files = tracked_md()

    missing = [f for f in files if f not in text]
    # every `path/to/file.md` in a table cell should still exist
    # `<id>` style placeholders describe a pattern, not a real path
    listed = {m for m in re.findall(r"`([^`\s]+\.md)`", text) if "/" in m and "<" not in m}
    gone = sorted(p for p in listed if not (REPO / p).exists())

    wrong_version = []
    for f in files:
        if not f.endswith("/SKILL.md") or not f.startswith("skills/"):
            continue
        actual = skill_version(REPO / f)
        if actual is None:
            continue
        row = re.search(rf"\|\s*`{re.escape(f)}`\s*\|\s*([0-9][0-9A-Za-z.\-]*)\s*\|", text)
        if row and row.group(1) != actual:
            wrong_version.append((f, row.group(1), actual))

    if "--list" in sys.argv:
        print(f"{len(files)} tracked .md files; {len(listed)} paths named in the manifest")

    ok = True
    if missing:
        ok = False
        print(f"❌ {len(missing)} tracked .md file(s) missing from the manifest:")
        for f in missing:
            print(f"     {f}")
    if gone:
        ok = False
        print(f"❌ {len(gone)} file(s) named in the manifest no longer exist:")
        for f in gone:
            print(f"     {f}")
    if wrong_version:
        ok = False
        print(f"❌ {len(wrong_version)} skill version(s) out of date in the manifest:")
        for f, listed_v, actual_v in wrong_version:
            print(f"     {f}: manifest says {listed_v}, file says {actual_v}")

    if ok:
        print(f"✅ MD-FILES.md matches the repo ({len(files)} tracked .md files)")
        return 0
    print("\nFix: update MD-FILES.md — add the file to the right section, "
          "or correct the version — and update the counts in its footer.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
