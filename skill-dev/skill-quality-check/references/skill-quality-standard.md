# The Agent Skill Authoring & Validation Standard

A single source-of-truth specification for authoring and validating an Agent Skill (a `SKILL.md`-based unit of agent capability) and for building an automated skill-quality checker. Every rule appears exactly once, is marked **HARD** (prescriptive / machine-checkable) or **SOFT** (advisory budget or judgment guidance), and cites the owner(s) that establish it.

## Contents
- §1 Frontmatter & Naming
- §2 Description & Triggering
- §3 Progressive Disclosure & Token Economy
- §4 File Layout & References
- §5 Examples, Workflows & Output Formats
- §6 Scripts & Dependencies
- §7 Terminology, Content Hygiene & Maintenance
- §8 Evaluation & Testing
- §9 Tool/Function-Definition Analogues (OpenAI)
- §10 Machine-Checkable Rule Summary

## Provenance

This standard is distilled from ten primary sources, grouped by owner:

- **Anthropic** — Agent Skills Overview; Agent Skills Best Practices; the "Equipping Agents for the Real World" engineering article; the official `skill-creator` reference SKILL.md.
- **Google ADK** — "Building ADK Agents with Skills" developer guide; the ADK Skills documentation (`adk.dev/skills`). Google ADK is a near-1:1 analogue of the Anthropic standard and shares the underlying spec.
- **agentskills.io** — the cross-vendor Agent Skills specification (the shared formal spec that Google ADK and others implement).
- **OpenAI (analogue, description/triggering dimension only)** — Function Calling guide; GPT Actions getting-started/production; the o3/o4-mini prompting guide. OpenAI describes tool/function definitions, not `SKILL.md` skills; its rules are imported **only** where they illuminate the description/triggering dimension and are labeled *(OpenAI — analogue)*.

Where the spec is owned jointly, rules cite `(agentskills.io spec; Google ADK)` and note Anthropic alignment. Conflicts between sources are reconciled in the body and recorded in the `conflicts` field.

---

## 1. Frontmatter & Naming

`SKILL.md` is the only required file in a skill directory; it MUST begin with YAML frontmatter followed by Markdown body content.

### Required fields

- **HARD** — Frontmatter MUST contain exactly two required fields: `name` and `description`. All other fields are optional. (Anthropic; agentskills.io spec; Google ADK)

### `name`

- **HARD** — `name` maximum **64 characters**. (Anthropic; agentskills.io spec; Google ADK)
- **HARD** — `name` must contain only lowercase letters, numbers, and hyphens. (Anthropic; agentskills.io spec; Google ADK)
- **HARD** — `name` must not start or end with a hyphen, and must not contain consecutive hyphens (`--`). (agentskills.io spec; Google ADK) — *Note: Anthropic states the character-class rule but does not list the hyphen-position constraints; the spec is the stricter superset and governs.*
- **HARD** — `name` must match the parent directory name (the skill folder name equals the frontmatter `name`). (agentskills.io spec; Google ADK) — *Note: not asserted by Anthropic's surfaces but required by the cross-vendor spec.*
- **HARD** — `name` must not contain XML tags. (Anthropic)
- **HARD** — `name` must not contain the reserved words `anthropic` or `claude`. (Anthropic) — *Platform-specific to Anthropic surfaces; a cross-vendor checker SHOULD treat this as an Anthropic-target rule, not universal.*
- **SOFT** — Prefer gerund form (`processing-pdfs`, `analyzing-spreadsheets`) or a noun phrase (`pdf-processing`); avoid vague names (`helper`, `utils`, `tools`, `documents`, `data`, `files`); keep naming patterns consistent across a skill collection. (Anthropic)

### `description`

- **HARD** — `description` must be non-empty. (Anthropic; agentskills.io spec; Google ADK)
- **HARD** — `description` maximum **1024 characters**. (Anthropic; agentskills.io spec; Google ADK) — *Convergent with the OpenAI function `description` API limit of 1,024 characters (OpenAI — analogue).*
- **HARD** — `description` must not contain XML tags. (Anthropic)
- **HARD** — `description` must describe both **what** the skill does AND **when** to use it (triggers/contexts). (Anthropic; agentskills.io spec; Google ADK)

### Optional fields

