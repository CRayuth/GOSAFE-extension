#!/usr/bin/env python3
"""Build Chrome DNR rulesets + cosmetic filters from multiple lists."""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse
import csv

ROOT = Path(__file__).resolve().parents[1]
RULES_DIR = ROOT / "rules"
# Keep downloads OUTSIDE the extension package (Load unpacked includes every file).
CACHE_DIR = ROOT.parent / "extension-cache"
CSV_DIR = CACHE_DIR / "csv"
CSV_QUARANTINE_DIR = CACHE_DIR / "csv-quarantine"
MANIFEST_PATH = ROOT / "manifest.json"
COSMETICS_PATH = ROOT / "cosmetics-data.json"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0.0.0 Safari/537.36"
)

SOURCES_FULL = [
    {
        "id": "adguard_dns",
        "name": "AdGuard DNS filter",
        "url": "https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt",
        "cache": CACHE_DIR / "adguard_filter.txt",
        "format": "adblock",
        "cosmetics": False,
    },
    {
        "id": "oisd_big",
        "name": "OISD big (safe)",
        "url": "https://raw.githubusercontent.com/cbuijs/oisd/master/big/domains.safe",
        "cache": CACHE_DIR / "oisd_big_safe.txt",
        "format": "domains",
        "cosmetics": False,
    },
    {
        "id": "easylist",
        "name": "EasyList",
        "url": "https://easylist.to/easylist/easylist.txt",
        "cache": CACHE_DIR / "easylist.txt",
        "format": "adblock",
        "cosmetics": True,
    },
    {
        "id": "easyprivacy",
        "name": "EasyPrivacy",
        "url": "https://easylist.to/easylist/easyprivacy.txt",
        "cache": CACHE_DIR / "easyprivacy.txt",
        "format": "adblock",
        "cosmetics": True,
    },
    {
        "id": "fanboy_cookie",
        "name": "Fanboy Cookie Monster",
        "url": "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt",
        "cache": CACHE_DIR / "fanboy-cookiemonster.txt",
        "format": "adblock",
        "cosmetics": True,
    },
    {
        "id": "fanboy_annoyance",
        "name": "Fanboy Annoyance",
        "url": "https://secure.fanboy.co.nz/fanboy-annoyance.txt",
        "cache": CACHE_DIR / "fanboy-annoyance.txt",
        "format": "adblock",
        "cosmetics": False,
    },
    {
        "id": "fanboy_social",
        "name": "Fanboy Social",
        "url": "https://easylist.to/easylist/fanboy-social.txt",
        "cache": CACHE_DIR / "fanboy-social.txt",
        "format": "adblock",
        "cosmetics": True,
    },
    {
        "id": "goodbyeads",
        "name": "GoodbyeAds",
        "url": "https://raw.githubusercontent.com/jerryn70/GoodbyeAds/master/Hosts/GoodbyeAds.txt",
        "cache": CACHE_DIR / "goodbyeads.txt",
        "format": "hosts",
        "cosmetics": False,
    },
    {
        "id": "stevenblack_hosts",
        "name": "StevenBlack hosts",
        "url": "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts",
        "cache": CACHE_DIR / "stevenblack-hosts.txt",
        "format": "hosts",
        "cosmetics": False,
    },
    {
        "id": "hagezi_pro",
        "name": "HaGeZi Pro DNS",
        "url": "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt",
        "cache": CACHE_DIR / "hagezi-pro.txt",
        "format": "adblock",
        "cosmetics": False,
    },
]

# Lists aligned with uBlock Origin defaults (https://github.com/gorhill/uBlock)
# — we consume public EasyList-syntax lists, not uBO's proprietary engine.
UBO_DEFAULT_EXTRAS = [
    {
        "id": "ubo_filters",
        "name": "uBlock filters",
        "url": "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt",
        "cache": CACHE_DIR / "ubo-filters.txt",
        "format": "adblock",
        "cosmetics": True,
    },
    {
        "id": "ubo_badware",
        "name": "uBlock filters — Badware risks",
        "url": "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt",
        "cache": CACHE_DIR / "ubo-badware.txt",
        "format": "adblock",
        "cosmetics": False,
    },
    {
        "id": "ubo_privacy",
        "name": "uBlock filters — Privacy",
        "url": "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt",
        "cache": CACHE_DIR / "ubo-privacy.txt",
        "format": "adblock",
        "cosmetics": True,
    },
    {
        "id": "ubo_quickfixes",
        "name": "uBlock filters — Quick fixes",
        "url": "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt",
        "cache": CACHE_DIR / "ubo-quick-fixes.txt",
        "format": "adblock",
        "cosmetics": True,
    },
    {
        "id": "ubo_unbreak",
        "name": "uBlock filters — Unbreak",
        "url": "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt",
        "cache": CACHE_DIR / "ubo-unbreak.txt",
        "format": "adblock",
        "cosmetics": True,
    },
    {
        "id": "peter_lowe",
        "name": "Peter Lowe's Ad and tracking server list",
        "url": "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext",
        "cache": CACHE_DIR / "peter-lowe-hosts.txt",
        "format": "hosts",
        "cosmetics": False,
    },
    {
        "id": "urlhaus",
        "name": "Online Malicious URL Blocklist (URLhaus)",
        "url": "https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-hosts-online.txt",
        "cache": CACHE_DIR / "urlhaus-hosts.txt",
        "format": "hosts",
        "cosmetics": False,
    },
]

