#!/usr/bin/env python3
"""Build high-priority DNR rules from d3ward's d3host list.

Priority 1100 beats the hand-tuned allowlist (1000) so tracker subdomains
on google.com / apple.com / amazonaws.com / etc. still block on the
https://d3ward.github.io/toolz/adblock test.
"""

from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "rules" / "d3host.json"
SOURCE = "https://raw.githubusercontent.com/d3ward/toolz/master/src/d3host.txt"
PRIORITY = 1100
DOMAINS_PER_RULE = 50
RESOURCE_TYPES = [
    "main_frame",
    "sub_frame",
    "stylesheet",
    "script",
    "image",
    "font",
    "object",
    "xmlhttprequest",
    "ping",
    "media",
    "websocket",
    "webtransport",
    "webbundle",
    "other",
]

DOMAIN_RE = re.compile(
    r"^(?:0\.0\.0\.0\s+|127\.0\.0\.1\s+)?"
    r"([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,})\s*$",
    re.I | re.M,
)


def fetch_domains() -> list[str]:
    req = urllib.request.Request(
        SOURCE,
        headers={"User-Agent": "GOSAFE-adblock/d3host-builder"},
    )
    text = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
    return sorted({m.group(1).lower() for m in DOMAIN_RE.finditer(text)})


def make_rules(domains: list[str]) -> list[dict]:
    rules = []
    for i in range(0, len(domains), DOMAINS_PER_RULE):
        batch = domains[i : i + DOMAINS_PER_RULE]
        rules.append(
            {
                "id": len(rules) + 1,
                "priority": PRIORITY,
                "action": {"type": "block"},
                "condition": {
                    "requestDomains": batch,
                    "resourceTypes": RESOURCE_TYPES,
                },
            }
        )
    return rules


def main() -> None:
    domains = fetch_domains()
    if not domains:
        raise SystemExit("No domains parsed from d3host list")
    rules = make_rules(domains)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(rules, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(domains)} domains, {len(rules)} rules @ priority {PRIORITY}")


if __name__ == "__main__":
    main()