- **HARD** — `compatibility`, if present, maximum **500 characters**; include only when the skill has specific environment requirements (intended product, system packages, network access, runtime version). Most skills omit it. (agentskills.io spec; Google ADK)
- **SOFT** — `license` (license name or bundled-file reference), `metadata` (string→string map; use reasonably unique keys), and `allowed-tools` (space-separated string of pre-approved tools; **experimental**, support varies) are optional. (agentskills.io spec; Google ADK)

---

## 2. Description & Triggering

The `description` is the single most important field: it is the primary mechanism by which an agent decides whether to load a skill, and it must work standing alone among potentially 100+ installed skills.

- **HARD** — Each skill has exactly one `description` field; it must carry all "when to use" information (this does not belong in the body). (Anthropic; skill-creator)
- **HARD** — Write the description in **third person**. It is injected into the system prompt, and inconsistent point-of-view degrades discovery. Good: "Processes Excel files and generates reports." Avoid: "I can help you…" / "You can use this to…". (Anthropic)
- **SOFT** — Be specific; include concrete keywords, file types, and the contexts/triggers where the skill applies. Avoid vague descriptions ("Helps with documents", "Processes data", "A helpful skill"). Describe user intent, not internal implementation. (Anthropic; agentskills.io spec; Google ADK)
- **SOFT** — Lean slightly "pushy" to combat under-triggering: explicitly list applicable contexts, including cases where the user does not name the domain ("even if they don't explicitly mention 'CSV' or 'analysis'"). Imperative "Use when…" phrasing is effective. (skill-creator; agentskills.io spec)
- **SOFT** — Disambiguate from adjacent/overlapping skills: state boundaries and what the skill does *not* do when negative test cases false-trigger. (agentskills.io spec; OpenAI — analogue)
- **Triggering nuance (informational):** Agents typically consult a skill only for tasks beyond what they handle natively. A simple one-step request (e.g. "read this PDF") may not trigger a matching skill. Therefore eval queries used for description optimization should be substantive, multi-step tasks. (skill-creator; agentskills.io spec)

### OpenAI analogue rules (description/triggering only)

These apply by analogy to how a tool/function `description` drives selection; map "function/tool description" → skill `description`:

- **SOFT** — Place the key rules / decision-critical text at the **front** of the description; minimize distraction. A front-loaded description scored measurably higher on tool-selection accuracy. (OpenAI — analogue)
- **SOFT** — Include usage criteria for both **when to call** and **when not to call**. (OpenAI — analogue)
- **SOFT** — When multiple skills/tools overlap, specify priority and fallback explicitly to prevent wrong selection or hesitation. (OpenAI — analogue)
- **SOFT** — Keep the available set small for selection accuracy: aim for fewer than ~20 actively-offered options at the start of a turn; ~100 tools / ~20 arguments-per-tool is the in-distribution ceiling. (OpenAI — analogue) — *For skills, this bounds how many skills you expose at once, not the contents of one skill.*
- **SOFT** — Descriptions must not over-prescribe triggering ("Whenever the user mentions any task, ask if they want the TODO action") nor hard-code conversational trigger phrases; the agent activates automatically when appropriate. (OpenAI — analogue) — *Tension with Anthropic's "be pushy": resolved in §Conflicts — push via richer context and listed contexts, not via scripted trigger phrases or nagging.*

---

## 3. Progressive Disclosure & Token Economy

Skills load in **three levels**. Only relevant content should occupy the context window at any time.

| Level | What | When loaded | Budget |
|---|---|---|---|
| **L1 Metadata** | `name` + `description` from frontmatter | Always, at startup, for every installed skill | **~100 tokens per skill** (SOFT) |
| **L2 Instructions** | `SKILL.md` body | When the skill is triggered/activated | **Under 5k tokens** recommended (SOFT) |
| **L3 Resources** | Bundled files in `references/`, `assets/`, `scripts/` | On demand, only when referenced | Effectively unlimited (no practical context cost until read) (HARD characterization) |