SOURCES_FULL = SOURCES_FULL + UBO_DEFAULT_EXTRAS

# Default profile: lean DNS + EasyList stack + uBO default extras (still capped).
SOURCES_LITE = [
    {
        "id": "hagezi_promini",
        "name": "HaGeZi Pro Mini",
        "url": "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.mini.txt",
        "cache": CACHE_DIR / "hagezi-pro-mini.txt",
        "format": "adblock",
        "cosmetics": False,
    },
    {
        "id": "easylist",
        "name": "EasyList",
        "url": "https://easylist.to/easylist/easylist.txt",
        "cache": CACHE_DIR / "easylist.txt",
        "format": "adblock",
        "cosmetics": True,
    },
    {
        "id": "easyprivacy",
        "name": "EasyPrivacy",
        "url": "https://easylist.to/easylist/easyprivacy.txt",
        "cache": CACHE_DIR / "easyprivacy.txt",
        "format": "adblock",
        "cosmetics": True,
    },
    {
        "id": "fanboy_cookie",
        "name": "Fanboy Cookie Monster",
        "url": "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt",
        "cache": CACHE_DIR / "fanboy-cookiemonster.txt",
        "format": "adblock",
        "cosmetics": True,
    },
] + UBO_DEFAULT_EXTRAS

SOURCES = SOURCES_LITE

DOMAINS_PER_RULE = 4000
RULES_PER_RULESET = 40
URLFILTER_PER_RULESET = 6000
MAX_URLFILTER_RULES = 6000
MAX_GENERIC_COSMETICS = 12000
MAX_SPECIFIC_HOSTS = 8000
MAX_SELECTORS_PER_HOST = 40

# Compact list - repeated on every rule, so keep short.
RESOURCE_TYPES = [
    "sub_frame",
    "script",
    "image",
    "xmlhttprequest",
    "ping",
    "media",
    "websocket",
    "other",
]

TYPE_MAP = {
    "script": ["script"],
    "image": ["image"],
    "stylesheet": ["stylesheet"],
    "object": ["object"],
    "xmlhttprequest": ["xmlhttprequest"],
    "xhr": ["xmlhttprequest"],
    "subdocument": ["sub_frame"],
    "ping": ["ping"],
    "media": ["media"],
    "font": ["font"],
    "websocket": ["websocket"],
    "other": ["other"],
}

DOMAIN_RULE_RE = re.compile(
    r"^(@@)?\|\|([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]{1,63})+)\^(\$.*)?$",
    re.IGNORECASE,
)

# ||domain^path or ||domain/path with optional $options
PATH_DOMAIN_RE = re.compile(
    r"^(@@)?\|\|([a-z0-9.-]+[a-z0-9])\^([^\s\$]*)(\$.*)?$",
    re.IGNORECASE,
)
PATH_DOMAIN_SLASH_RE = re.compile(
    r"^(@@)?\|\|([a-z0-9.-]+[a-z0-9])(/[^\s\$]*)(\$.*)?$",
    re.IGNORECASE,
)

# Generic path/token rules like -ad.jpg$image
GENERIC_PATH_RE = re.compile(r"^(@@)?([^\s\|\$][^\s\$]*)(\$.*)?$")

COSMETIC_RE = re.compile(r"^(@@)?(.*?)(#@?#|#\?#|##)(.+)$")

