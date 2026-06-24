#!/usr/bin/env python3
"""
lint.py — deterministic content-standards checks, driven by references/rules.json.

These are the mechanical lints (regex/lookup) that need no live graph and no LLM
judgment: naming conventions, description tone/format, value formats, canonical
property names. The judgment-layer calls (is this REALLY a duplicate? should this
column be a relation?) stay with the LLM + ONTOLOGY.md.

Shared with the future graph-health auditor.
"""
from __future__ import annotations
import json
import os
import re
from dataclasses import dataclass, asdict

RULES_PATH = os.path.join(os.path.dirname(__file__), "..", "references", "rules.json")


@dataclass
class Finding:
    severity: str   # 'error' | 'warn' | 'info'
    field: str
    message: str
    value: str = ""

    def to_dict(self):
        return asdict(self)


class Linter:
    def __init__(self, rules_path: str = RULES_PATH):
        with open(rules_path) as f:
            self.rules = json.load(f)

    # ---- names ----
    def lint_entity_name(self, name: str, is_person: bool = False, is_type: bool = False) -> list[Finding]:
        out: list[Finding] = []
        if not name or not name.strip():
            return [Finding("error", "Name", "Name is empty.")]
        nr = self.rules["naming_rules"]["entity_name"]

        if re.search(nr["no_parentheticals"]["flag_regex"], name):
            out.append(Finding("error", "Name", nr["no_parentheticals"]["message"], name))

        if is_person and re.search(nr["people_no_honorifics"]["flag_regex"], name):
            out.append(Finding("error", "Name", nr["people_no_honorifics"]["message"], name))

        # Title Case heuristic on multi-word common-noun names (skip if person/proper-noun-y).
        words = name.split()
        if not is_person and len(words) >= 2:
            cap = [w for w in words[1:] if w[:1].isupper() and w[1:].islower() and len(w) > 3]
            if len(cap) >= 2:
                out.append(Finding("warn", "Name",
                                   f"Looks like Title Case; use sentence case unless these are proper nouns: '{name}'.", name))

        if is_type:
            if name.strip().endswith("s") and not name.strip().endswith("ss"):
                out.append(Finding("warn", "Types", f"Type names should be singular: '{name}'.", name))
        return out

    # ---- descriptions ----
    def lint_description(self, desc: str) -> list[Finding]:
        out: list[Finding] = []
        if not desc or not desc.strip():
            return [Finding("warn", "Description", "Description is empty; sparse entities weaken the graph.")]
        dr = self.rules["description_rules"]

        if re.search(dr["no_leading_article"]["flag_regex"], desc.strip()):
            out.append(Finding("warn", "Description", dr["no_leading_article"]["message"], desc[:60]))

        words = len(re.findall(r"\S+", desc))
        if words > dr["target_max_words"] * 1.4:  # soft ceiling
            out.append(Finding("warn", "Description", f"Description is {words} words; target ~{dr['target_max_words']}.", desc[:60]))

        low = desc.lower()
        hits = [s for s in dr["neutral_tone_superlatives_to_flag"] if s in low]
        if hits:
            out.append(Finding("warn", "Description", f"Promotional/superlative language: {', '.join(hits[:5])}.", desc[:60]))
        return out

    # ---- values ----
    def lint_value(self, value: str, datatype: str, column: str = "") -> list[Finding]:
        out: list[Finding] = []
        if value is None or str(value).strip() == "":
            return out
        v = str(value).strip()
        vr = self.rules["value_format_rules"]
        if datatype == "NUMBER" and re.search(vr["NUMBER"]["flag_regex"], v):
            out.append(Finding("error", column or "NUMBER", "Numbers must be plain: no symbols, separators, or units in the cell.", v))
        if datatype == "TEXT_as_url" and re.search(vr["TEXT_as_url"]["flag_regex_missing_protocol"], v):
            out.append(Finding("warn", column or "URL", "URL should include the protocol (https://).", v))
        return out

    # ---- property headers ----
    def check_property_header(self, header: str) -> Finding | None:
        """Flag a header that looks like a synonym of a canonical property name."""
        canon = self.rules["canonical_property_names"]
        h = header.strip().casefold()
        if header.strip() in canon:
            return None
        # crude synonym hints — the LLM does the real fuzzy/semantic mapping
        synonyms = {
            "url": "Web URL", "site": "Web URL", "homepage": "Web URL", "link": "Web URL",
            "founded": "Year founded", "founding year": "Year founded", "year": "Year founded",
            "twitter": "X", "twitter handle": "X", "tags list": "Tags", "topic": "Topics",
        }
        if h in synonyms:
            return Finding("warn", header, f"Header '{header}' looks like '{synonyms[h]}'; reuse the canonical name so the importer auto-maps it.", header)
        return None

    def relation_entity_flag(self, column: str) -> Finding | None:
        """Flag columns that map to out-of-scope relation-entity properties."""
        oos = {x.casefold() for x in self.rules["relation_entity_properties_v1_out_of_scope"]}
        if column.strip().casefold() in oos:
            return Finding("error", column,
                           "Relation-entity context (carries its own dates/role/findings) — out of scope for CSV v1. "
                           "Route to SDK/geo-publish or manual entry; do not flatten into a bare relation.", column)
        return None


if __name__ == "__main__":
    L = Linter()
    samples_names = [
        ("Ethereum (blockchain)", False, False),
        ("Dr. Jane Smith", True, False),
        ("Developer Tools Platform", False, False),
        ("Companies", False, True),
        ("Vitalik Buterin", True, False),
    ]
    print("== names ==")
    for n, p, t in samples_names:
        for f in L.lint_entity_name(n, p, t):
            print(f"  [{f.severity}] {n!r}: {f.message}")
    print("== descriptions ==")
    for d in ["The leading decentralized indexing protocol that is the best in the world.",
              "Open-source indexing protocol for querying blockchain data via subgraphs."]:
        res = L.lint_description(d)
        print(f"  {d[:40]!r} -> {[f.message for f in res] or 'OK'}")
    print("== headers ==")
    for h in ["Website", "URL", "Twitter", "Year founded", "Founded", "Employment"]:
        f = L.check_property_header(h) or L.relation_entity_flag(h)
        print(f"  {h!r} -> {f.message if f else 'OK'}")