- **HARD (architectural fact)** — L1 is always loaded; L2 loads only on activation; L3 files load only when referenced. Scripts can be executed without loading their source into context — only a script's **output** consumes tokens. (Anthropic; agentskills.io spec; Google ADK)
- **SOFT** — L1 metadata budget ≈ **100 tokens per skill**. (Anthropic; agentskills.io spec; Google ADK) — *skill-creator phrases this as "~100 words"; the dominant and more precise figure across sources is ~100 tokens — see §Conflicts.*
- **SOFT** — L2 (`SKILL.md` body) target **under 5,000 tokens**. (Anthropic; agentskills.io spec; Google ADK)
- **SOFT** — Keep the `SKILL.md` body **under 500 lines**; split into separate files when approaching the limit. (Anthropic; skill-creator; agentskills.io spec; Google ADK)
- **Token-economy benchmark (informational):** An agent with 10 skills starts each call with ~1,000 tokens of L1 metadata instead of ~10,000 tokens in a monolithic prompt — roughly a 90% baseline-context reduction. (Google ADK)

### Conciseness discipline

- **SOFT** — Default assumption: the agent is already capable. Add only context it lacks (project-specific conventions, domain procedures, non-obvious edge cases, specific tools/APIs). For each line ask "Would the agent get this wrong without this?" — if no, cut it. Don't explain general concepts (what a PDF is, how HTTP works). (Anthropic; agentskills.io spec)
- **SOFT** — Set appropriate **degrees of freedom**, matching specificity to the task's fragility: **high freedom** (prose instructions) when multiple approaches are valid; **medium freedom** (parameterized scripts/pseudocode) when a preferred pattern exists; **low freedom** (exact scripts, "run exactly this, do not modify") when operations are fragile or a strict sequence is required. (Anthropic; agentskills.io spec)
- **SOFT** — Provide a **default, not a menu**: pick one recommended tool/approach and mention alternatives briefly as an escape hatch, rather than listing equal options. (Anthropic; agentskills.io spec)
- **SOFT** — Favor reusable **procedures over one-off declarations**: teach how to approach a class of problems, not the answer to one instance (output templates and fixed constraints are still fine). (agentskills.io spec)
- **SOFT** — Design each skill as a **coherent unit of work**: not so narrow that several must co-load for one task, not so broad it can't activate precisely. (agentskills.io spec)

---

## 4. File Layout & References

Standard directory structure (only `SKILL.md` required):

```
skill-name/
├── SKILL.md          # Required: frontmatter + instructions (L2)
├── references/       # Optional: docs read on demand (L3)
├── assets/           # Optional: templates, schemas, images, data (L3)
├── scripts/          # Optional: executable code (L3)
└── ...               # Any additional files
```

- **HARD** — Use **relative paths from the skill root** when referencing bundled files. (agentskills.io spec; Google ADK)
- **HARD** — Always use **forward slashes** in file paths, never Windows-style backslashes (backslashes break on Unix). (Anthropic)
- **HARD** — Keep file references **one level deep** from `SKILL.md`; avoid nested reference chains (`SKILL.md → advanced.md → details.md`). Nested references cause partial reads (e.g. `head -100` previews) and incomplete information. (Anthropic; agentskills.io spec; Google ADK)
- **SOFT** — Name files descriptively by content (`form_validation_rules.md`, `reference/finance.md`), not generically (`doc2.md`, `file1.md`); organize by domain/variant so only relevant files load. (Anthropic; Google ADK)
- **SOFT** — Reference files **with a load condition**: tell the agent *when* to read each file ("Read `references/api-errors.md` if the API returns a non-200 status"), not a generic "see references/". (agentskills.io spec)
- **SOFT** — For reference files **longer than 100 lines, include a table of contents** at the top, so partial reads still reveal full scope. (Anthropic) — *skill-creator sets this threshold at >300 lines; reconciled in §Conflicts — use the stricter ≥100-line trigger.*

---

## 5. Examples, Workflows & Output Formats

