"""Merchant name normalization and grouping.

Bank exports spell the same vendor a dozen ways: "Kroger", "KROGER #445",
"KROGER FUEL #4907", "TST*SKYLINE CHILI - MIAM". This module reduces a raw
description to a stable `norm_key` so those variants collapse into one
merchant on the yearly page, without ever rewriting the stored description.

Grouping is deliberately conservative: it only strips noise that is provably
not part of a vendor name (store numbers, payment-processor prefixes, trailing
reference IDs, corporate suffixes). Anything riskier - a shared prefix, a
trailing city name - is offered to the user as a *suggestion* instead.
"""

import re
from difflib import SequenceMatcher

# Payment processors prepend a tag: "TST*", "SQ *", "PY *", "WP*", "PAYPAL *".
_PROCESSOR_PREFIX = re.compile(r"^(?:TST|SQ|SP|PY|WP|WL|PP|PAYPAL|DD|SP|POS|IN)\s*\*+\s*", re.I)

# Web noise: leading "WWW." and trailing ".COM"/".NET"/".CO" style TLDs.
_WWW_PREFIX = re.compile(r"^WWW\.", re.I)
_TLD_SUFFIX = re.compile(r"\.(?:COM|NET|ORG|CO|IO|SHOP)\b", re.I)

# Store numbers: "#445", "# 1197", "STORE 4361".
_STORE_NUM = re.compile(r"#\s*\d+")

# Tokens that are pure noise when they trail (or lead) a vendor name.
_SUFFIX_WORDS = {
    "INC", "LLC", "LTD", "LP", "CORP", "CO", "COMPANY", "THE",
    "ECOMM", "ONLINE", "PURCHASE", "POS", "STORE", "STORES",
    "USA", "US", "PMT", "PAYMENT",
}

# A reference/store id rather than part of the name: "26269", "F26269", "Q35",
# "3629" - a token that is mostly digits.
_ID_TOKEN = re.compile(r"^[A-Z]{0,2}\d{2,}[A-Z]{0,2}\d*$")

# Whole-key rules for brands the generic cleanup cannot reconcile, because the
# bank's string shares no words with the friendly name (AMZN vs Amazon).
# Matched against the squashed key; add rows here as new variants show up.
_BRAND_RULES = [
    (re.compile(r"^(?:AMZN|AMAZON)(?:MKTP|MKTPL|MKT|MARKETPLACE|RETAIL|DIGITAL)?(?:US|USA)?$"), "AMAZON", "Amazon"),
    (re.compile(r"^(?:AMAZON|AMZN)PRIME$|^PRIMEVIDEO$"), "AMAZONPRIME", "Amazon Prime"),
    (re.compile(r"^(?:WALMART|WALMRT|WMSUPERCENTER|WALMARTSUPERCENTER)$"), "WALMART", "Walmart"),
    (re.compile(r"^(?:MCDONALDS?|MCDONALD)$"), "MCDONALDS", "McDonald's"),
    (re.compile(r"^(?:CHICKFILA)$"), "CHICKFILA", "Chick-fil-A"),
    (re.compile(r"^(?:DUNKIN|DUNKINDONUTS)$"), "DUNKIN", "Dunkin'"),
    (re.compile(r"^(?:STARBUCKS|STARBUCKSCAFE|SBUX)$"), "STARBUCKS", "Starbucks"),
    (re.compile(r"^(?:TIKTOK|TIKTOKSHOP)$"), "TIKTOK", "TikTok"),
    (re.compile(r"^(?:THEHOMEDEPOT|HOMEDEPOT)$"), "HOMEDEPOT", "Home Depot"),
]


def _is_noise(word: str) -> bool:
    w = word.upper()
    return bool(_ID_TOKEN.match(w)) or w in _SUFFIX_WORDS


def _clean_words(description: str) -> list[str]:
    """Reduce a raw description to its meaningful word tokens.

    Original casing is kept so the tokens can double as a display name
    ("Once Upon Chd 20288" -> "Once Upon Chd"); callers that need a key
    uppercase the result themselves.
    """
    s = description.strip()
    s = _PROCESSOR_PREFIX.sub("", s)
    s = _WWW_PREFIX.sub("", s)
    s = _TLD_SUFFIX.sub(" ", s)
    s = _STORE_NUM.sub(" ", s)
    # Apostrophes vanish so MCDONALD'S == MCDONALDS; other punctuation splits.
    s = s.replace("'", "").replace("’", "")
    s = re.sub(r"[^A-Za-z0-9]+", " ", s)

    words = s.split()
    # Drop id-ish and boilerplate tokens from the ends only, so a number that
    # is genuinely part of a name ("7 ELEVEN", "FIVE GUYS 1973 ECOMM") is not
    # ripped out of the middle.
    while len(words) > 1 and _is_noise(words[-1]):
        words.pop()
    while len(words) > 1 and _is_noise(words[0]):
        words.pop(0)
    return words


def norm_key(description: str) -> str:
    """Stable grouping key for a raw transaction description.

    Spaces are squashed out because banks are inconsistent about them
    ("OCHARLEYS414HARISON" vs "O CHARLEY S 414").
    """
    key = "".join(w.upper() for w in _clean_words(description))
    for pattern, canonical, _display in _BRAND_RULES:
        if pattern.match(key):
            return canonical
    return key or description.upper().strip()


def brand_display_name(key: str) -> str | None:
    """The friendly name for a key that a brand rule produced, if any."""
    for _pattern, canonical, display in _BRAND_RULES:
        if key == canonical:
            return display
    return None