ALLOWLIST_SUFFIXES = (
    "youtube.com",
    "youtube-nocookie.com",
    "youtu.be",
    "ytimg.com",
    "googlevideo.com",
    "ggpht.com",
    "googleusercontent.com",
    "gstatic.com",
    "googleapis.com",
    "google.com",
    "gvt1.com",
    "withgoogle.com",
    "yt3.ggpht.com",
    # Streaming / embed hosts (sites break if these are blocked)
    "animesalt.link",
    "abyss.to",
    "short.icu",
    "mystream.to",
    "filemoon.sx",
    "filemoon.to",
    "streamtape.com",
    "streamwish.to",
    "doodstream.com",
    "dood.watch",
    "mp4upload.com",
    "voe.sx",
    "mixdrop.co",
    "rabbitstream.net",
    "megacloud.tv",
    "vidsrc.to",
    "vidsrc.me",
    "kwik.cx",
    "jwplayer.com",
    "jwpcdn.com",
    "p.jwpcdn.com",
    "b-cdn.net",
    "bunnycdn.com",
    "mediadelivery.net",
    "cdn.jsdelivr.net",
    "cdnjs.cloudflare.com",
    "medium.com",
    "medium.systems",
    "medium.build",
    "khfullhd.co",
    "khanime.co",
    "canva.com",
    "canva.site",
    "canva.me",
    "canvausercontent.com",
    "canva-apps.com",
    # Major sites — never block from noisy phishing CSVs
    "google.com",
    "gmail.com",
    "gstatic.com",
    "googleapis.com",
    "googleusercontent.com",
    "facebook.com",
    "instagram.com",
    "whatsapp.com",
    "messenger.com",
    "meta.com",
    "twitter.com",
    "x.com",
    "t.co",
    "linkedin.com",
    "microsoft.com",
    "live.com",
    "office.com",
    "office365.com",
    "microsoftonline.com",
    "apple.com",
    "icloud.com",
    "amazon.com",
    "amazonaws.com",
    "netflix.com",
    "spotify.com",
    "github.com",
    "githubusercontent.com",
    "gitlab.com",
    "stackoverflow.com",
    "reddit.com",
    "wikipedia.org",
    "wikimedia.org",
    "cloudflare.com",
    "cloudflareinsights.com",
    "paypal.com",
    "stripe.com",
    "dropbox.com",
    "notion.so",
    "figma.com",
    "slack.com",
    "zoom.us",
    "discord.com",
    "twitch.tv",
    "tiktok.com",
    "pinterest.com",
    "adobe.com",
    "openai.com",
    "chatgpt.com",
    "anthropic.com",
    "cursor.com",
    "vercel.com",
    "netlify.com",
)


def fresh() -> bool:
    return "--fresh" in sys.argv


def with_csv() -> bool:
    """Phishing CSVs are opt-in — many public datasets mislabel legit sites."""
    return "--with-csv" in sys.argv


def build_profile() -> str:
    for arg in sys.argv[1:]:
        if arg.startswith("--profile="):
            return arg.split("=", 1)[1].strip().lower() or "lite"
        if arg == "--full":
            return "full"
        if arg == "--lite":
            return "lite"
    if "--profile" in sys.argv:
        i = sys.argv.index("--profile")
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1].strip().lower() or "lite"
    return "lite"


def apply_profile() -> str:
    global SOURCES, MAX_URLFILTER_RULES, MAX_GENERIC_COSMETICS, MAX_SPECIFIC_HOSTS
    profile = build_profile()
    if profile == "full":
        SOURCES = SOURCES_FULL
        MAX_URLFILTER_RULES = 8000
        MAX_GENERIC_COSMETICS = 20000
        MAX_SPECIFIC_HOSTS = 12000
    else:
        SOURCES = SOURCES_LITE
        MAX_URLFILTER_RULES = 6000
        MAX_GENERIC_COSMETICS = 12000
        MAX_SPECIFIC_HOSTS = 8000
        profile = "lite"
    print(f"Build profile: {profile} ({len(SOURCES)} sources)")
    return profile


def is_allowlisted(domain: str) -> bool:
    d = domain.lower().rstrip(".")
    for suffix in ALLOWLIST_SUFFIXES:
        if d == suffix or d.endswith("." + suffix):
            return True
    return False


# Never promote these to a global DNR allow — EasyList often has @@…$domain=site.com
# exceptions that must stay site-scoped (otherwise trackers always load).
TRACKER_ALLOW_FORBIDDEN = (
    "sentry",
    "analytics",
    "hotjar",
    "bugsnag",
    "doubleclick",
    "googletagmanager",
    "google-analytics",
    "googleadservices",
    "pagead",
    "adsense",
    "adservice",
    "facebook.net",
    "scorecardresearch",
    "adnxs",
    "adsrvr",
    "taboola",
    "outbrain",
    "criteo",
    "moatads",
    "amazon-adsystem",
)


def is_forbidden_global_allow(domain: str) -> bool:
    d = domain.lower().rstrip(".")
    return any(token in d for token in TRACKER_ALLOW_FORBIDDEN)


def download(url: str, dest: Path) -> str:
    print(f"Downloading {url}")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = resp.read().decode("utf-8", errors="replace")
    dest.write_text(data, encoding="utf-8")
    print(f"  saved {dest.name} ({len(data):,} bytes)")
    return data


def load_source(source: dict) -> str:
    cache: Path = source["cache"]
    if cache.exists() and not fresh():
        print(f"Using cached {cache.name}")
        return cache.read_text(encoding="utf-8", errors="replace")
    return download(source["url"], cache)


def is_valid_domain(domain: str) -> bool:
    if not domain or len(domain) > 253:
        return False
    if domain.startswith(".") or domain.endswith(".") or ".." in domain:
        return False
    labels = domain.split(".")
    if len(labels) < 2:
        return False
    for label in labels:
        if not label or len(label) > 63:
            return False
        if label.startswith("-") or label.endswith("-"):
            return False
        if not re.fullmatch(r"[a-z0-9-]+", label, re.IGNORECASE):
            return False
    return True