- **SOFT** — Provide **concrete, not abstract** examples; for output-sensitive skills, give input/output pairs (e.g. commit-message Input→Output). (Anthropic; skill-creator)
- **SOFT** — Provide **explicit output templates** when format matters; a literal template is more reliable than prose description. Offer it as strict ("use this exact template") or flexible ("sensible default, adapt as needed") per the task. Long/conditional templates belong in `assets/`. (Anthropic; skill-creator; agentskills.io spec)
- **SOFT** — Break complex tasks into clear sequential steps; supply a **checklist** the agent can copy and tick off, especially when steps have dependencies or validation gates. (Anthropic; agentskills.io spec)
- **SOFT** — Implement **feedback / validation loops**: do work → run a validator (script or reference checklist) → fix → repeat until it passes. The validator may be a script or a reference document. (Anthropic; agentskills.io spec)
- **SOFT** — For batch/destructive/high-stakes operations use **plan-validate-execute**: produce a structured plan, validate it against a source of truth with a verbose script (errors that list available options), then execute. (Anthropic; agentskills.io spec)
- **SOFT** — A **"Gotchas" section** of environment-specific facts that defy reasonable assumptions is high-value; keep it in `SKILL.md`. When you correct an agent mistake, add the correction here. (agentskills.io spec)
- **SOFT** — When inputs can be rendered as images, instruct the agent to analyze them visually. (Anthropic)
- **SOFT** — Use **imperative form** in instructions. (skill-creator)

---

## 6. Scripts & Dependencies

