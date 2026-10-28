#!/usr/bin/env bash
# Deploy the repo's skills to the local skill hosts so Codex / Claude app / Claude Code
# all run the SAME version that's in git — the fix for the "deployed copies drift stale"
# problem (editors were on geo-publish 0.5.1 while main was 0.8.0).
#
# Run from the geo-skills repo root:  bash skill-dev/sync-skills.sh
# NOTE: this only refreshes LOCAL hosts. Editors on claude.ai must re-upload via
# Settings -> Skills (browser skills are not on disk, can't be synced from here).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIRS=("$REPO/skills/actionable" "$REPO/skills/non-actionable")

# Deploy targets (flat: <target>/<skill-name>/SKILL.md)
TARGETS=()
[ -d "$HOME/.codex/skills" ] && TARGETS+=("$HOME/.codex/skills")
TARGETS+=("$HOME/.claude/skills")   # Claude Code (created if missing)
while IFS= read -r d; do TARGETS+=("$d"); done < <(
  find "$HOME/Library/Application Support/Claude" -type d -name skills -path "*skills-plugin*" 2>/dev/null)

echo "Repo: $REPO"
for t in "${TARGETS[@]}"; do
  mkdir -p "$t"
  echo "→ $t"
  for src in "${SRC_DIRS[@]}"; do
    for skill in "$src"/*/; do
      name="$(basename "$skill")"
      rsync -a --delete "$skill" "$t/$name/"
      echo "   ✓ $name ($(grep -m1 -oE 'version: *"?[0-9.]+' "$t/$name/SKILL.md" 2>/dev/null | grep -oE '[0-9.]+' || echo '?'))"
    done
  done
done
echo "Done. Deployed $(( ${#SRC_DIRS[@]} )) source dirs to ${#TARGETS[@]} host(s)."
