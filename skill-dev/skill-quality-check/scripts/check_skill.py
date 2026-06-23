#!/usr/bin/env python3
"""
check_skill.py - deterministic FORM/QUALITY checks for an Agent Skill (SKILL.md).

Validates a skill directory against the HARD / machine-checkable rules in the
Agent Skill Authoring & Validation Standard. The soft, judgment-based checks
(third-person nuance, justified vs. noise all-caps, historical vs. stale dates,
undefined vocabulary) are handled by the LLM pass described in SKILL.md - NOT here.

GUARDRAIL: checks FORM/QUALITY only. It never inspects or judges domain content
(ontology rules, IDs, endpoints, query caps, examples) - only structure.

Usage:
  check_skill.py <skill_dir> [--format json|table]
  check_skill.py --help

Output: structured findings to stdout (JSON by default), progress to stderr.
Exit codes: 0 = no FAIL findings, 1 = at least one FAIL, 2 = usage/IO error.
"""
import sys
import os
import re
import json
import argparse

RESERVED = ("anthropic", "claude")
CODE_PREFIXES = ("src/", "content-management/", "node_modules/", "../", "./src/")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def parse_frontmatter(text):
    """Return (frontmatter_dict, body_str, ok). Handles single-line scalars and
    YAML block scalars (description: > or |) which span indented lines."""
    if not text.startswith("---"):
        return {}, text, False
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text, False
    fm_block = text[3:end].strip("\n")
    body = text[end + 4:]
    lines = fm_block.split("\n")
    fm = {}
    i = 0
    while i < len(lines):
        line = lines[i]
        indented = line.startswith(" ") or line.startswith("\t")
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if m and not indented:
            key, val = m.group(1), m.group(2).strip()
            if val in (">", "|", ">-", "|-", ">+", "|+"):
                # block scalar: collect following indented (or blank) lines
                block, i = [], i + 1
                while i < len(lines) and (lines[i].startswith(" ") or lines[i].startswith("\t") or lines[i].strip() == ""):
                    block.append(lines[i].strip())
                    i += 1
                fm[key] = " ".join(b for b in block if b).strip()
                continue
            fm[key] = val
        i += 1
    return fm, body, True


def strip_quotes(s):
    s = s.strip()
    if len(s) >= 2 and s[0] in "\"'" and s[-1] == s[0]:
        return s[1:-1]
    return s


def finding(check, severity, ok, evidence):
    return {
        "check": check,
        "severity": severity,
        "verdict": "pass" if ok else "violation",
        "evidence": evidence,
    }


def find_referenced_md(body):
    refs = set()
    for m in re.finditer(r"\]\(([^)]+)\)", body):          # markdown links
        refs.add(m.group(1).strip())
    for m in re.finditer(r"`([\w./-]+\.(?:md|py|ts|js|json|txt|sh))`", body):  # backticked paths
        refs.add(m.group(1).strip())
    return refs


def is_skill_relative_md(p):
    """A bundled doc the skill promises to load (not an external URL or code import)."""
    if p.startswith("http") or p.startswith("#") or p.startswith("/"):
        return False
    if ".." in p:
        return False
    for pre in CODE_PREFIXES:
        if p.startswith(pre):
            return False
    return p.endswith(".md")


def has_toc(text):
    head_lines = text.splitlines()[:25]
    head = "\n".join(head_lines).lower()
    if "## contents" in head or "table of contents" in head or "## toc" in head:
        return True
    bullets = re.findall(r"^\s*[-*] ", "\n".join(head_lines), re.M)
    return len(bullets) >= 3


