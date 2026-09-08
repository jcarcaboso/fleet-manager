#!/usr/bin/env python3
"""Check that relative Markdown links point to files in this repository."""

from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
LINK = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
errors: list[str] = []

for document in ROOT.rglob("*.md"):
    if ".git" in document.parts or "target" in document.parts:
        continue
    text = document.read_text(encoding="utf-8")
    for raw in LINK.findall(text):
        target = raw.strip().split(" ", 1)[0].strip("<>")
        parsed = urlsplit(target)
        if parsed.scheme or target.startswith(("#", "/")):
            continue
        path = (document.parent / parsed.path).resolve()
        if not path.exists():
            errors.append(f"{document.relative_to(ROOT)}: missing link target {target}")

if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)

print("documentation links: OK")
