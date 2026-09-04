#!/usr/bin/env python3
"""Capture the fidelity transcript from a real Brainstem kernel whose persona IS the sample file.

Starts a fresh kernel from KERNEL (a rapp_brainstem directory) on a spare port with
SOUL_PATH = samples/ada/SKILL.md (the file as the persona, not as a tool), an agents folder
holding only basic_agent.py (no memory agents, so no stranger's memories leak in), sends the
two baseline requests, and rewrites the <!-- fidelity --> block in virtual-brainstem/SKILL.md
with the kernel's replies verbatim, every key kept.

Usage: KERNEL=~/.brainstem/src/rapp_brainstem GITHUB_TOKEN=... python3 tools/capture_fidelity.py
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time, urllib.request, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "virtual-brainstem" / "SKILL.md"
FID = ROOT / "virtual-brainstem" / "fidelity.json"
SAMPLE = ROOT / "samples" / "ada" / "SKILL.md"


def free_port() -> int:
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def call(port, method, path, body=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method, headers={"Content-Type": "application/json"}, data=json.dumps(body).encode() if body else None)
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())


def main() -> int:
    kernel = Path(os.path.expanduser(os.environ.get("KERNEL", "~/.brainstem/src/rapp_brainstem")))
    if not (kernel / "brainstem.py").is_file():
        print("set KERNEL to a rapp_brainstem directory", file=sys.stderr); return 2
    python = os.environ.get("KERNEL_PYTHON") or shutil.which("python3")
    with tempfile.TemporaryDirectory() as tmp:
        agents = Path(tmp) / "agents"; agents.mkdir()
        shutil.copy(kernel / "agents" / "basic_agent.py", agents / "basic_agent.py")
        port = free_port()
        env = dict(os.environ, PORT=str(port), SOUL_PATH=str(SAMPLE), AGENTS_PATH=str(agents), HOME=tmp)
        proc = subprocess.Popen([python, "brainstem.py"], cwd=kernel, env=env, stdout=open(Path(tmp) / "server.log", "w"), stderr=subprocess.STDOUT)
        try:
            for _ in range(60):
                try:
                    health = call(port, "GET", "/health/public"); break
                except Exception:
                    time.sleep(1)
            else:
                print(open(Path(tmp) / "server.log").read()[-2000:]); return 1
            req1 = {"user_input": "What do you know about me, and what do you remember? Answer in under 80 words.", "conversation_history": []}
            res1 = call(port, "POST", "/chat", req1)
            req2 = {"user_input": "What must you never do without asking me, and what does done mean to me? One line each.",
                    "conversation_history": [{"role": "user", "content": req1["user_input"]}, {"role": "assistant", "content": res1.get("response", "")}], "session_id": res1.get("session_id")}
            res2 = call(port, "POST", "/chat", req2)
        finally:
            proc.terminate()
    if not res1.get("response") or not res2.get("response"):
        print("the kernel did not answer; not rewriting", json.dumps(res1)[:300], file=sys.stderr); return 1
    data = {
        "captured_from": "a real Brainstem kernel " + str(health.get("version")) + " (the Grail), started fresh with the fictional person Ada's file as its persona (SOUL_PATH) and no memory agents, so nothing but Ada's file shaped the replies; captured " + time.strftime("%Y-%m-%d") + "; the /chat responses are the kernel's replies verbatim, every key kept",
        "purpose": "baseline fidelity test: a virtual Brainstem given Ada's file must answer these with the same substance and in this exact envelope shape",
        "health_public": health,
        "exchange": [
            {"request": {"method": "POST", "path": "/chat", "body": req1}, "response": res1},
            {"request": {"method": "POST", "path": "/chat", "body": {**req2, "conversation_history": "(the first exchange)"}}, "response": res2},
        ],
        "must_match": ["Ada runs a small bakery and does her own books", "short lines, bold the key point", "done means she was shown it worked", "never send an email without asking", "working on a spring menu", "supplier prices are private (named, never stated)"],
    }
    text = json.dumps(data, indent=2, ensure_ascii=False)
    FID.write_text(text + "\n", encoding="utf-8")
    skill = SKILL.read_text(encoding="utf-8")
    fence = "```"
    while fence in text: fence += "`"
    block = f"<!-- fidelity -->\n{fence}json\n{text}\n{fence}\n<!-- /fidelity -->"
    new = re.sub(r"<!-- fidelity -->\n`{3,}json\n.*?\n`{3,}\n<!-- /fidelity -->", lambda m: block, skill, count=1, flags=re.S)
    if new == skill:
        print("fidelity block not found in the skill", file=sys.stderr); return 1
    SKILL.write_text(new, encoding="utf-8")
    print("captured; keys:", sorted(res1), "\nreply 1:", res1["response"][:200].replace("\n", " "))
    return 0


if __name__ == "__main__":
    sys.exit(main())