def find_repo_root(start):
    """Nearest ancestor directory containing a .git (the repo root), or None."""
    d = os.path.abspath(start)
    while True:
        if os.path.isdir(os.path.join(d, ".git")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def check_skill(skill_dir):
    findings = []
    skill_dir = os.path.abspath(skill_dir.rstrip("/"))
    name_expected = os.path.basename(skill_dir)
    skill_md = os.path.join(skill_dir, "SKILL.md")

    if not os.path.isfile(skill_md):
        return [finding("SKILL.md exists", "FAIL", False, "no SKILL.md in " + skill_dir)]

    text = read(skill_md)
    fm, body, ok = parse_frontmatter(text)
    findings.append(finding("Frontmatter present (YAML at top)", "FAIL", ok,
                            "ok" if ok else "SKILL.md does not begin with --- frontmatter ---"))
    if not ok:
        return findings

    # name
    name = strip_quotes(fm.get("name", ""))
    if not name:
        findings.append(finding("name present", "FAIL", False, "no name field"))
    else:
        problems = []
        if len(name) > 64:
            problems.append("over 64 chars (%d)" % len(name))
        if not re.fullmatch(r"[a-z0-9-]+", name):
            problems.append("not [a-z0-9-] only")
        if "<" in name or ">" in name:
            problems.append("contains XML tags")
        for r in RESERVED:
            if r in name.lower():
                problems.append("reserved word '%s'" % r)
        findings.append(finding("name valid (<=64, [a-z0-9-], no XML, no reserved word)",
                                "FAIL", not problems, name if not problems else name + ": " + "; ".join(problems)))
        findings.append(finding("name matches directory", "WARN", name == name_expected,
                                "ok" if name == name_expected else "name='%s' dir='%s'" % (name, name_expected)))

    # description
    desc = strip_quotes(fm.get("description", ""))
    if not desc:
        findings.append(finding("description present + non-empty", "FAIL", False, "no description"))
    else:
        problems = []
        if len(desc) > 1024:
            problems.append("over 1024 chars (%d)" % len(desc))
        if "<" in desc or ">" in desc:
            problems.append("contains XML tags")
        findings.append(finding("description valid (non-empty, <=1024, no XML)", "FAIL", not problems,
                                ("%d chars" % len(desc)) if not problems else "; ".join(problems)))
        when = bool(re.search(r"\b(use when|use whenever|use this|use it|use for|triggers? on|trigger phrase|when the user|invoke (this|when))\b", desc, re.I))
        findings.append(finding("description states when-to-use (heuristic)", "WARN", when,
                                "ok" if when else "no explicit 'use when / triggers on' phrasing"))
        # strip double-quoted trigger phrases first ("what should we publish" etc.)
        # so pronouns inside example triggers are not mistaken for authoring voice.
        desc_voice = re.sub(r'"[^"]*"', " ", desc)
        first_second = bool(re.search(r"\b(I can|I will|you can use this|we )\b", desc_voice, re.I))
        findings.append(finding("description third-person (heuristic)", "WARN", not first_second,
                                "ok" if not first_second else "first/second-person phrasing in description"))

    # body size
    body_lines = body.count("\n") + 1
    findings.append(finding("SKILL.md body under 500 lines", "WARN", body_lines < 500, "%d lines" % body_lines))

    # backslash paths: a real Windows path has word\word AND a file extension.
    # This excludes escape sequences like `\n\n`, `\t`, `\"` which are not paths.
    backslash = [s for s in re.findall(r"`[^`]*`", body)
                 if re.search(r"[\w.-]+\\[\w.-]+", s) and re.search(r"\.(py|md|ts|js|json|txt|sh|csv|yaml|yml)\b", s)]
    findings.append(finding("forward slashes only (no backslash paths)", "WARN", not backslash,
                            "ok" if not backslash else "backslash path(s): " + ", ".join(backslash)))

    # referenced .md files: prefer bundled (self-contained); else check the repo root
    # (repo-coupled - exists but not portable); else truly missing (dangling).
    repo_root = find_repo_root(skill_dir)
    refs = find_referenced_md(body)
    missing, repo_coupled, toc_missing = [], [], []
    for p in sorted(refs):
        if not is_skill_relative_md(p):
            continue
        full = os.path.join(skill_dir, p)
        if os.path.isfile(full):
            rtext = read(full)
            rlines = rtext.count("\n") + 1
            if rlines > 100 and not has_toc(rtext):
                toc_missing.append("%s (%d lines)" % (p, rlines))
        elif repo_root and os.path.isfile(os.path.join(repo_root, p)):
            repo_coupled.append(p)
        else:
            missing.append(p)
    findings.append(finding("referenced files exist (not dangling)", "WARN", not missing,
                            "ok" if not missing else "MISSING (not in skill or repo root): " + ", ".join(missing)))
    if repo_coupled:
        findings.append(finding("references are bundled in the skill (self-contained)", "WARN", False,
                                "repo-coupled - exist at repo root but not bundled: " + ", ".join(repo_coupled)))
    findings.append(finding("reference files >100 lines have a ToC", "WARN", not toc_missing,
                            "ok" if not toc_missing else "no ToC: " + ", ".join(toc_missing)))

    # evals
    evals = os.path.join(skill_dir, "evals", "evals.json")
    findings.append(finding("evals/evals.json present", "WARN", os.path.isfile(evals),
                            "present" if os.path.isfile(evals) else "missing evals/evals.json"))

    return findings


def scaffold_evals(skill_dir):
    """Write a starter evals/evals.json into the skill dir (never overwrites)."""
    skill_dir = os.path.abspath(skill_dir.rstrip("/"))
    name = os.path.basename(skill_dir)
    evals_dir = os.path.join(skill_dir, "evals")
    path = os.path.join(evals_dir, "evals.json")
    if os.path.isfile(path):
        print("evals/evals.json already exists - not overwriting: " + path, file=sys.stderr)
        return False
    os.makedirs(evals_dir, exist_ok=True)
    template = {
        "skill_name": name,
        "evals": [
            {
                "id": 1,
                "prompt": "A realistic user request that should trigger this skill (use concrete details - file paths, names, IDs).",
                "expected_output": "What success looks like, in plain words.",
                "files": [],
                "assertions": [
                    "An objectively verifiable statement about the output (e.g. 'produces a dry-run plan before any write').",
                    "Another concrete, checkable assertion.",
                ],
            }
        ],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(template, f, indent=2)
        f.write("\n")
    print("wrote starter " + path + " - fill in real cases (2-3 to start)", file=sys.stderr)
    return True


def main():
    ap = argparse.ArgumentParser(
        description="Deterministic FORM/QUALITY checks for an Agent Skill (SKILL.md). "
                    "FORM only - never judges domain content.")
    ap.add_argument("skill_dir", help="path to the skill directory (containing SKILL.md)")
    ap.add_argument("--format", choices=["json", "table"], default="json",
                    help="output format (default: json)")
    ap.add_argument("--scaffold", action="store_true",
                    help="write a starter evals/evals.json into the skill dir (does not overwrite) instead of checking")
    args = ap.parse_args()

    if not os.path.isdir(args.skill_dir):
        print("Error: not a directory: " + args.skill_dir, file=sys.stderr)
        sys.exit(2)
    if args.scaffold:
        scaffold_evals(args.skill_dir)
        sys.exit(0)
    try:
        findings = check_skill(args.skill_dir)
    except Exception as e:  # solve, don't punt - report clearly
        print("Error checking %s: %s" % (args.skill_dir, e), file=sys.stderr)
        sys.exit(2)

    fails = [f for f in findings if f["severity"] == "FAIL" and f["verdict"] == "violation"]
    warns = [f for f in findings if f["severity"] == "WARN" and f["verdict"] == "violation"]
    name = os.path.basename(os.path.abspath(args.skill_dir))

    print("checked %s: %d FAIL, %d WARN" % (name, len(fails), len(warns)), file=sys.stderr)
    if args.format == "json":
        print(json.dumps({
            "skill": name,
            "summary": {"fail": len(fails), "warn": len(warns), "checks": len(findings)},
            "findings": findings,
        }, indent=2))
    else:
        print("# %s - %d FAIL, %d WARN" % (name, len(fails), len(warns)))
        for f in findings:
            if f["verdict"] == "pass":
                continue
            tag = "FAIL" if f["severity"] == "FAIL" else "WARN"
            print("  [%s] %s - %s" % (tag, f["check"], f["evidence"]))
        if not fails and not warns:
            print("  (no violations)")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
