#!/usr/bin/env python3
"""Build a Chrome Web Store zip of GOSAFE adblock (excludes build tooling)."""

from __future__ import annotations

import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dist" / "gosafe-adblock.zip"

SKIP_DIRS = {
    ".git",
    ".cursor",
    "dist",
    "scripts",
    "node_modules",
    "__pycache__",
    "build",
    "agent-transcripts",
    "_metadata",
}
SKIP_NAMES = {
    ".gitignore",
    ".gitattributes",
    ".DS_Store",
    "Thumbs.db",
}
SKIP_SUFFIXES = {".pyc", ".pyo", ".map"}


def include(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    if any(part in SKIP_DIRS for part in rel.parts):
        return False
    if path.name in SKIP_NAMES:
        return False
    if path.suffix in SKIP_SUFFIXES:
        return False
    if path.name.startswith("."):
        return False
    return True


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if OUT.exists():
        OUT.unlink()

    count = 0
    with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in sorted(ROOT.rglob("*")):
            if not path.is_file() or not include(path):
                continue
            arc = path.relative_to(ROOT).as_posix()
            zf.write(path, arcname=arc)
            count += 1

    mb = OUT.stat().st_size / (1024 * 1024)
    print(f"Wrote {OUT} ({count} files, {mb:.1f} MB)")


if __name__ == "__main__":
    main()
