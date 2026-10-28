#!/usr/bin/env python3
"""Gather a clean digest of one day's Claude Code sessions for the daily-report skill.

Scans the user's Claude Code session transcripts, keeps only the messages timestamped on the
target date, strips tool/thinking/system noise, and prints a compact digest of the actual
conversation (user prompts + assistant prose). The skill reads THIS, not the raw multi-MB JSONL —
so it's cheap and reliable, and it works for any editor regardless of their folder layout.

By default it scans EVERY project under ~/.claude/projects/ (so it finds the editor's Geo work
wherever their working folder lives); narrow with --project-dir. It deliberately does not summarize
or judge — the skill's LLM step distills the GEO WORK from this digest.

Dependencies: Python 3 standard library only.

Examples:
  python3 gather_sessions.py                       # today, all projects
  python3 gather_sessions.py --date 2026-06-29
  python3 gather_sessions.py --project-dir ~/.claude/projects/-Users-me-work-geo
  python3 gather_sessions.py --list                # just list the day's sessions
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path

PROJECTS_ROOT = os.path.expanduser("~/.claude/projects")


def msg_text(content):
    """Pull human-readable text from a message.content (str or list of blocks)."""
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts = [b["text"].strip() for b in content
             if isinstance(b, dict) and b.get("type") == "text" and b.get("text")]
    return "\n".join(p for p in parts if p)


def is_noise(text):
    if not text:
        return True
    t = text.lstrip()
    return t.startswith("<system-reminder>") or t.startswith("<command-")


def gather_dir(project_dir, target_date, max_chars):
    sessions = []
    for f in sorted(Path(project_dir).glob("*.jsonl")):
        turns, times = [], []
        try:
            with f.open(encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        o = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if o.get("type") not in ("user", "assistant"):
                        continue
                    ts = o.get("timestamp", "")
                    if not ts.startswith(target_date):
                        continue
                    m = o.get("message") or {}
                    role = m.get("role") or o.get("type")
                    text = msg_text(m.get("content"))
                    if is_noise(text):
                        continue
                    times.append(ts[11:16])
                    if len(text) > max_chars:
                        text = text[:max_chars] + " …[truncated]"
                    turns.append((role, text))
        except OSError:
            continue
        if turns:
            sessions.append({"id": f.stem, "project": Path(project_dir).name,
                             "turns": turns,
                             "span": f"{times[0]}–{times[-1]}" if times else "?"})
    return sessions


def main():
    p = argparse.ArgumentParser(
        description="Gather a clean digest of one day's Claude Code sessions (for the daily-report skill).",
        epilog="Stdlib only. Output is a digest for the skill to distill into the day's Geo-work bullets.")
    p.add_argument("--project-dir", default=None,
                   help="a single Claude Code project session dir (default: scan all under ~/.claude/projects/)")
    p.add_argument("--date", default=dt.date.today().isoformat(),
                   help="target day YYYY-MM-DD (default today)")
    p.add_argument("--max-chars", type=int, default=1500, help="truncate each turn (default 1500)")
    p.add_argument("--list", action="store_true", help="just list the day's sessions, no digest")
    args = p.parse_args()

    if args.project_dir:
        dirs = [os.path.expanduser(args.project_dir)]
    else:
        if not os.path.isdir(PROJECTS_ROOT):
            p.error(f"no Claude Code projects dir at {PROJECTS_ROOT}")
        dirs = [str(d) for d in Path(PROJECTS_ROOT).iterdir() if d.is_dir()]

    sessions = []
    for d in dirs:
        sessions.extend(gather_dir(d, args.date, args.max_chars))
    sessions.sort(key=lambda s: s["span"])

    if not sessions:
        print(f"(no Claude Code sessions with activity on {args.date})")
        return

    if args.list:
        print(f"{len(sessions)} session(s) active on {args.date}:")
        for s in sessions:
            print(f"  {s['id'][:8]}  {s['span']}  {len(s['turns'])} turns  [{s['project']}]")
        return

    print(f"# Claude Code activity — {args.date}  ({len(sessions)} session(s))\n")
    print("Digest of user prompts + assistant responses (tool/thinking noise stripped). "
          "Distill the GEO WORK done into report bullets; ignore Claude mechanics and anything personal.\n")
    for s in sessions:
        print(f"\n## Session {s['id'][:8]} ({s['span']}, {len(s['turns'])} turns) [{s['project']}]")
        for role, text in s["turns"]:
            print(f"\n[{role}] {text}")


if __name__ == "__main__":
    main()
