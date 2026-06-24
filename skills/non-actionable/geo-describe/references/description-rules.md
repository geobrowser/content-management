# Geo description rules

The standard a `geo-describe` output must meet (Stage 4 compose + Stage 5 rules check).
Source of truth: Geo `ONTOLOGY.md` content standards + Armando's spec. Validate FORM here;
the facts are validated separately in Stage 3.

## Rules

1. **Don't lead with the entity name** or restate it redundantly. The name is shown next to the
   description in the preview, so repeating it wastes the ~50 words.
2. **Concise — one or two short sentences, ~50 words**, designed for the preview.
3. **Informative** — cover **what it is** and **why it matters** (significance/role), with key
   details relevant to the entity.
4. **Neutral tone** — third person; avoid overly positive or negative / promotional language.
5. **Don't repeat property data** that lives in structured fields (founding date, ticker, URL,
   counts) — the description complements properties, it doesn't duplicate them.
6. **Don't start with an article** ("A …", "The …") or a bare pronoun.

## Good vs. bad (input → output)

**Entity:** `Solidity` (type: Programming language). **Source blurb:** "Solidity is an
object-oriented, high-level language for implementing smart contracts on various blockchain
platforms, most notably Ethereum."

- ❌ *Leads with name + near-verbatim:* "Solidity is an object-oriented, high-level language for
  implementing smart contracts on blockchain platforms, most notably Ethereum." (copies expression
  AND starts with the name)
- ✅ *Re-expressed, no name, what + why:* "Object-oriented language for writing smart contracts,
  used most widely on Ethereum; the dominant choice for EVM contract development." (~25 words,
  neutral, doesn't lead with the name, says what + why it matters)

**Entity:** `Dune` (type: Book). **Source:** a publisher blurb with distinctive marketing prose.

- ❌ *Patchwritten (synonyms over the source skeleton):* fails — still substantially similar.
- ✅ *Fact-first:* "1965 science-fiction novel by Frank Herbert set on the desert planet Arrakis;
  a foundational work of the genre and the basis for multiple film adaptations." (facts only,
  original phrasing; the year/author may also be structured properties — keep the description's
  framing, don't just echo fields).

## Quick check (Stage 5 rules pass)
- [ ] 1–2 sentences, ≤ ~50 words
- [ ] does not start with the entity name, an article, or a pronoun
- [ ] states what it is **and** why it matters
- [ ] neutral, third person, no promo language
- [ ] doesn't duplicate structured property data