- **SOFT** — Prefer pre-written **utility scripts** over agent-generated code for deterministic/repeated operations: more reliable, token-saving, consistent. If the same logic is reinvented across runs, bundle it once in `scripts/`. (Anthropic; agentskills.io spec)
- **SOFT** — Make **execution intent explicit**: state whether the agent should *run* a script ("Run `analyze_form.py`") or *read it as reference* ("See `analyze_form.py` for the algorithm"). (Anthropic)
- **HARD** — Scripts must **not use interactive prompts**. Agents run in non-interactive shells; a script blocking on TTY input hangs indefinitely. Accept input via CLI flags, environment variables, or stdin. (agentskills.io spec)
- **HARD** — Scripts must implement **`--help`** documenting a description, flags, and usage examples (the agent's primary way to learn the interface). (agentskills.io spec)
- **SOFT** — Scripts should **handle errors explicitly** ("solve, don't punt") and emit helpful, specific error messages that shape the agent's next attempt; handle edge cases gracefully. (Anthropic; agentskills.io spec; Google ADK)
- **SOFT** — **No magic / "voodoo" constants**: document and justify every numeric/config constant. If you don't know the right value, the agent won't either. (Anthropic)
- **SOFT** — Output **structured data** (JSON/CSV/TSV) to stdout; send diagnostics/progress to stderr. Prefer idempotency, meaningful exit codes, `--dry-run` for destructive ops, safe defaults, and predictable output size (paginate or write to `--output` to avoid harness truncation, ~10–30K chars). (agentskills.io spec)
- **SOFT** — Scripts should be self-contained or clearly **declare dependencies** (e.g. Python PEP 723 inline metadata run via `uv run`). (agentskills.io spec; Google ADK)
- **HARD** — Do **not assume packages are installed**: list required packages explicitly in instructions and verify availability. Pin versions in one-off commands (`npx eslint@9.0.0`) and state prerequisites/runtime requirements (use `compatibility` for runtime-level needs). (Anthropic; agentskills.io spec)

### Runtime environment constraints (Anthropic surfaces)

- **HARD** — Runtime capabilities are surface-dependent and govern what a skill may rely on: **Claude API** — no network access, no runtime package installation, pre-configured packages only. **Claude Code** — full network access; global package installation discouraged (install locally). **claude.ai** — network access varies by user/admin settings. (Anthropic)

### MCP tool references

- **HARD** — When referencing MCP tools, use **fully-qualified names** in the format `ServerName:tool_name` (e.g. `BigQuery:bigquery_schema`); unqualified names cause "tool not found" errors when multiple servers are present. (Anthropic)

---

## 7. Terminology, Content Hygiene & Maintenance

- **SOFT** — Use **consistent terminology** throughout: pick one term and reuse it (always "API endpoint", always "field", always "extract"); never mix synonyms. (Anthropic)
- **SOFT** — Avoid **time-sensitive information** in the body. Don't write "before/after August 2025 use…"; instead keep current guidance in the main body and isolate deprecated material in an "old patterns" / legacy section (e.g. a collapsible block). (Anthropic)
- **SOFT** — Prefer **reasoning over rigid directives**: explain *why* a rule matters rather than overusing all-caps `ALWAYS`/`NEVER` (a yellow flag); reframe to "do X because Y causes Z". Generalize from feedback rather than adding overfitted patches. (skill-creator; agentskills.io spec)
- **SOFT** — Iterate with real execution: read execution **transcripts/traces**, not just final outputs. Watch for vague instructions (agent tries several approaches), inapplicable instructions the agent follows anyway, unexpected file-read order, missed references, over-relied-on sections (promote to `SKILL.md`), and ignored files (cut or signal better). (Anthropic; agentskills.io spec)

### Security & trust

- **HARD** — A skill must not contain malware, exploit code, or content that compromises system security; its contents must not surprise the user given the stated intent. ("Roleplay as X" is acceptable; misleading or unauthorized-access skills are not.) (skill-creator; Google ADK)
- **HARD** — Install skills only from **trusted sources**; audit all bundled files (SKILL.md, scripts, images, resources) and code dependencies before use; treat installation like installing software. Skills that fetch from external URLs are high-risk (fetched content may carry injected instructions). Treat generated `SKILL.md` files like a code dependency — review before deploy. (Anthropic; Google ADK)
- **HARD (data-handling note, Anthropic surfaces)** — Agent Skills are not eligible for Zero Data Retention; skill definitions and execution data follow standard retention. (Anthropic)

---

## 8. Evaluation & Testing

### Build-evals-first discipline

- **SOFT** — Create evaluations **before** writing extensive documentation, to ensure the skill solves real, observed gaps. Evaluation-driven flow: (1) run the agent on representative tasks **without** the skill and document failures; (2) build test scenarios for those gaps; (3) establish a baseline; (4) write minimal instructions to pass; (5) iterate. (Anthropic; skill-creator)
- **SOFT** — Create at least **three** evaluation scenarios. (Anthropic) — *skill-creator/agentskills.io phrase the practical starting point as "2–3 test cases"; reconciled in §Conflicts — start with 2–3, reach ≥3.*
- **SOFT** — Test the skill with **all models you plan to use** (e.g. Haiku/Sonnet/Opus); smaller/faster models may need more guidance, larger models may need less over-explaining. (Anthropic)

### Output-quality test cases

- **SOFT** — Store test cases in `evals/evals.json`, each with a realistic `prompt`, an `expected_output` description, optional `files`, and (after first results) `assertions`. Vary phrasing, detail, formality; cover at least one edge case; use realistic context (file paths, column names, personal backstory) — "process this data" is too vague to test. (skill-creator; agentskills.io spec)
- **SOFT** — Run each test case **with the skill and without it** (or vs. a prior version) to get a baseline delta on pass-rate, time, and tokens. Each run starts from a clean context. Capture timing (`total_tokens`, `duration_ms`). (skill-creator; agentskills.io spec)
- **HARD** — `grading.json` assertion results MUST use the exact field names `text`, `passed`, and `evidence` (viewer/tooling depends on them). (skill-creator) — *agentskills.io uses the same three field names inside an `assertion_results` array; this is the canonical grading schema.*
- **SOFT** — Assertions must be **objectively verifiable** and require concrete evidence for a PASS; reject vague assertions ("output is good") and brittle ones ("uses exactly this phrase"). Don't give benefit of the doubt; a present-but-substanceless section is a FAIL. (skill-creator; agentskills.io spec)
- **SOFT** — Analyze patterns: drop assertions that pass in both configurations (non-discriminating), investigate ones that always fail, study ones that pass-with / fail-without (where the skill adds value), tighten instructions on high-variance evals, and inspect time/token outliers. Add a human review pass for issues assertions can't capture. (skill-creator; agentskills.io spec)

### Description-triggering optimization

- **SOFT** — Generate ~**20 trigger eval queries**: 8–10 **should-trigger** (varied phrasing/formality, implicit need, uncommon uses, skill-competition cases) and 8–10 **should-not-trigger** (near-misses sharing keywords but needing something else, adjacent domains, ambiguous phrasing — not obviously irrelevant). Make queries realistic and concrete (file paths, column/company names, URLs, casual phrasing, typos). (skill-creator; agentskills.io spec)
- **SOFT** — Run each query **multiple times** (3 is a reasonable starting point) and compute a **trigger rate**; should-trigger passes when trigger rate > **0.5**, should-not-trigger passes when below it. (skill-creator; agentskills.io spec)
- **SOFT** — Split the query set **~60% train / ~40% validation (held-out test)**, with a proportional should-/should-not mix in each; identify failures only on the train set; select the best description by **validation/test** score to avoid overfitting (best ≠ necessarily last). Avoid adding specific keywords from failed queries (overfitting) — address the general category instead. Keep the description under 1024 chars throughout. ~5 iterations is usually enough. (skill-creator; agentskills.io spec)
- **SOFT** — When optimizing triggering against a live model, use the **model ID powering the current session** so tests match real behavior. (skill-creator)

### Environment-conditional testing (skill-creator, informational)

- Some testing mechanics are environment-gated: with no subagents (e.g. claude.ai) run test cases serially and skip baseline/benchmark/description-optimization/blind-comparison; in headless setups generate a static eval viewer. When **updating** an existing skill, preserve the original `name` (directory and frontmatter unchanged) and copy to a writeable location before editing. (skill-creator)

---

## 9. Tool/Function-Definition Analogues (OpenAI)

OpenAI defines tools/functions and GPT Actions, not `SKILL.md` skills. These rules are included **only** because they sharpen the description/triggering dimension and the discipline of authoring machine-read definitions; map "function/tool/action description" → skill `description`, and treat the rest as out-of-scope for skill validation.

- **HARD (API limit, analogue)** — A function `description` is capped at **1,024 characters** by the API — convergent with the skill `description` limit. (OpenAI — analogue)
- **SOFT (analogue)** — Write clear, detailed names and descriptions; the "intern test": could a human use it correctly given only what the model is given? If not, add the answers. (OpenAI — analogue)
- **SOFT (analogue)** — Put **usage examples in a system-prompt `# Examples` section, not inside the description field**; and never hand-inject tool descriptions into the prompt — supply them through the structured definition. The skill parallel: keep the `description` tight and put examples in the body/`assets`, not crammed into the `description`. (OpenAI — analogue)
- **SOFT (analogue)** — Don't make the model fill in arguments already known from context; pass them in code. (Skill parallel: don't ask the agent to re-derive context the skill already has.) (OpenAI — analogue)
- **SOFT (analogue)** — Add anti-hallucination guidance: "if you lack information to proceed, ask the user" and "do not promise to call/act later — act now or respond normally." (OpenAI — analogue)
- **GPT Actions limits (analogue, out-of-scope for skills; for completeness):** action endpoint `description`/`summary` ≤ **300 chars**; parameter `description` ≤ **700 chars**; request/response payloads < **100,000 chars**; 45-second timeout; TLS 1.2+ on port 443; `operationId` required; `x-openai-isConsequential: true` forces a confirmation prompt (GET defaults to false, others to true when absent). Evaluate Actions with 5–10 representative questions. (OpenAI — analogue) — *These are HTTP/Action-platform constraints, not skill rules; a skill checker SHOULD NOT enforce them.*