def parse_options(options: str | None) -> dict:
    result = {
        "third_party": False,
        "first_party": False,
        "types": None,
        "skip": False,
        "domains": [],
        "excluded_domains": [],
    }
    if not options:
        return result
    opts = options[1:] if options.startswith("$") else options
    for part in opts.split(","):
        p = part.strip().lower()
        if not p:
            continue
        if p in {"badfilter", "popup", "csp", "elemhide", "generichide", "genericblock", "document", "doc", "mp4", "empty", "rewrite"}:
            result["skip"] = True
            return result
        if p.startswith("rewrite="):
            result["skip"] = True
            return result
        if p == "third-party" or p == "3p":
            result["third_party"] = True
        elif p in {"~third-party", "first-party", "1p"}:
            result["first_party"] = True
        elif p.startswith("domain="):
            for d in p[7:].split("|"):
                d = d.strip().lower()
                if not d:
                    continue
                if d.startswith("~"):
                    result["excluded_domains"].append(d[1:])
                else:
                    result["domains"].append(d)
        elif p.startswith("~"):
            # negated type - ignore whole rule if complex
            continue
        elif p in TYPE_MAP:
            result["types"] = (result["types"] or []) + TYPE_MAP[p]
    return result


def urlfilter_safe(pattern: str) -> bool:
    if not pattern or len(pattern) > 1000:
        return False
    # DNR urlFilter does not support regex; reject control chars / unbalanced weirdness.
    if any(ch in pattern for ch in "\n\r\t"):
        return False
    if pattern.startswith("/") and pattern.endswith("/") and len(pattern) > 2:
        return False
    return True


def parse_adblock(text: str, collect_cosmetics: bool):
    block: set[str] = set()
    allow: set[str] = set()
    url_block: list[dict] = []
    url_allow: list[dict] = []
    generic: set[str] = set()
    specific: dict[str, set[str]] = defaultdict(set)
    skipped = 0

    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("!") or line.startswith("["):
            continue

        # Cosmetic filters
        if "##" in line or "#@#" in line or "#?#" in line:
            if not collect_cosmetics:
                skipped += 1
                continue
            # Skip procedural / scriptlet cosmetics
            if "#$#" in line or "#%#" in line or "#?#" in line:
                skipped += 1
                continue
            m = COSMETIC_RE.match(line)
            if not m:
                skipped += 1
                continue
            _exc, domains_part, sep, selector = m.groups()
            selector = selector.strip()
            if not selector or len(selector) > 500:
                skipped += 1
                continue
            # Avoid extremely broad attribute substring selectors that break players.
            if re.search(r"\[class\*=['\"]?\s*ad-", selector, re.I):
                skipped += 1
                continue
            is_exception = sep == "#@#"
            if is_exception:
                skipped += 1
                continue
            domains_part = domains_part.strip().lower()
            if not domains_part:
                generic.add(selector)
            else:
                for d in domains_part.split(","):
                    d = d.strip()
                    if not d or d.startswith("~"):
                        continue
                    if is_valid_domain(d) or "." in d:
                        specific[d].add(selector)
            continue

        # Pure domain network rules
        m = DOMAIN_RULE_RE.match(line)
        if m:
            is_exception, domain, opts = m.groups()
            domain = domain.lower().rstrip(".")
            parsed = parse_options(opts)
            if parsed["skip"] or not is_valid_domain(domain):
                skipped += 1
                continue
            if is_allowlisted(domain):
                skipped += 1
                continue
            if is_exception:
                # @@||tracker.com^$domain=foo.com must NOT become a global allow.
                if parsed.get("domains") or is_forbidden_global_allow(domain):
                    skipped += 1
                    continue
                allow.add(domain)
            else:
                # Domain-wide block (ignore type narrowing for domain batching)
                block.add(domain)
            continue

        # ||domain^path or ||domain/path -> urlFilter
        m = PATH_DOMAIN_RE.match(line) or PATH_DOMAIN_SLASH_RE.match(line)
        if m:
            is_exception, domain, path, opts = m.groups()
            domain = domain.lower().rstrip(".")
            parsed = parse_options(opts)
            if parsed["skip"] or not is_valid_domain(domain) or is_allowlisted(domain):
                skipped += 1
                continue
            path = path or ""
            if path.startswith("^"):
                path = path[1:]
            uf = f"||{domain}^"
            if path:
                # Chrome urlFilter: ||domain^path works similarly
                uf = f"||{domain}^{path.lstrip('^')}" if not path.startswith("/") else f"||{domain}{path}"
            if not urlfilter_safe(uf):
                skipped += 1
                continue
            rule = {
                "urlFilter": uf,
                "resourceTypes": parsed["types"] or RESOURCE_TYPES,
            }
            if parsed["third_party"] and not parsed["first_party"]:
                rule["domainType"] = "thirdParty"
            elif parsed["first_party"] and not parsed["third_party"]:
                rule["domainType"] = "firstParty"
            if parsed["domains"]:
                rule["initiatorDomains"] = [d for d in parsed["domains"] if is_valid_domain(d)][:50]
            if parsed["excluded_domains"]:
                rule["excludedInitiatorDomains"] = [
                    d for d in parsed["excluded_domains"] if is_valid_domain(d)
                ][:50]
            (url_allow if is_exception else url_block).append(rule)
            continue

        # Generic path token rules (no leading ||)
        m = GENERIC_PATH_RE.match(line)
        if m and not line.startswith("|"):
            is_exception, pattern, opts = m.groups()
            parsed = parse_options(opts)
            if parsed["skip"] or is_exception:
                skipped += 1
                continue
            if not urlfilter_safe(pattern):
                skipped += 1
                continue
            # Skip extremely short patterns (too broad)
            if len(pattern) < 5:
                skipped += 1
                continue
            rule = {
                "urlFilter": pattern,
                "resourceTypes": parsed["types"] or RESOURCE_TYPES,
            }
            if parsed["third_party"] and not parsed["first_party"]:
                rule["domainType"] = "thirdParty"
            if parsed["domains"]:
                rule["initiatorDomains"] = [d for d in parsed["domains"] if is_valid_domain(d)][:50]
            if parsed["excluded_domains"]:
                rule["excludedInitiatorDomains"] = [
                    d for d in parsed["excluded_domains"] if is_valid_domain(d)
                ][:50]
            # Never apply generic path blocks on allowlisted initiator sites when possible
            excl = set(rule.get("excludedInitiatorDomains", []))
            excl.update(ALLOWLIST_SUFFIXES)
            rule["excludedInitiatorDomains"] = sorted(excl)[:50]
            url_block.append(rule)
            continue

        skipped += 1

    return {
        "block": block,
        "allow": allow,
        "url_block": url_block,
        "url_allow": url_allow,
        "generic": generic,
        "specific": specific,
        "skipped": skipped,
    }


