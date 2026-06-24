# Candidate extraction prompt (Stage 2 — NER)

Input: `harvest.json` (News stories + episodes, each with `claims[]`, `topics[]`, `name`).
Output: a deduplicated list of candidate named entities to diagnose.

## Prompt

> From the claim text and story titles in the harvest, extract every **named entity**
> that could be a first-class Geo entity. Include:
> - **Organizations / labs / companies** (OpenAI, SK Hynix, a startup just funded)
> - **Models / model families** (a newly released or teased model)
> - **Products / tools / programs** (a launched product, a named initiative)
> - **People** only if they are the subject of substantive claims (a founder, a researcher) —
>   not every name mentioned in passing.
>
> For each candidate record:
> - `name` — the cleanest canonical form (no honorifics, no "Inc.", sentence-appropriate).
>   Collapse variants ("MiniMax Group Inc." → "MiniMax").
> - `velocity` — how many distinct claims across the harvest mention it.
> - a one-line `note` — what it is / why it appeared (helps later relevance judgment).
>
> Rules:
> - **Deduplicate aggressively.** One row per real-world thing.
> - **Drop pure noise** — generic concepts ("AI", "data"), media outlets only quoted as
>   sources, and clearly off-domain entities (geopolitics, sports) unless central to the space.
> - **Do not coverage-check or judge gaps here** — that's Stage 3. Just extract candidates.
> - Prefer recall at this stage; the relevance gate (Stage 4) prunes.

## Output shape
```json
[
  {"name": "XCENA", "velocity": 14, "note": "memory-chip startup, $135M raise, MX1 chip"},
  {"name": "Mythos", "velocity": 4, "note": "Anthropic's teased upcoming model"}
]
```