---

## 10. Machine-Checkable Rule Summary (for a skill checker)

A validator can enforce these HARD rules directly:

1. `SKILL.md` exists and begins with YAML frontmatter.
2. Frontmatter has non-empty `name` and `description`; no other field is required.
3. `name`: ≤64 chars; `[a-z0-9-]` only; no leading/trailing hyphen; no `--`; equals parent directory name; no XML tags; (Anthropic target only) excludes `anthropic`/`claude`.
4. `description`: 1–1024 chars; no XML tags; contains both what + when (heuristic/LLM check); third person (heuristic).
5. `compatibility` (if present): 1–500 chars. `allowed-tools` treated as experimental.
6. `SKILL.md` body ≤ 500 lines (SOFT budget; warn). L2 ≤ ~5k tokens, L1 ≈ ~100 tokens (SOFT; warn).
7. All file references: relative paths, forward slashes only, one level deep (no nested reference chains).
8. Reference files ≥100 lines include a table of contents (SOFT; warn).
9. MCP tool mentions are `ServerName:tool_name` qualified.
10. Bundled scripts: implement `--help`, no interactive prompts, declared/listed dependencies, no undocumented magic constants (lint-level; partially heuristic).
11. `evals/evals.json` present with prompts; `grading.json` assertion entries use exactly `text`/`passed`/`evidence`.
12. No obvious time-sensitive phrasing outside an "old patterns" section; terminology consistency (heuristic).