def parse_domains_list(text: str):
    block: set[str] = set()
    skipped = 0
    # Strip UTF-8 BOM if present (GoodbyeAds ships with one).
    text = text.lstrip("\ufeff")
    for raw in text.splitlines():
        line = raw.strip().lower()
        if not line or line.startswith("#") or line.startswith("!"):
            continue
        # hosts-style: 0.0.0.0 example.com / 127.0.0.1 example.com
        if " " in line or "\t" in line:
            parts = [p for p in line.replace("\t", " ").split(" ") if p]
            # skip localhost mapping lines like "127.0.0.1 localhost"
            if len(parts) >= 2 and parts[0] in {"0.0.0.0", "127.0.0.1", "::1", "::"}:
                line = parts[1]
            else:
                line = parts[-1]
        if line in {"localhost", "localhost.localdomain", "local", "broadcasthost", "ip6-localhost", "ip6-loopback"}:
            skipped += 1
            continue
        if line.startswith("*."):
            line = line[2:]
        if line.startswith("."):
            line = line[1:]
        line = line.rstrip(".")
        if not is_valid_domain(line) or is_allowlisted(line):
            skipped += 1
            continue
        block.add(line)
    return {
        "block": block,
        "allow": set(),
        "url_block": [],
        "url_allow": [],
        "generic": set(),
        "specific": {},
        "skipped": skipped,
    }


