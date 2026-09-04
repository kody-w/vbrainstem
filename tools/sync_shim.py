#!/usr/bin/env python3
"""Keep the page's runner shim identical to the converter's.

The Python that runs a tool's code inside the page is the same contract the converter
writes into every skill's launcher (rapp-skills SHIM_SOURCE). One copy is vendored here as
tools/shim_source.py; this tool refreshes it from a rapp-skills checkout (or the public
raw file) and rewrites the block in index.html. tests/test_shim_parity.py fails when the
page and the vendored copy differ.

Usage: python3 tools/sync_shim.py [--from /path/to/rapp-skills | --from URL] [--check]
"""
import argparse
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT = "https://raw.githubusercontent.com/kody-w/rapp-skills/main/skills/rapp-skills/scripts/rapp_skills.py"
PAGE_RE = re.compile(r"const SHIM_SOURCE = String\.raw`\n(.*?)\n`;", re.S)
CONVERTER_RE = re.compile("SHIM_SOURCE = r'''\n(.*?)'''", re.S)


def converter_text(source: str) -> str:
    if source.startswith("http"):
        with urllib.request.urlopen(source, timeout=30) as r:
            return r.read().decode("utf-8")
    p = Path(source)
    if p.is_dir():
        p = p / "skills" / "rapp-skills" / "scripts" / "rapp_skills.py"
    return p.read_text(encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="source", default=DEFAULT)
    ap.add_argument("--check", action="store_true", help="only report whether index.html matches tools/shim_source.py")
    a = ap.parse_args()
    page = ROOT / "index.html"
    vendored = ROOT / "tools" / "shim_source.py"
    if a.check:
        m = PAGE_RE.search(page.read_text(encoding="utf-8"))
        same = bool(m) and (m.group(1) + "\n") == vendored.read_text(encoding="utf-8")
        print("page shim matches tools/shim_source.py" if same else "page shim DIFFERS from tools/shim_source.py (run tools/sync_shim.py)")
        return 0 if same else 1
    shim = CONVERTER_RE.search(converter_text(a.source)).group(1)
    if "`" in shim or "${" in shim:
        print("the converter shim contains characters a JS raw template cannot hold", file=sys.stderr)
        return 1
    vendored.write_text(shim if shim.endswith("\n") else shim + "\n", encoding="utf-8")
    text = page.read_text(encoding="utf-8")
    m = PAGE_RE.search(text)
    text = text[:m.start()] + "const SHIM_SOURCE = String.raw`\n" + shim.rstrip("\n") + "\n`;" + text[m.end():]
    page.write_text(text, encoding="utf-8")
    print("page shim and tools/shim_source.py refreshed from", a.source)
    return 0


if __name__ == "__main__":
    sys.exit(main())
