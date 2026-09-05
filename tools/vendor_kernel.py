#!/usr/bin/env python3
"""Vendor the pinned Grail kernel into virtual-brainstem/SKILL.md, factory agents included, and check it.

Every block is `<!-- kernel file=<path> sha256=<hex> source=kody-w/rapp-installer@<commit> -->`,
a fenced code block holding the file byte for byte, then `<!-- /kernel -->`. The sha256 is the
file's. A virtual Brainstem reads these to know its shape, to simulate its factory tools, and to
hatch a real one; so the set must be the set a fresh install has, and every byte must match.

Usage:
  python3 tools/vendor_kernel.py check                      # every marker hashes; factory files present
  python3 tools/vendor_kernel.py add --from <rapp_brainstem_dir>   # insert missing factory agent blocks
  python3 tools/vendor_kernel.py add                         # same, fetching from the pinned commit
"""
import hashlib, re, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "virtual-brainstem" / "SKILL.md"
SOURCE_REPO = "kody-w/rapp-installer"
PIN = "49db80c8c6b6caa7647369beaf477d374a8f293c"
# What a fresh Brainstem ships in agents/ at the pinned commit (experimental/ is not loaded),
# plus the agent that makes new agents, which ships from the RAR registry under the name a
# Brainstem gives a registry agent (rar_<namespace>_<name>_agent.py).
FACTORY_AGENTS = ["context_memory_agent.py", "hacker_news_agent.py", "manage_memory_agent.py", "rar_rapp_learn_new_agent.py"]
# path in the vendored tree -> (repo, ref, path in that repo); everything else comes from the Grail pin
OTHER_SOURCES = {
    "rapp_brainstem/agents/rar_rapp_learn_new_agent.py": ("kody-w/RAR", "RAR_PIN", "agents/@rapp/learn_new_agent.py"),
}
RAR_PIN = "04b47f0e7acb6ef140529206ac4b8954b95db9e2"
BLOCK_RE = re.compile(r"<!-- kernel file=(\S+) sha256=([0-9a-f]{64}) source=(\S+)(?: path=\S+)? -->\n(`{3,})(\w*)\n(.*?)\n\4\n<!-- /kernel -->", re.S)


def blocks(text):
    return [(m.group(1), m.group(2), m.group(6), m) for m in BLOCK_RE.finditer(text)]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def body_matches(body: str, digest: str) -> bool:
    return any(sha256(c.encode("utf-8")) == digest for c in (body + "\n", body))


def source_of(path: str) -> tuple[str, str, str]:
    """(repo, ref, path in repo) a vendored file comes from."""
    if path in OTHER_SOURCES:
        repo, ref, remote = OTHER_SOURCES[path]
        return repo, (RAR_PIN if ref == "RAR_PIN" else ref), remote
    return SOURCE_REPO, PIN, path


def fetch(path: str, source_dir: Path | None) -> bytes:
    if source_dir is not None:
        return (source_dir / path.replace("rapp_brainstem/", "", 1)).read_bytes()
    repo, ref, remote = source_of(path)
    url = f"https://raw.githubusercontent.com/{repo}/{ref}/{remote}"
    with urllib.request.urlopen(url, timeout=60) as r:
        return r.read()


def block_for(path: str, data: bytes) -> str:
    text = data.decode("utf-8")
    fence = "```"
    while fence in text:
        fence += "`"
    lang = "python" if path.endswith(".py") else "text"
    body = text if text.endswith("\n") else text + "\n"
    repo, ref, remote = source_of(path)
    origin = f"{repo}@{ref}" + (f" path={remote}" if remote != path else "")
    return f"<!-- kernel file={path} sha256={sha256(data)} source={origin} -->\n{fence}{lang}\n{body}{fence}\n<!-- /kernel -->"


def check() -> int:
    text = SKILL.read_text(encoding="utf-8")
    found = blocks(text)
    rc = 0
    for path, digest, body, _ in found:
        if not body_matches(body, digest):
            print(f"MISMATCH {path}: block does not hash to its marker"); rc = 1
    present = {p for p, _, _, _ in found}
    for name in FACTORY_AGENTS + ["basic_agent.py"]:
        if f"rapp_brainstem/agents/{name}" not in present:
            print(f"MISSING  rapp_brainstem/agents/{name}"); rc = 1
    for name in ["brainstem.py"] + KERNEL_FILES:
        if f"rapp_brainstem/{name}" not in present:
            print(f"MISSING  rapp_brainstem/{name}"); rc = 1
    if rc == 0:
        print(f"ok: {len(found)} kernel block(s) hash to their markers; factory agents present")
    return rc


# Kernel files beside brainstem.py that the virtual machine needs to run the kernel whole.
KERNEL_FILES = ["local_storage.py"]


def _insert_after(text: str, anchor_path: str, new_blocks: list[str]) -> str:
    anchor = next((m for p, _, _, m in blocks(text) if p == anchor_path), None)
    if anchor is None:
        raise SystemExit(f"{anchor_path} block not found; refusing to guess where to insert")
    return text[:anchor.end()] + "\n\n" + "\n\n".join(new_blocks) + text[anchor.end():]


def add(source_dir: Path | None) -> int:
    text = SKILL.read_text(encoding="utf-8")
    present = {p for p, _, _, _ in blocks(text)}
    added = 0
    kernel_blocks = []
    for name in KERNEL_FILES:
        path = f"rapp_brainstem/{name}"
        if path not in present:
            data = fetch(path, source_dir); kernel_blocks.append(block_for(path, data)); print(f"added {path} sha256={sha256(data)[:12]}")
    if kernel_blocks:
        text = _insert_after(text, "rapp_brainstem/brainstem.py", kernel_blocks); added += len(kernel_blocks)
    agent_blocks = []
    for name in FACTORY_AGENTS:
        path = f"rapp_brainstem/agents/{name}"
        if path not in present:
            data = fetch(path, source_dir); agent_blocks.append(block_for(path, data)); print(f"added {path} sha256={sha256(data)[:12]}")
    if agent_blocks:
        text = _insert_after(text, "rapp_brainstem/agents/basic_agent.py", agent_blocks); added += len(agent_blocks)
    if not added:
        print("nothing to add"); return check()
    SKILL.write_text(text, encoding="utf-8")
    return check()


def main(argv) -> int:
    if not argv or argv[0] not in ("check", "add"):
        print(__doc__); return 2
    if argv[0] == "check":
        return check()
    source = None
    if len(argv) >= 3 and argv[1] == "--from":
        source = Path(argv[2]).expanduser()
    return add(source)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