def collect_all():
    block: set[str] = set()
    allow: set[str] = set()
    url_block: list[dict] = []
    url_allow: list[dict] = []
    generic: set[str] = set()
    specific: dict[str, set[str]] = defaultdict(set)
    stats: dict = {"sources": []}

    for source in SOURCES:
        text = load_source(source)
        if source["format"] == "adblock":
            parsed = parse_adblock(text, collect_cosmetics=source.get("cosmetics", False))
        else:
            # "domains" and "hosts" share the same parser
            parsed = parse_domains_list(text)

        before = len(block)
        block |= parsed["block"]
        allow |= parsed["allow"]
        url_block.extend(parsed["url_block"])
        url_allow.extend(parsed["url_allow"])
        generic |= parsed["generic"]
        for domain, sels in parsed["specific"].items():
            specific[domain] |= sels

        entry = {
            "id": source["id"],
            "name": source["name"],
            "url": source["url"],
            "domains": len(parsed["block"]),
            "allow": len(parsed["allow"]),
            "url_rules": len(parsed["url_block"]),
            "cosmetics_generic": len(parsed["generic"]),
            "cosmetics_specific_hosts": len(parsed["specific"]),
            "skipped": parsed["skipped"],
            "new_unique_domains": len(block) - before,
        }
        stats["sources"].append(entry)
        print(
            f"{source['id']}: domains={entry['domains']:,} "
            f"url={entry['url_rules']:,} cos_g={entry['cosmetics_generic']:,} "
            f"cos_h={entry['cosmetics_specific_hosts']:,} "
            f"new_domains={entry['new_unique_domains']:,} skipped={entry['skipped']:,}"
        )

    # Local phishing CSV datasets (OPT-IN only: --with-csv)
    # Public CSVs often mislabel canva.com / medium.com / google.com as phishing.
    if with_csv():
        csv_block, csv_meta = parse_phishing_csvs()
        if csv_block:
            before = len(block)
            block |= csv_block
            stats["sources"].append(
                {
                    "id": "phishing_csv",
                    "name": "Local phishing CSV datasets",
                    "url": str(CSV_DIR),
                    "domains": len(csv_block),
                    "allow": 0,
                    "url_rules": 0,
                    "cosmetics_generic": 0,
                    "cosmetics_specific_hosts": 0,
                    "skipped": 0,
                    "new_unique_domains": len(block) - before,
                    "files": csv_meta.get("files", []),
                }
            )
            print(
                f"phishing_csv: domains={len(csv_block):,} "
                f"new_unique={len(block) - before:,}"
            )
    elif CSV_DIR.exists() and any(CSV_DIR.glob("*.csv")):
        print(
            "Skipping phishing CSVs (pass --with-csv to enable). "
            "Recommended: keep CSVs quarantined after false positives."
        )

    block -= allow
    removed = {d for d in block if is_allowlisted(d)}
    if removed:
        block -= removed
        print(f"Allowlisted removed from block: {len(removed):,}")
    allow |= set(ALLOWLIST_SUFFIXES)
    # Drop tracker CDNs that slipped in via site-scoped EasyList exceptions.
    before_allow = len(allow)
    allow = {d for d in allow if not is_forbidden_global_allow(d)}
    if len(allow) < before_allow:
        print(f"Stripped tracker global-allows: {before_allow - len(allow):,}")

    before_fold = len(block)
    block = fold_subdomains(block)
    print(
        f"Folded subdomains: {before_fold:,} -> {len(block):,} "
        f"(removed {before_fold - len(block):,} covered by parents)"
    )

    # Cap urlFilter rules for package size / Chrome limits
    if len(url_block) > MAX_URLFILTER_RULES:
        print(f"Truncating urlFilter rules {len(url_block):,} -> {MAX_URLFILTER_RULES:,}")
        url_block = url_block[:MAX_URLFILTER_RULES]
    # Allow urlFilters rarely help and inflate package size.
    url_allow = []

    print(
        f"Merged domains block={len(block):,} allow={len(allow):,} "
        f"urlFilter={len(url_block):,} "
        f"cosmetics generic={len(generic):,} hosts={len(specific):,}"
    )
    return {
        "block_domains": sorted(block),
        "allow_domains": sorted(allow),
        "url_block": url_block,
        "url_allow": url_allow,
        "generic": sorted(generic),
        "specific": {k: sorted(v) for k, v in sorted(specific.items())},
        "stats": stats,
    }


def fold_subdomains(domains: set[str]) -> set[str]:
    """Drop hostnames already covered by a blocked parent (DNR matches subdomains)."""
    kept: set[str] = set()
    for domain in domains:
        labels = domain.split(".")
        covered = False
        for i in range(1, len(labels)):
            parent = ".".join(labels[i:])
            if parent.count(".") < 1:
                continue
            if parent in domains:
                covered = True
                break
        if not covered:
            kept.add(domain)
    return kept


def host_from_url(value: str) -> str | None:
    s = (value or "").strip().lower().strip("'\"")
    if not s:
        return None
    if "://" not in s:
        s = "http://" + s
    try:
        host = urlparse(s).hostname
    except Exception:
        return None
    if not host:
        return None
    host = host.lower().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    if not is_valid_domain(host) or is_allowlisted(host):
        return None
    return host


def parse_phishing_csvs() -> tuple[set[str], dict]:
    """Extract phishing/malware domains from local CSV datasets."""
    block: set[str] = set()
    meta = {"files": [], "domains": 0}

    if not CSV_DIR.exists():
        print(f"No CSV dir at {CSV_DIR} (skipping phishing CSV import)")
        return block, meta

    configs = [
        {
            "file": "malicious_phish.csv",
            "encoding": "utf-8",
            # Only explicit phishing/malware — never benign/defacement noise
            "keep": lambda r: (r.get("type") or "").lower() in {"phishing", "malware"},
            "url_keys": ("url",),
        },
        {
            "file": "Dataset.csv",
            "encoding": "utf-8",
            # label 1 = phishing in this file; prefer full URL over flaky `dom`
            "keep": lambda r: str(r.get("label")) == "1",
            "url_keys": ("url", "dom"),
        },
        {
            "file": "dataset_phishing 2.csv",
            "encoding": "utf-8",
            "keep": lambda r: (r.get("status") or "").lower() == "phishing",
            "url_keys": ("url",),
        },
        {
            "file": "PhiUSIIL_Phishing_URL_Dataset.csv",
            "encoding": "utf-8-sig",
            # CRITICAL: label 1 = phishing, label 0 = legitimate
            # (older build had this inverted and blocked canva.com / etc.)
            "keep": lambda r: str(r.get("label")).split(".")[0] == "1",
            "url_keys": ("URL", "Domain"),
        },
        {
            "file": "urldata.csv",
            "encoding": "utf-8",
            "keep": lambda r: (r.get("label") or "").lower() == "malicious",
            "url_keys": ("url",),
        },
    ]

    for cfg in configs:
        path = CSV_DIR / cfg["file"]
        if not path.exists():
            print(f"CSV missing: {path.name}")
            continue
        before = len(block)
        kept = 0
        with path.open("r", encoding=cfg["encoding"], errors="replace", newline="") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                try:
                    if not cfg["keep"](row):
                        continue
                except Exception:
                    continue
                raw = ""
                for key in cfg["url_keys"]:
                    raw = row.get(key) or ""
                    if raw:
                        break
                host = host_from_url(raw)
                if not host:
                    continue
                block.add(host)
                kept += 1
        added = len(block) - before
        meta["files"].append(
            {"file": cfg["file"], "rows_kept": kept, "new_unique": added}
        )
        print(
            f"csv:{cfg['file']}: kept_rows={kept:,} new_unique={added:,}"
        )

    meta["domains"] = len(block)
    return block, meta


