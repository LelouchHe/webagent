#!/usr/bin/env python3
"""Extract a version's changelog section into a GitHub Release body file.

Usage: python3 scripts/release-notes.py <version> [--out <file>]

Reads CHANGELOG.md in the repo root and emits (or writes to --out) the
section starting at "## [<version>] - ..." through the next "## [" plus the
version's "[<version>]:" compare link if one is present. Exit non-zero when no
section exists so a release cannot ship without release notes.

Used by .github/workflows/publish.yml to build the auto-created GitHub Release
body from the official CHANGELOG.md content.
"""

import argparse
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def extract(version: str) -> str:
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    pattern = re.compile(
        rf"^## \[{re.escape(version)}\].*?(?=^## \[)", re.MULTILINE | re.DOTALL
    )
    section = pattern.search(text)
    if not section:
        raise SystemExit(f"CHANGELOG.md has no '[{version}]' section for this tag")
    body = section.group(0).rstrip()
    link = re.search(rf"^\[{re.escape(version)}\]: (\S+)", text, re.MULTILINE)
    if link:
        body += "\n\n" + link.group(0)
    return body + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("--out")
    args = parser.parse_args()
    body = extract(args.version)
    if args.out:
        Path(args.out).write_text(body, encoding="utf-8")
    else:
        print(body, end="")


if __name__ == "__main__":
    main()
