#!/usr/bin/env python3
"""Load saidutta69/PhishTrap and distill compact URL thresholds for GOSAFE."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

from datasets import load_dataset

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "rules" / "phishtrap-signals.json"

FEATURES = [
    "url_length",
    "hyphen_count",
    "digit_count",
    "subdomain_count",
    "entropy",
    "path_depth",
    "domain_length",
    "is_domain_ip",
    "has_at_symbol",
    "has_double_slash_redirect",
    "tld_length",
    "query_param_count",
    "path_length",
    "trusted_tld",
    "special_char_count",
]


def pct(vals: list[float], p: float) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    i = min(len(s) - 1, max(0, int(round((p / 100) * (len(s) - 1)))))
    return float(s[i])


def host_tld(url: str) -> str:
    raw = url if "://" in url else f"http://{url}"
    try:
        host = (urlparse(raw).hostname or "").lower().rstrip(".")
    except Exception:
        return ""
    if not host or "." not in host:
        return ""
    return host.rsplit(".", 1)[-1]


def main() -> None:
    ds = load_dataset("saidutta69/PhishTrap")
    rows = list(ds["train"]) + list(ds["validation"])
    ph = [r for r in rows if int(r["label"]) == 1]
    bg = [r for r in rows if int(r["label"]) == 0]
    print(f"fit on train+val: phishing={len(ph)} benign={len(bg)}")

    # Thresholds: pick cutoffs near bg p90 / between means where phishing is higher.
    # Weights are modest — PhishTrap supplements existing heuristics.
    thresholds = {
        "entropy_ge": round(max(pct([float(r["entropy"]) for r in bg], 90), 4.2), 3),
        "hyphen_count_ge": int(max(3, pct([float(r["hyphen_count"]) for r in bg], 95))),
        "subdomain_count_ge": int(max(3, pct([float(r["subdomain_count"]) for r in bg], 95))),
        "domain_length_ge": int(max(30, pct([float(r["domain_length"]) for r in bg], 95))),
        "url_length_ge": int(max(80, pct([float(r["url_length"]) for r in bg], 95))),
        "path_depth_ge": int(max(4, pct([float(r["path_depth"]) for r in bg], 95))),
        "query_param_count_ge": int(max(4, pct([float(r["query_param_count"]) for r in bg], 95))),
        "special_char_count_ge": int(max(8, pct([float(r["special_char_count"]) for r in bg], 95))),
        "digit_count_ge": int(max(6, pct([float(r["digit_count"]) for r in bg], 95))),
        "tld_length_ge": int(max(6, pct([float(r["tld_length"]) for r in bg], 95))),
    }

    weights = {
        "entropy_ge": 10,
        "hyphen_count_ge": 12,
        "subdomain_count_ge": 14,
        "domain_length_ge": 8,
        "url_length_ge": 8,
        "path_depth_ge": 8,
        "query_param_count_ge": 6,
        "special_char_count_ge": 8,
        "digit_count_ge": 8,
        "tld_length_ge": 6,
        "is_domain_ip": 40,
        "has_at_symbol": 45,
        "has_double_slash_redirect": 18,
    }

    tld_ph = Counter(host_tld(r["url"]) for r in ph)
    tld_bg = Counter(host_tld(r["url"]) for r in bg)
    # Keep only abusive/rare TLDs — skip common legit ones (.com/.io/.app/…).
    skip_tlds = {
        "com",
        "net",
        "org",
        "edu",
        "gov",
        "io",
        "co",
        "app",
        "dev",
        "me",
        "info",
        "id",
        "pro",
        "cc",
        "uk",
        "us",
        "ca",
        "au",
        "de",
        "fr",
        "jp",
        "kr",
        "in",
        "br",
        "cn",
        "ru",
        "nl",
        "se",
        "ch",
        "eu",
        "ai",
    }
    risky_tlds = []
    for tld, n in tld_ph.most_common(80):
        if not tld or len(tld) > 12 or tld in skip_tlds:
            continue
        bg_n = tld_bg.get(tld, 0)
        if n >= 20 and n >= max(bg_n * 4, 1):
            risky_tlds.append(tld)

    # Quick holdout sanity on test: score with simple threshold sum
    test = list(ds["test"])

    def score_row(r: dict) -> int:
        s = 0
        if float(r["entropy"]) >= thresholds["entropy_ge"]:
            s += weights["entropy_ge"]
        if int(r["hyphen_count"]) >= thresholds["hyphen_count_ge"]:
            s += weights["hyphen_count_ge"]
        if int(r["subdomain_count"]) >= thresholds["subdomain_count_ge"]:
            s += weights["subdomain_count_ge"]
        if int(r["domain_length"]) >= thresholds["domain_length_ge"]:
            s += weights["domain_length_ge"]
        if int(r["url_length"]) >= thresholds["url_length_ge"]:
            s += weights["url_length_ge"]
        if int(r["path_depth"]) >= thresholds["path_depth_ge"]:
            s += weights["path_depth_ge"]
        if int(r["query_param_count"]) >= thresholds["query_param_count_ge"]:
            s += weights["query_param_count_ge"]
        if int(r["special_char_count"]) >= thresholds["special_char_count_ge"]:
            s += weights["special_char_count_ge"]
        if int(r["digit_count"]) >= thresholds["digit_count_ge"]:
            s += weights["digit_count_ge"]
        if int(r["tld_length"]) >= thresholds["tld_length_ge"]:
            s += weights["tld_length_ge"]
        if int(r["is_domain_ip"]):
            s += weights["is_domain_ip"]
        if int(r["has_at_symbol"]):
            s += weights["has_at_symbol"]
        if int(r["has_double_slash_redirect"]):
            s += weights["has_double_slash_redirect"]
        tld = host_tld(r["url"])
        if tld in risky_tlds:
            s += 12
        return s

    # Find cutoff maximizing accuracy on validation (reuse train rows sample)
    val_scores = [(score_row(r), int(r["label"])) for r in list(ds["validation"])]
    best = (0, 0.0)
    for cut in range(10, 80, 2):
        correct = sum(1 for sc, y in val_scores if (sc >= cut) == (y == 1))
        acc = correct / max(len(val_scores), 1)
        if acc > best[1]:
            best = (cut, acc)
    print(f"val best cutoff={best[0]} acc={best[1]:.3f}")

    test_scores = [(score_row(r), int(r["label"])) for r in test]
    cut = best[0]
    tp = sum(1 for sc, y in test_scores if sc >= cut and y == 1)
    tn = sum(1 for sc, y in test_scores if sc < cut and y == 0)
    fp = sum(1 for sc, y in test_scores if sc >= cut and y == 0)
    fn = sum(1 for sc, y in test_scores if sc < cut and y == 1)
    acc = (tp + tn) / max(len(test_scores), 1)
    print(f"test@{cut}: acc={acc:.3f} tp={tp} tn={tn} fp={fp} fn={fn}")

    payload = {
        "source": "saidutta69/PhishTrap",
        "fit_rows": len(rows),
        "phishing_rows": len(ph),
        "benign_rows": len(bg),
        "thresholds": thresholds,
        "weights": weights,
        "risky_tlds": sorted(set(risky_tlds)),
        "suggest_cutoff": cut,
        "test_accuracy_note": round(acc, 4),
    }
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")

    # Emit a tiny JS module the extension can importScripts.
    js_out = ROOT / "lib" / "phishtrap-signals.js"
    js_out.write_text(
        "(() => {\n"
        '  "use strict";\n'
        f"  globalThis.AblPhishTrap = Object.freeze({json.dumps(payload, separators=(',', ':'))});\n"
        "})();\n",
        encoding="utf-8",
    )
    print(f"wrote {js_out}")


if __name__ == "__main__":
    main()
