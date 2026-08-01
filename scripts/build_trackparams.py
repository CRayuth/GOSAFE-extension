#!/usr/bin/env python3
"""Build DNR queryTransform rules from AdGuard URL Tracking filter ($removeparam).

Chrome applies only ONE redirect transform per request, so we merge all literal
parameter names into a small number of global rules (large removeParams arrays).
Regex removeparam forms are skipped (not expressible in DNR).
"""

from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "rules" / "trackparams.json"
CACHE = ROOT.parent / "extension-cache" / "adguard-trackparam.txt"
SOURCE = (
    "https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/"
    "master/filters/filter_17_TrackParam/filter.txt"
)
PRIORITY = 500
# One rule: Chrome applies only a single redirect transform per request.
PARAMS_PER_RULE = 5000
# Always include these even if the list omits them
CORE_PARAMS = (
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
    "utm_name",
    "utm_reader",
    "utm_social",
    "utm_social-type",
    "utm_place",
    "utm_userid",
    "utm_channel",
    "fbclid",
    "gclid",
    "gclsrc",
    "dclid",
    "gbraid",
    "wbraid",
    "msclkid",
    "mc_eid",
    "mc_cid",
    "yclid",
    "ymclid",
    "ysclid",
    "twclid",
    "igshid",
    "igsh",
    "ttclid",
    "tbclid",
    "li_fat_id",
    "vero_id",
    "vero_conv",
    "mc_",
    "mkt_tok",
    "oly_anon_id",
    "oly_enc_id",
    "_openstat",
    "rb_clickid",
    "s_cid",
    "nlid",
    "srsltid",
    "sxidn",
)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0.0.0 Safari/537.36"
)

# $removeparam=name  or  ||domain^$removeparam=name  or  $removeparam=/regex/
LITERAL_RE = re.compile(
    r"(?:\|\|([a-z0-9.-]+)\^)?\$removeparam(?:=|/)?(?!/)([A-Za-z0-9_.%-]+)\s*$",
    re.I,
)

RESOURCE_TYPES = [
    "main_frame",
    "sub_frame",
    "xmlhttprequest",
    "ping",
    "other",
]

# Do not strip query params on these hosts (friend/fr flows, LMS ids, etc.)
EXCLUDE_DOMAINS = [
    "edu.kh",
    "ccun.edu.kh",
    "moodle.ccun.edu.kh",
    "instructure.com",
    "canvaslms.com",
    "blackboard.com",
    "brightspace.com",
    "schoology.com",
    "facebook.com",
    "fb.com",
    "messenger.com",
    "instagram.com",
    "meta.com",
    "threads.net",
    "whatsapp.com",
]


def fetch() -> str:
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    if CACHE.exists():
        print(f"Using cached {CACHE.name}")
        return CACHE.read_text(encoding="utf-8", errors="replace")
    print(f"Downloading {SOURCE}")
    req = urllib.request.Request(SOURCE, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=180) as resp:
        text = resp.read().decode("utf-8", errors="replace")
    CACHE.write_text(text, encoding="utf-8")
    print(f"  saved {CACHE.name} ({len(text):,} bytes)")
    return text


def collect_params(text: str) -> set[str]:
    params: set[str] = set(CORE_PARAMS)
    skipped_regex = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("!") or line.startswith("["):
            continue
        if "removeparam" not in line.lower():
            continue
        # Regex form: $removeparam=/.../
        if re.search(r"removeparam\s*=\s*/", line, re.I) or re.search(
            r"removeparam\s*/", line, re.I
        ):
            skipped_regex += 1
            continue
        m = LITERAL_RE.search(line)
        if not m:
            # Also accept bare $removeparam=foo mid-options
            m2 = re.search(r"removeparam=([A-Za-z0-9_.%-]+)", line, re.I)
            if not m2:
                continue
            name = m2.group(1)
        else:
            name = m.group(2)
        name = name.strip()
        if not name or name.startswith("/") or len(name) > 80:
            continue
        # DNR removeParams are exact keys; skip wildcards
        if "*" in name or "?" in name:
            continue
        params.add(name)
    print(f"Literal tracking params: {len(params):,} (skipped {skipped_regex:,} regex rules)")
    return params


def make_rules(params: set[str]) -> list[dict]:
    # Prefer core params first, then the rest alphabetically (single rule wins in Chrome).
    core = [p for p in CORE_PARAMS if p in params]
    rest = sorted((params - set(core)), key=lambda s: (s.lower(), s))
    ordered = list(dict.fromkeys([*core, *rest]))
    rules = []
    for i in range(0, len(ordered), PARAMS_PER_RULE):
        batch = ordered[i : i + PARAMS_PER_RULE]
        rules.append(
            {
                "id": len(rules) + 1,
                "priority": PRIORITY,
                "action": {
                    "type": "redirect",
                    "redirect": {
                        "transform": {
                            "queryTransform": {
                                "removeParams": batch,
                            }
                        }
                    },
                },
                "condition": {
                    "resourceTypes": RESOURCE_TYPES,
                    "urlFilter": "?",
                    "excludedRequestDomains": list(EXCLUDE_DOMAINS),
                    "excludedInitiatorDomains": list(EXCLUDE_DOMAINS),
                },
            }
        )
    return rules


def main() -> None:
    text = fetch()
    params = collect_params(text)
    rules = make_rules(params)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(rules, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(rules)} rules, {len(params)} params @ priority {PRIORITY}")
    print(
        "Note: Chrome applies one redirect transform per request — "
        "only the highest-priority matching trackparams rule runs. "
        "Core/common params are packed into rule id 1 first."
    )


if __name__ == "__main__":
    main()
