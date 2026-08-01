#!/usr/bin/env python3
"""Refresh hand-tuned + optional full blocklists (Phase D CI entrypoint).

Usage:
  python scripts/refresh_rulesets.py           # d3host + redirects only (fast)
  python scripts/refresh_rulesets.py --lite    # also rebuild lite blocklists
  python scripts/refresh_rulesets.py --full    # mega lists (slow / large)
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(script: str, *args: str) -> None:
    cmd = [sys.executable, str(ROOT / "scripts" / script), *args]
    print("+", " ".join(cmd))
    subprocess.check_call(cmd, cwd=ROOT)


def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh GOSAFE DNR rulesets")
    parser.add_argument("--lite", action="store_true", help="Rebuild lite blocklists")
    parser.add_argument("--full", action="store_true", help="Rebuild full blocklists")
    args = parser.parse_args()

    run("build_d3host.py")
    run("build_redirects.py")
    run("build_trackparams.py")

    if args.full:
        run("build_blocklists.py", "--full")
    elif args.lite:
        run("build_blocklists.py", "--lite")

    print("Ruleset refresh complete.")


if __name__ == "__main__":
    main()