def chunked(items: list, size: int) -> list:
    return [items[i : i + size] for i in range(0, len(items), size)]


def make_domain_rules(domains: list[str], action_type: str, start_id: int, priority: int):
    rules = []
    next_id = start_id
    for batch in chunked(domains, DOMAINS_PER_RULE):
        rules.append(
            {
                "id": next_id,
                "priority": priority,
                "action": {"type": action_type},
                "condition": {
                    "requestDomains": batch,
                    "resourceTypes": RESOURCE_TYPES,
                },
            }
        )
        next_id += 1
    return rules, next_id


def make_urlfilter_rules(entries: list[dict], action_type: str, start_id: int, priority: int):
    rules = []
    next_id = start_id
    for entry in entries:
        condition = {
            "urlFilter": entry["urlFilter"],
            "resourceTypes": entry.get("resourceTypes") or RESOURCE_TYPES,
        }
        for key in ("domainType", "initiatorDomains", "excludedInitiatorDomains", "requestDomains"):
            if key in entry and entry[key]:
                condition[key] = entry[key]
        rules.append(
            {
                "id": next_id,
                "priority": priority,
                "action": {"type": action_type},
                "condition": condition,
            }
        )
        next_id += 1
    return rules, next_id


def write_rulesets(data: dict) -> list[str]:
    RULES_DIR.mkdir(parents=True, exist_ok=True)
    for pattern in ("blocklist_*.json", "adguard_dns_*.json", "urlfilter_*.json"):
        for old in RULES_DIR.glob(pattern):
            old.unlink()

    allow_rules, next_id = make_domain_rules(
        data["allow_domains"], "allow", start_id=1, priority=100
    )
    url_allow_rules, next_id = make_urlfilter_rules(
        data["url_allow"], "allow", start_id=next_id, priority=90
    )
    domain_block_rules, next_id = make_domain_rules(
        data["block_domains"], "block", start_id=next_id, priority=1
    )
    url_block_rules, _ = make_urlfilter_rules(
        data["url_block"], "block", start_id=next_id, priority=1
    )

    all_domainish = allow_rules + url_allow_rules + domain_block_rules
    print(
        f"DNR domain/allow rules={len(all_domainish):,} "
        f"urlFilter block rules={len(url_block_rules):,}"
    )

    ruleset_ids: list[str] = []

    for index, batch in enumerate(chunked(all_domainish, RULES_PER_RULESET), start=1):
        rid = f"blocklist_{index}"
        path = RULES_DIR / f"{rid}.json"
        path.write_text(json.dumps(batch, separators=(",", ":")), encoding="utf-8")
        print(f"  {path.name}: {len(batch):,} rules ({path.stat().st_size / 1024:.0f} KB)")
        ruleset_ids.append(rid)

    for index, batch in enumerate(chunked(url_block_rules, URLFILTER_PER_RULESET), start=1):
        rid = f"urlfilter_{index}"
        path = RULES_DIR / f"{rid}.json"
        path.write_text(json.dumps(batch, separators=(",", ":")), encoding="utf-8")
        print(f"  {path.name}: {len(batch):,} rules ({path.stat().st_size / 1024:.0f} KB)")
        ruleset_ids.append(rid)

    data["stats"].update(
        {
            "block_domains": len(data["block_domains"]),
            "allow_domains": len(data["allow_domains"]),
            "urlfilter_rules": len(url_block_rules),
            "dnr_rules": len(all_domainish) + len(url_block_rules),
            "cosmetics_generic": len(data["generic"]),
            "cosmetics_specific_hosts": len(data["specific"]),
            "rulesets": ruleset_ids,
        }
    )
    (RULES_DIR / "build-meta.json").write_text(
        json.dumps(data["stats"], indent=2), encoding="utf-8"
    )
    return ruleset_ids


