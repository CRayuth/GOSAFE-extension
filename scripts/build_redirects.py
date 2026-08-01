#!/usr/bin/env python3
"""Build DNR $redirect-style rules → local empty stubs (AdGuard MV3 pattern).

Redirects beat a hard block for script/CSS hosts pages expect to "load",
and beat the shell allowlist (priority 900) / full allow (1000) at 1100.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "rules" / "redirects.json"
PRIORITY = 1110

# Tracker / tag hosts that pages often require to return 200.
# Prefer redirect-to-empty over block so onerror handlers stay quiet.
SCRIPT_REDIRECTS = [
    "googletagmanager.com",
    "www.googletagmanager.com",
    "google-analytics.com",
    "www.google-analytics.com",
    "ssl.google-analytics.com",
    "region1.google-analytics.com",
    "click.googleanalytics.com",
    "analytics.google.com",
    "adservice.google.com",
    "pagead2.googlesyndication.com",
    "pagead2.googleadservices.com",
    "afs.googlesyndication.com",
    "static.hotjar.com",
    "script.hotjar.com",
    "cdn.mouseflow.com",
    "cdn.luckyorange.com",
    "js.sentry-cdn.com",
    "browser.sentry-cdn.com",
    "cdn.ravenjs.com",
    "connect.facebook.net",
    "static.ads-twitter.com",
    "platform.twitter.com",
    "snap.licdn.com",
    "px.ads.linkedin.com",
    "scorecardresearch.com",
    "sb.scorecardresearch.com",
    "cdn.taboola.com",
    "cdn.outbrain.com",
    "static.criteo.net",
    "bat.bing.com",
    "clarity.ms",
    "www.clarity.ms",
    "scripts.clarity.ms",
]

IMAGE_REDIRECTS = [
    "pixel.facebook.com",
    "www.facebook.com",  # only used with path filter below — see rules
    "ads.linkedin.com",
    "log.pinterest.com",
    "trk.pinterest.com",
    "t.co",
    "googleads.g.doubleclick.net",
    "ad.doubleclick.net",
    "stats.g.doubleclick.net",
]

# facebook.com pixel beacons use /tr path — handled as urlFilter rules
PIXEL_PATH_RULES = [
    {"urlFilter": "||facebook.com/tr?", "types": ["image", "ping", "xmlhttprequest", "other"]},
    {"urlFilter": "||facebook.com/tr/", "types": ["image", "ping", "xmlhttprequest", "other"]},
    {"urlFilter": "||google-analytics.com/collect", "types": ["image", "ping", "xmlhttprequest", "other"]},
    {"urlFilter": "||google-analytics.com/g/collect", "types": ["image", "ping", "xmlhttprequest", "other"]},
    {"urlFilter": "||analytics.google.com/g/collect", "types": ["image", "ping", "xmlhttprequest", "other"]},
]

RESOURCE_SCRIPT = ["script", "xmlhttprequest", "other"]
RESOURCE_IMAGE = ["image", "ping", "xmlhttprequest", "other"]
RESOURCE_CSS = ["stylesheet"]


def rule(rid: int, domains: list[str] | None, types: list[str], extension_path: str, url_filter: str | None = None) -> dict:
    condition: dict = {"resourceTypes": types}
    if domains:
        condition["requestDomains"] = domains
    if url_filter:
        condition["urlFilter"] = url_filter
    return {
        "id": rid,
        "priority": PRIORITY,
        "action": {
            "type": "redirect",
            "redirect": {"extensionPath": extension_path},
        },
        "condition": condition,
    }


def main() -> None:
    rules: list[dict] = []
    next_id = 1

    # Scripts → empty.js
    rules.append(
        rule(next_id, SCRIPT_REDIRECTS, RESOURCE_SCRIPT, "/web-accessible-resources/redirects/empty.js")
    )
    next_id += 1

    # Stylesheets from tag managers (rare) → empty.css
    rules.append(
        rule(
            next_id,
            ["googletagmanager.com", "www.googletagmanager.com"],
            RESOURCE_CSS,
            "/web-accessible-resources/redirects/empty.css",
        )
    )
    next_id += 1

    # Image / ping pixels → 1x1.gif
    # Skip bare www.facebook.com (too broad) — use path rules instead
    image_hosts = [h for h in IMAGE_REDIRECTS if h not in ("www.facebook.com", "t.co")]
    rules.append(
        rule(next_id, image_hosts, RESOURCE_IMAGE, "/web-accessible-resources/redirects/1x1.gif")
    )
    next_id += 1

    for entry in PIXEL_PATH_RULES:
        rules.append(
            rule(
                next_id,
                None,
                entry["types"],
                "/web-accessible-resources/redirects/1x1.gif",
                url_filter=entry["urlFilter"],
            )
        )
        next_id += 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(rules, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(rules)} redirect rules @ priority {PRIORITY}")


if __name__ == "__main__":
    main()
