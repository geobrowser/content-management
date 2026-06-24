# Copyright + licensing for descriptions

Educational best-practice to keep `geo-describe` output original. **Not legal advice**; when a
case is unclear, flag for a human. The engineering rule of thumb: **reuse facts freely, never
reuse expression.**

## Principles

- **Idea–expression distinction.** Copyright protects the *expression* (wording, selection,
  arrangement), not facts or ideas. Re-state facts in independent wording and you're clear; track
  the source's phrasing and you're not.
- **Originality = independent creation + minimal creativity** (*Feist v. Rural*, 1991: "no one may
  claim originality as to facts"; effort alone — "sweat of the brow" — earns no protection).
- **Substantial similarity** is the practical infringement test: unprotectable elements (facts,
  stock phrasing, merged idea/expression) are filtered out, then the rest is compared.
  **Merger doctrine:** a bare fact with only a few ways to state it isn't protectable, so
  near-identical phrasing of a *fact* is low-risk — but a distinctive descriptive sentence is high-risk.
- **Attribution does not cure copying.** Citing a source handles plagiarism (ethics), not
  copyright. You can attribute and still infringe.

## Source licensing → what you may do

| License | Expression | Facts | Obligation |
|---|---|---|---|
| Public domain | reusable | reusable | none (plagiarism norms only) |
| CC BY-SA (e.g. Wikipedia) | reuse triggers obligations | free | attribution + share-alike + "indicate changes" + license link |
| All-rights-reserved (blurbs, press, proprietary) | not reusable | free | re-express + verify low overlap |

**Key nuance for scraped open sources (Wikipedia etc.):** CC BY-SA obligations attach to reusing
copyrightable **expression**. If you extract only the **facts** and write a genuinely independent
description, you are using the uncopyrightable layer and share-alike does not attach to the facts.
The safe posture for license-free output: treat the source strictly as a **fact source**,
re-express, and verify low textual overlap (Stage 5) — rather than relying on share-alike compliance.

## What to do in the skill
- Default: extract facts → compose with the source closed → pass the closeness gate. That output
  is original regardless of the source license.
- If output *does* reuse CC BY-SA expression (avoid this), surface attribution + share-alike +
  change-notice + license-link to the human reviewer.
- If licensing is unknown or the source looks like distinctive creative prose, lower the overlap
  tolerance and flag for review.

## Sources
Copyright Alliance (what's not protected); *Feist Publications v. Rural Telephone* (Justia, Cornell
LII); Idea–expression distinction & Substantial similarity (Wikipedia); Wikipedia: Reusing Wikipedia
content / Wikipedia:Copyrights; JHU paraphrasing & summarizing guide. Full URLs in the task's
`findings-copyright-rewrite.md`.