def display_name(key: str, variants: list[tuple[str, int]]) -> str:
    """Pick what to call a group, given its (description, count) variants.

    Preference order: a curated brand name, then the most-used variant that a
    human clearly typed or the bank title-cased (it has lowercase letters and
    no store number), then the cleaned-up all-caps form.
    """
    brand = brand_display_name(key)
    if brand:
        return brand

    def is_friendly(desc: str) -> bool:
        """A description a person would recognise: someone (or the bank) wrote
        it in mixed case and it carries no store number or reference id."""
        if not any(c.islower() for c in desc):
            return False
        if "#" in desc or "*" in desc:
            return False
        # A bare year in a memo ("Beach Trip 2027") is fine; a longer digit run
        # or a letter-digit blob ("F26269", "Q35") is a store/reference id.
        return not re.search(r"\d{5,}|\d+[A-Za-z]|[A-Za-z]\d{2,}", desc)

    friendly = [(desc, n) for desc, n in variants if is_friendly(desc)]
    if friendly:
        return max(friendly, key=lambda dn: (dn[1], -len(dn[0])))[0]

    if variants:
        # No human-friendly spelling exists; show the cleaned words rather than
        # a raw string full of store numbers. Casing comes from the source, so
        # acronyms (REI, KFC, BMV) are never mangled into "Rei".
        # Prefer the variant that still has its word breaks intact, so
        # "A SPOON FULLA SUGAR" wins over "aspoonfullasugar.co".
        best = max(variants, key=lambda dn: (len(_clean_words(dn[0])), dn[1]))
        words = _clean_words(best[0])
        if words:
            return " ".join(words)
    return key


def group_key(description: str, alias_map: dict[str, str] | None = None) -> str:
    """The key a description groups under, honoring user merges.

    A merged group is keyed by its alias so several norm_keys collapse into one.
    """
    key = norm_key(description)
    alias = (alias_map or {}).get(key)
    return f"alias:{alias.strip().lower()}" if alias else key


def group_merchants(rows: list[dict], alias_map: dict[str, str] | None = None) -> list[dict]:
    """Collapse per-description rows into merchant groups.

    `rows` are dicts with description/count/total. `alias_map` maps a norm_key
    to a user-chosen group name, which both renames a group and merges every
    key pointing at the same name.
    """
    alias_map = alias_map or {}
    groups: dict[str, dict] = {}

    for r in rows:
        key = norm_key(r["description"])
        alias = alias_map.get(key)
        gkey = group_key(r["description"], alias_map)
        g = groups.setdefault(gkey, {
            "key": gkey,
            "alias": alias,
            "keys": set(),
            "count": 0,
            "total": 0.0,
            "variants": [],
        })
        g["keys"].add(key)
        g["count"] += r["count"]
        g["total"] += r["total"]
        g["variants"].append({
            "description": r["description"],
            "count": r["count"],
            "total": round(r["total"], 2),
        })

    out = []
    for g in groups.values():
        variants = sorted(g["variants"], key=lambda v: -v["total"])
        name = g["alias"] or display_name(
            next(iter(g["keys"])), [(v["description"], v["count"]) for v in variants]
        )
        out.append({
            "key": g["key"],
            "description": name,
            "count": g["count"],
            "total": round(g["total"], 2),
            "merged": bool(g["alias"]),
            "variant_count": len(variants),
            "variants": variants,
        })
    out.sort(key=lambda g: -g["total"])
    return out


# --- Fuzzy suggestions -------------------------------------------------------

def _name_quality(group: dict) -> tuple:
    """Rank a group's name for use as the merged name: most used, then most
    readable (mixed case, spaced words, no embedded ids)."""
    name = group["description"]
    return (
        group["count"],
        any(c.islower() for c in name),
        " " in name,
        -len(re.findall(r"\d", name)),
    )


def _similar(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def suggest_merges(groups: list[dict], dismissed: set[frozenset] | None = None) -> list[dict]:
    """Find groups that look like the same vendor but were not merged.

    These are the judgement calls the automatic pass refuses to make on its own
    - a trailing location ("CHICK FIL A ATL"), a squashed-together spelling, a
    near-miss typo - so they are returned for the user to confirm.
    """
    dismissed = dismissed or set()
    suggestions = []

    for i in range(len(groups)):
        for j in range(i + 1, len(groups)):
            a, b = groups[i], groups[j]
            if a["merged"] and b["merged"] and a["key"] == b["key"]:
                continue
            if frozenset((a["key"], b["key"])) in dismissed:
                continue

            ka = re.sub(r"[^A-Z0-9]", "", a["description"].upper())
            kb = re.sub(r"[^A-Z0-9]", "", b["description"].upper())
            if not ka or not kb or ka == kb:
                continue

            short, long_ = (ka, kb) if len(ka) <= len(kb) else (kb, ka)
            reason = None
            if len(short) >= 5 and long_.startswith(short):
                reason = "same name plus a location or department"
            elif len(short) >= 6 and short in long_:
                reason = "one name contains the other"
            elif (len(short) >= 6 and ka[0] == kb[0]
                  and abs(len(ka) - len(kb)) <= 4
                  and _similar(ka, kb) >= 0.87):
                reason = "nearly identical spelling"

            if reason:
                suggestions.append({
                    "keys": [a["key"], b["key"]],
                    "names": [a["description"], b["description"]],
                    "totals": [a["total"], b["total"]],
                    "counts": [a["count"], b["count"]],
                    # Merge into whichever name is used more, preferring a
                    # human-readable spelling when the counts tie.
                    "suggested_name": max((a, b), key=_name_quality)["description"],
                    "reason": reason,
                })

    suggestions.sort(key=lambda s: -(s["totals"][0] + s["totals"][1]))
    return suggestions
