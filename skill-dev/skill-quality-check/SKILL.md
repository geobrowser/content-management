---
name: skill-quality-check
description: Check a Geo skill for FORM and QUALITY problems against the Agent Skill authoring standard - dangling references, frontmatter errors, missing table of contents, missing evals, weak descriptions, undefined vocabulary. Use when reviewing a skill, auditing skills, or before shipping a new or edited skill. Triggers on "check this skill", "review this skill", "audit skills", "is this skill ok", "lint skill", "skill quality".
metadata:
  author: moh
  version: "0.1.0"
---

# Skill Quality Check

Reviews an Agent Skill (`SKILL.md` directory) against the consolidated Agent Skill Authoring & Validation Standard and reports FORM/QUALITY problems. Read-only - it never edits a skill.

## When to apply

Use when the user wants to review, audit, or lint one or more skills, or check a new/edited skill before shipping.

## GUARDRAIL (do not cross)

Check **FORM and QUALITY only** - frontmatter validity, description quality, structure, file references, examples-present, terminology consistency, token budget, evals.

**Never flag, judge, or rewrite domain content.** A Geo skill legitimately contains the ontology, the offset-1000 query cap, testnet endpoints, space/type IDs, gate logic, and domain examples. Those are correct - not violations. If a check would require touching domain content, do not raise it. Report problems; a human decides any fix.

## Workflow

1. **Run the deterministic checks** (HARD + structural) with the script:
   ```bash
   python3 scripts/check_skill.py <path-to-skill-dir> --format table
   ```
   It validates: frontmatter (name <=64/[a-z0-9-]/no XML/no reserved word/matches dir; description non-empty/<=1024/no XML/states when-to-use/third-person), body under 500 lines, forward slashes, **referenced bundled files exist**, reference files >100 lines have a ToC, and `evals/evals.json` present. JSON output (default) is machine-readable; `--format table` lists only violations.

2. **Run the judgment checks** yourself, reading `references/skill-quality-standard.md` for the rules. These need a human/LLM call, not a regex:
   - Description states both **what** + **when**, and is specific (not vague filler).
   - **Self-contained**: no undefined vocabulary or pointers to another skill's concepts (e.g. "Pattern B/C/D" defined elsewhere).
   - Concrete (not abstract) examples present; consistent terminology throughout.
   - **All-caps ALWAYS/NEVER/MUST**: flag only if *unjustified*. If the rule explains *why* (e.g. "the UI enforces this"), it is fine - do not flag.
   - **Time-sensitive info**: flag only if it will *go stale* ("before August 2025 use X"). A dated historical justification ("incident on 2026-05-29") does not go stale - do not flag.
   - Progressive disclosure used appropriately for large skills.

3. **Report** a short findings table per skill: Check | Severity (FAIL = hard frontmatter rule, WARN = advisory) | Verdict | Evidence. List violations and notable passes; do not pad. If checking several skills, group findings into practical categories at the end.

## Notes

- Severity: **FAIL** = a hard, machine-checkable rule (frontmatter validity). **WARN** = advisory/quality. Numeric budgets (500 lines, ~5k/~100 tokens) are WARN, not FAIL.
- The script checks bundled `.md` references for existence; it deliberately ignores code imports (`../src/...`, `content-management/src/...`) - those are runtime, not skill docs.
- This skill checks form, not whether the skill *works*. Functional/behavioral testing is a separate job (see the skill-creator eval flow).

## Files

- `scripts/check_skill.py` - deterministic checker (run it; reads a skill dir, prints findings).
- `references/skill-quality-standard.md` - the consolidated standard (the full rule set + a machine-checkable summary).
- `evals/evals.json` - test cases (a known-good and a known-bad skill) for measuring this checker.