def write_cosmetics(generic: list[str], specific: dict[str, list[str]]) -> None:
    generic_list = sorted(generic)
    if len(generic_list) > MAX_GENERIC_COSMETICS:
        print(f"Truncating generic cosmetics {len(generic_list):,} -> {MAX_GENERIC_COSMETICS:,}")
        generic_list = generic_list[:MAX_GENERIC_COSMETICS]

    # Prefer hosts with more selectors (usually major sites), then cap.
    specific_items = []
    for host, sels in specific.items():
        cleaned = sorted({s for s in sels if s})[:MAX_SELECTORS_PER_HOST]
        if cleaned:
            specific_items.append((host, cleaned))
    specific_items.sort(key=lambda item: (-len(item[1]), item[0]))
    if len(specific_items) > MAX_SPECIFIC_HOSTS:
        print(f"Truncating specific hosts {len(specific_items):,} -> {MAX_SPECIFIC_HOSTS:,}")
        specific_items = specific_items[:MAX_SPECIFIC_HOSTS]
    specific_out = {host: sels for host, sels in specific_items}

    payload = {
        "generic": generic_list,
        "specific": specific_out,
    }
    COSMETICS_PATH.write_text(
        json.dumps(payload, separators=(",", ":")), encoding="utf-8"
    )
    print(
        f"Wrote {COSMETICS_PATH.name} "
        f"({COSMETICS_PATH.stat().st_size / 1024:.0f} KB, "
        f"{len(generic_list):,} generic, {len(specific_out):,} hosts)"
    )


def update_manifest(ruleset_ids: list[str], block_count: int, cos_count: int) -> None:
    """Patch DNR resources only — never wipe name/permissions/content_scripts."""
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    hand_tuned = ["allowlist", "protections", "https_upgrade"]
    resources = []
    for rid in hand_tuned:
        path = RULES_DIR / f"{rid}.json"
        if path.exists():
            resources.append({"id": rid, "enabled": True, "path": f"rules/{rid}.json"})

    for rid in ruleset_ids:
        if rid in hand_tuned:
            continue
        resources.append({"id": rid, "enabled": True, "path": f"rules/{rid}.json"})

    manifest["declarative_net_request"] = {"rule_resources": resources}
    # Keep branding; only append light size hint into description if missing stats.
    base = str(manifest.get("description") or "GOSAFE adblock")
    base = re.sub(r"\s*\(\d[\d,]* domains.*?\)\s*", " ", base).strip()
    manifest["description"] = (
        f"{base} ({block_count:,} domains, {cos_count:,} cosmetics)."
    )
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Updated manifest DNR resources ({len(resources)} rulesets)")


def main() -> None:
    import shutil

    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # Move uploaded CSVs out of the extension package (they are huge).
    legacy_csv = ROOT / "csv"
    if legacy_csv.is_dir():
        CSV_DIR.mkdir(parents=True, exist_ok=True)
        for src in legacy_csv.iterdir():
            if not src.is_file():
                continue
            dest = CSV_DIR / src.name
            if dest.exists():
                src.unlink()
            else:
                shutil.move(str(src), str(dest))
                print(f"Moved CSV {src.name} -> {CSV_DIR}")
        try:
            legacy_csv.rmdir()
            print(f"Removed {legacy_csv}")
        except OSError:
            shutil.rmtree(legacy_csv, ignore_errors=True)

    # Migrate old in-package cache out of the extension folder.
    legacy_build = ROOT / "build"
    if legacy_build.is_dir():
        for src in legacy_build.iterdir():
            if not src.is_file():
                continue
            dest = CACHE_DIR / src.name
            if not dest.exists():
                shutil.move(str(src), str(dest))
                print(f"Moved cache {src.name} -> {CACHE_DIR}")
            else:
                src.unlink()
        try:
            legacy_build.rmdir()
            print(f"Removed {legacy_build}")
        except OSError:
            shutil.rmtree(legacy_build, ignore_errors=True)

    # Chrome regenerates this on load; drop stale indexed copies from package.
    metadata = ROOT / "_metadata"
    if metadata.exists():
        shutil.rmtree(metadata, ignore_errors=True)
        print("Removed _metadata/")

    legacy = CACHE_DIR / "filter.txt"
    if legacy.exists() and not (CACHE_DIR / "adguard_filter.txt").exists():
        legacy.rename(CACHE_DIR / "adguard_filter.txt")

    apply_profile()
    data = collect_all()
    if not data["block_domains"]:
        raise SystemExit("No block domains parsed; aborting.")
    write_cosmetics(data["generic"], data["specific"])
    # Re-read capped cosmetics for accurate counts
    cos = json.loads(COSMETICS_PATH.read_text(encoding="utf-8"))
    cos_count = len(cos.get("generic") or []) + sum(
        len(v) for v in (cos.get("specific") or {}).values()
    )
    ruleset_ids = write_rulesets(data)
    update_manifest(ruleset_ids, len(data["block_domains"]), cos_count)

    # Report package size (extension folder only; ignore dist/_metadata).
    total = 0
    for p in ROOT.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(ROOT)
        if rel.parts and rel.parts[0] in {"dist", "_metadata", "scripts", ".git"}:
            continue
        total += p.stat().st_size
    print(f"Extension package size: {total / 1024 / 1024:.1f} MB")
    print("Done.")


if __name__ == "__main__":
    main()
