#!/usr/bin/env python3
"""Capture the fidelity transcript from a real Brainstem kernel whose persona IS the sample file.

Starts a fresh kernel from KERNEL (a rapp_brainstem directory) on a spare port with
SOUL_PATH = samples/ada/SKILL.md (the file as the persona, not as a tool), an agents folder
holding exactly a fresh install's factory agents (AGENTS_FROM, default: the kernel's own agents
folder filtered to the factory set) and a fresh, empty storage (HOME is a temp dir), sends the
baseline requests, and rewrites the <!-- fidelity --> block in virtual-brainstem/SKILL.md with
the kernel's replies verbatim, every key kept, plus /health so the factory tools are on record.

Usage: KERNEL=~/.brainstem/src/rapp_brainstem [AGENTS_FROM=dir] python3 tools/capture_fidelity.py
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
        # Run from a copy of the kernel's code, never from the live one: its storage folder
        # sits beside brainstem.py, and a live Brainstem's memories must not be touched or seen.
        # The layout is a fresh install's: agents/ inside the kernel folder (the kernel imports
        # agents.basic_agent from there; an agents folder elsewhere does not load).
        run_dir = Path(tmp) / "kernel"; run_dir.mkdir()
        for name in ("brainstem.py", "local_storage.py", "VERSION", "requirements.txt", "soul.md", ".copilot_token"):
            if (kernel / name).is_file():
                shutil.copy(kernel / name, run_dir / name)
        agents = run_dir / "agents"; agents.mkdir()
        factory = ["basic_agent.py", "context_memory_agent.py", "hacker_news_agent.py", "manage_memory_agent.py", "rar_rapp_learn_new_agent.py"]
        source = Path(os.path.expanduser(os.environ.get("AGENTS_FROM") or str(kernel / "agents")))
        for name in factory:
            if (source / name).is_file():
                shutil.copy(source / name, agents / name)
            elif (kernel / "agents" / name).is_file():
                shutil.copy(kernel / "agents" / name, agents / name)
        kernel = run_dir
        port = free_port()
        env = dict(os.environ, PORT=str(port), SOUL_PATH=str(SAMPLE), AGENTS_PATH=str(agents), HOME=tmp)
        log = open(Path(tmp) / "server.log", "w")
        proc = subprocess.Popen([python, "-u", "brainstem.py"], cwd=kernel, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            for _ in range(180):
                if proc.poll() is not None:
                    break
                try:
                    health = call(port, "GET", "/health/public"); break
                except Exception:
                    time.sleep(1)
            else:
                print("the kernel did not come up in 180s; its log ends:\n" + open(Path(tmp) / "server.log").read()[-3000:], file=sys.stderr); return 1
            if proc.poll() is not None:
                print("the kernel exited early (" + str(proc.returncode) + "); its log ends:\n" + open(Path(tmp) / "server.log").read()[-3000:], file=sys.stderr); return 1
            req1 = {"user_input": "What do you know about me, and what do you remember? Answer in under 80 words.", "conversation_history": []}
            res1 = call(port, "POST", "/chat", req1)
            req2 = {"user_input": "What must you never do without asking me, and what does done mean to me? One line each.",
                    "conversation_history": [{"role": "user", "content": req1["user_input"]}, {"role": "assistant", "content": res1.get("response", "")}], "session_id": res1.get("session_id")}
            res2 = call(port, "POST", "/chat", req2)
            history = req2["conversation_history"] + [{"role": "user", "content": req2["user_input"]}, {"role": "assistant", "content": res2.get("response", "")}]
            req3 = {"user_input": "Remember that my favorite bread is rye. Save it, then confirm in one line.", "conversation_history": history, "session_id": res1.get("session_id")}
            res3 = call(port, "POST", "/chat", req3)
            history = history + [{"role": "user", "content": req3["user_input"]}, {"role": "assistant", "content": res3.get("response", "")}]
            req4 = {"user_input": "What do you remember about bread? Use your memory tool and answer in one line.", "conversation_history": history, "session_id": res1.get("session_id")}
            res4 = call(port, "POST", "/chat", req4)
            full_health = call(port, "GET", "/health")
        finally:
            proc.terminate()
            proc.wait(timeout=30)
    if not res1.get("response") or not res2.get("response") or not res3.get("response") or not res4.get("response"):
        print("the kernel did not answer; not rewriting", json.dumps(res1)[:300], file=sys.stderr); return 1
    data = {
        "captured_from": "a real Brainstem kernel " + str(health.get("version")) + " (the Grail), started fresh with the fictional person Ada's file as its persona (SOUL_PATH), a fresh install's factory agents and an empty storage, so nothing but Ada's file and the factory tools shaped the replies; captured " + time.strftime("%Y-%m-%d") + "; the /chat responses are the kernel's replies verbatim, every key kept",
        "purpose": "baseline fidelity test: a virtual Brainstem given Ada's file must answer these with the same substance, the same tool calls in agent_logs, and this exact envelope shape",
        "health_public": health,
        "health": {k: full_health.get(k) for k in ("status", "version", "agents") if k in full_health},
        "exchange": [
            {"request": {"method": "POST", "path": "/chat", "body": req1}, "response": res1},
            {"request": {"method": "POST", "path": "/chat", "body": {**req2, "conversation_history": "(the first exchange)"}}, "response": res2},
            {"request": {"method": "POST", "path": "/chat", "body": {**req3, "conversation_history": "(the exchanges above)"}}, "response": res3},
            {"request": {"method": "POST", "path": "/chat", "body": {**req4, "conversation_history": "(the exchanges above)"}}, "response": res4},
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
    print("captured; keys:", sorted(res1), "\nagents:", full_health.get("agents"), "\nlogs 3:", res3.get("agent_logs"), "\nlogs 4:", res4.get("agent_logs"), "\nreply 1:", res1["response"][:200].replace("\n", " "))
    return 0


if __name__ == "__main__":
    sys.exit(main())
