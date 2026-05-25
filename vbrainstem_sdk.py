#!/usr/bin/env python3
"""
vbrainstem_sdk — drive the RAPP / vBrainstem agent runtime through a port,
the same way brainstem.py is driven, but with zero install and the live RAR
catalog. Single file, stdlib only.

Runs the *real* agent.py from the RAR registry in real CPython (full stdlib,
real network + filesystem), so agents that need sockets or os.environ secrets
work here even though they can't in the browser sandbox.

CLI:
    python3 vbrainstem_sdk.py serve [--port 7077] [--registry URL|PATH]
    python3 vbrainstem_sdk.py agents [--grep TEXT]
    python3 vbrainstem_sdk.py run <slug> "<request>"   [--arg k=v ...]
    python3 vbrainstem_sdk.py eval "<python code>"

HTTP API (brainstem-style; CORS-enabled so a browser or the rapp-brainstem
skill or `curl` or an agent can drive it):
    GET  /health                      -> {status, agents, runtime, registry}
    GET  /agents[?grep=]              -> {agents:[{name,display_name,...}]}
    POST /run    {slug|agent, request, args?}  -> {slug, executed, output|error}
    POST /eval   {code}              -> {output}

Secrets: set them in the process environment (export OPENAI_API_KEY=… before
serving, or pass via a .env-style export); agents read them via os.environ.
"""
from __future__ import annotations
import argparse, ast, contextlib, io, json, os, sys, tempfile, traceback, types, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RAW_BASE = "https://raw.githubusercontent.com/kody-w/RAR/main"
DATA_DIR = os.path.join(tempfile.gettempdir(), "vbrainstem_sdk_data")
_registry_cache: dict | None = None
_source_cache: dict[str, str] = {}
_shims_installed = False


# ── Registry ──────────────────────────────────────────────────────────────
def _fetch(url: str, timeout: int = 20) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "vbrainstem-sdk/1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")


def load_registry(registry: str | None = None, refresh: bool = False) -> dict:
    """Load registry.json from a local path or the live RAR repo (cached)."""
    global _registry_cache
    if _registry_cache is not None and not refresh:
        return _registry_cache
    src = registry or os.environ.get("RAPP_REGISTRY") or f"{RAW_BASE}/registry.json"
    text = open(src).read() if os.path.exists(src) else _fetch(src)
    _registry_cache = json.loads(text)
    return _registry_cache


def find_agent(slug: str, reg: dict) -> dict | None:
    agents = reg.get("agents", [])
    # exact, then publisher-insensitive suffix, then dash/underscore tolerance
    for a in agents:
        if a.get("name") == slug:
            return a
    s = slug.split("/")[-1]
    norm = lambda x: x.replace("-", "_")
    for a in agents:
        nm = a.get("name", "")
        if nm.split("/")[-1] == s or norm(nm.split("/")[-1]) == norm(s) or norm(nm) == norm(slug):
            return a
    return None


def agent_source(entry: dict) -> str:
    """Fetch (and cache) an agent's .py source from local disk or RAR raw."""
    f = entry.get("_file", "")
    if not f or f.endswith(".stub"):
        raise ValueError("agent has no public source (private/stub)")
    if f in _source_cache:
        return _source_cache[f]
    text = open(f).read() if os.path.exists(f) else _fetch(f"{RAW_BASE}/{f}")
    _source_cache[f] = text
    return text


# ── Runtime shims (BasicAgent + utils, mirrors the vBrainstem runner) ───────
def install_shims():
    global _shims_installed
    if _shims_installed:
        return
    os.makedirs(DATA_DIR, exist_ok=True)

    class BasicAgent:
        def __init__(self, name=None, metadata=None):
            if name is not None:
                self.name = name
            elif not hasattr(self, "name"):
                self.name = "BasicAgent"
            if metadata is not None:
                self.metadata = metadata
            elif not hasattr(self, "metadata"):
                self.metadata = {"name": self.name, "description": "",
                                 "parameters": {"type": "object", "properties": {}, "required": []}}
        def perform(self, **kwargs):
            return "Not implemented."
        def system_context(self):
            return None
        def to_tool(self):
            md = self.metadata or {}
            return {"type": "function", "function": {
                "name": self.name,
                "description": md.get("description", ""),
                "parameters": md.get("parameters", {"type": "object", "properties": {}, "required": []})}}

    for modname in ("basic_agent", "agents.basic_agent"):
        m = types.ModuleType(modname); m.BasicAgent = BasicAgent; sys.modules[modname] = m
    agents_pkg = types.ModuleType("agents"); agents_pkg.__path__ = []
    agents_pkg.basic_agent = sys.modules["agents.basic_agent"]; sys.modules["agents"] = agents_pkg

    afs = types.ModuleType("utils.azure_file_storage")

    class AzureFileStorageManager:
        _root = DATA_DIR
        def __init__(self, *a, **k):
            os.makedirs(self._root, exist_ok=True)
        def _p(self, name):
            safe = str(name).replace("..", "_").lstrip("/").replace("/", "__")
            return os.path.join(self._root, safe or "store")
        def read_file(self, name, *a, **k):
            try:
                with open(self._p(name)) as fh:
                    return fh.read()
            except Exception:
                return ""
        def write_file(self, name, content="", *a, **k):
            try:
                with open(self._p(name), "w") as fh:
                    fh.write(content if isinstance(content, str) else json.dumps(content, default=str))
                return True
            except Exception:
                return False
        def __getattr__(self, n):
            return lambda *a, **k: None

    afs.AzureFileStorageManager = AzureFileStorageManager
    utils_pkg = types.ModuleType("utils"); utils_pkg.__path__ = []
    utils_pkg.azure_file_storage = afs
    sys.modules["utils"] = utils_pkg; sys.modules["utils.azure_file_storage"] = afs
    _shims_installed = True


def _norm(s: str) -> str:
    return "".join(c.lower() for c in (s or "") if c.isalnum())


def run_source(source: str, display_name: str = "", request=None, args: dict | None = None) -> dict:
    """Exec an agent's source in real CPython and call perform(); returns a result dict."""
    install_shims()
    os.makedirs(os.path.join(DATA_DIR, "agents"), exist_ok=True)
    agent_path = os.path.join(DATA_DIR, "agents", "_active_agent.py")
    with open(agent_path, "w") as fh:
        fh.write(source)
    if os.path.join(DATA_DIR, "agents") not in sys.path:
        sys.path.insert(0, os.path.join(DATA_DIR, "agents"))
    ns = {"__name__": "_rapp_agent_", "__file__": agent_path}
    try:
        exec(compile(source, agent_path, "exec"), ns)
    except Exception as e:
        return {"executed": False, "error": f"exec failed: {e!r}", "trace": traceback.format_exc()[-1500:]}

    candidates = []
    for k, v in ns.items():
        if isinstance(v, type) and k != "BasicAgent" and hasattr(v, "perform"):
            mro = [b.__name__ for b in getattr(v, "__mro__", [])]
            if "BasicAgent" in mro and v.__name__ != "BasicAgent":
                candidates.append((k, v))
    if not candidates:
        return {"executed": False, "error": "no BasicAgent subclass found"}

    target = _norm(display_name)
    chosen = None
    for k, v in candidates:
        nk = _norm(k)
        if target and (nk == target or nk == target + "agent" or nk.replace("agent", "") == target):
            chosen = v; break
    cls = chosen or candidates[-1][1]

    try:
        inst = cls()
    except Exception as e:
        return {"executed": False, "error": f"instantiation failed: {e!r}", "trace": traceback.format_exc()[-1500:]}

    call_args = dict(args or {})
    attempts = ([call_args] if call_args else []) + [{"request": request}, {"query": request}, {}]
    last = None
    for kw in attempts:
        try:
            out = inst.perform(**{k: v for k, v in kw.items() if v is not None})
            if not isinstance(out, str):
                out = json.dumps(out, default=str)
            return {"executed": True, "ran_class": cls.__name__, "output": out}
        except TypeError as e:
            last = e; continue
        except Exception as e:
            return {"executed": False, "error": f"perform() failed: {e!r}", "trace": traceback.format_exc()[-1500:]}
    return {"executed": False, "error": f"perform() signature mismatch: {last!r}"}


def run_slug(slug: str, request=None, args: dict | None = None, registry: str | None = None) -> dict:
    reg = load_registry(registry)
    entry = find_agent(slug, reg)
    if not entry:
        return {"executed": False, "error": f"agent not found: {slug}"}
    try:
        src = agent_source(entry)
    except Exception as e:
        return {"executed": False, "error": str(e)}
    res = run_source(src, entry.get("display_name", ""), request, args)
    res.update({"agent": entry.get("display_name"), "slug": entry.get("name")})
    return res


def run_eval(code: str) -> dict:
    install_shims()
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            try:
                r = eval(code, globals())
                if r is not None:
                    print(repr(r))
            except SyntaxError:
                exec(code, globals())
        return {"output": buf.getvalue()}
    except Exception:
        return {"output": buf.getvalue() + traceback.format_exc()}


# ── LLM chat routing (Copilot via the rapp-auth worker; GitHub Models fallback) ──
WORKER = "https://rapp-auth.kwildfeuer.workers.dev"
_copilot_cache: dict = {}


def _http_json(url, data=None, headers=None, method=None, timeout=60):
    h = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "vbrainstem-sdk/1"}
    h.update(headers or {})
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=h, method=method or ("POST" if data is not None else "GET"))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _copilot_token(ghu):
    import time
    c = _copilot_cache.get(ghu)
    if c and c["exp"] > time.time() + 60:
        return c
    try:
        r = _http_json(f"{WORKER}/api/copilot/token", headers={"Authorization": f"Bearer {ghu}"}, method="GET")
    except Exception:
        return None
    if not r or "token" not in r:
        return None
    ct = {"token": r["token"],
          "endpoint": (r.get("endpoints") or {}).get("api", "https://api.individual.githubcopilot.com"),
          "exp": r.get("expires_at", time.time() + 1500)}
    _copilot_cache[ghu] = ct
    return ct


def _llm(token, messages, tools, model=None):
    import urllib.parse
    body = {"messages": messages, "tools": tools, "tool_choice": "auto", "temperature": 0.4}
    ct = _copilot_token(token)               # 1) Copilot via worker (full catalog incl. Claude) — ghu_ tokens
    if ct:
        try:
            return _http_json(f"{WORKER}/api/copilot/chat?endpoint=" + urllib.parse.quote(ct["endpoint"], safe=""),
                              {**body, "model": model or "gpt-4o"}, {"Authorization": f"Bearer {ct['token']}"})
        except Exception:
            pass
    return _http_json("https://models.github.ai/inference/chat/completions",   # 2) GitHub Models — PAT w/ models:read
                      {**body, "model": model or "openai/gpt-4o"}, {"Authorization": f"Bearer {token}"})


_soul_cache = None


def load_soul() -> str:
    """The system-prompt base — the SAME soul.md the local brainstem.py uses (override via RAPP_SOUL)."""
    global _soul_cache
    if _soul_cache is not None:
        return _soul_cache
    src = os.environ.get("RAPP_SOUL") or "https://raw.githubusercontent.com/kody-w/rapp-installer/main/rapp_brainstem/soul.md"
    try:
        _soul_cache = (open(src).read() if os.path.exists(src) else _fetch(src)).strip()
    except Exception:
        _soul_cache = "You are a helpful AI assistant."
    return _soul_cache


def _load_instances(slugs, registry=None) -> dict:
    """Instantiate catalog agents → {tool_name(==self.name): {inst, slug}} — like brainstem's load_agents()."""
    install_shims()
    reg = load_registry(registry)
    adir = os.path.join(DATA_DIR, "agents")
    os.makedirs(adir, exist_ok=True)
    if adir not in sys.path:
        sys.path.insert(0, adir)
    out = {}
    for slug in (slugs or []):
        entry = find_agent(slug, reg)
        if not entry:
            continue
        try:
            src = agent_source(entry)
        except Exception:
            continue
        path = os.path.join(adir, "_load_agent.py")
        open(path, "w").write(src)
        ns = {"__name__": "_rapp_agent_", "__file__": path}
        try:
            exec(compile(src, path, "exec"), ns)
        except Exception:
            continue
        cls = next((v for v in ns.values() if isinstance(v, type) and v.__name__ != "BasicAgent"
                    and hasattr(v, "perform")
                    and "BasicAgent" in [b.__name__ for b in getattr(v, "__mro__", [])]), None)
        if not cls:
            continue
        try:
            inst = cls()
        except Exception:
            continue
        out[getattr(inst, "name", entry["name"])] = {"inst": inst, "slug": entry["name"]}
    return out


def chat(user_input, token, conversation_history=None, session_id=None, model=None, registry=None, agents=None) -> dict:
    """Natural-language chat with LLM agent-routing — behavior + contract match rapp_brainstem/brainstem.py:
      request : {user_input, conversation_history?, session_id?, agents?: [slugs]}
      response: {response, session_id, agent_logs, voice_mode}   (or {error})
    System prompt = soul.md (+ each loaded agent's system_context()). Tools = each agent's to_tool()
    metadata, rebuilt on every call. Tool name == agent name; up to 3 tool-call rounds; perform(**args).
    `agents` is the loaded set (mirrors brainstem's installed agents); empty → plain soul chat."""
    import uuid
    session_id = session_id or str(uuid.uuid4())
    user_input = (user_input or "").strip()
    if not user_input:
        return {"error": "user_input is required"}
    if not token:
        return {"error": "no token — set RAPP_GH_TOKEN / GITHUB_TOKEN, pass Authorization: Bearer …, or use /run with a slug"}

    instances = _load_instances(agents, registry)            # {} → plain chat (no tools), like brainstem w/ no agents
    extra = ""
    for rec in instances.values():
        try:
            ctx = rec["inst"].system_context()
            if ctx:
                extra += "\n" + ctx
        except Exception:
            pass
    tools = [rec["inst"].to_tool() for rec in instances.values()] or None   # per-agent metadata, every call

    messages = [{"role": "system", "content": load_soul() + extra}]
    messages += [m for m in (conversation_history or []) if m.get("role") in ("user", "assistant", "tool")]
    messages.append({"role": "user", "content": user_input})

    logs, msg = [], {}
    for _ in range(3):                                       # up to 3 tool-call rounds (brainstem parity)
        try:
            resp = _llm(token, messages, tools, model)
        except Exception as e:
            return {"error": f"LLM call failed: {e}"}
        if not resp or "choices" not in resp:
            return {"error": "LLM returned no choices", "detail": resp}
        msg = resp["choices"][0]["message"]
        messages.append(msg)
        tcs = msg.get("tool_calls")
        if not tcs:
            break
        for tc in tcs:
            fn = tc["function"]["name"]
            try:
                args = json.loads(tc["function"].get("arguments") or "{}")
            except Exception:
                args = {}
            rec = instances.get(fn)
            if rec:
                try:
                    result = rec["inst"].perform(**args)
                except Exception as e:
                    result = f"Error: {e}"
            else:
                result = f"Agent '{fn}' not found."
            if not isinstance(result, str):
                result = json.dumps(result, default=str)
            logs.append(f"[{fn}] {result}")
            messages.append({"role": "tool", "tool_call_id": tc.get("id"), "content": result})
    return {"response": msg.get("content") or "", "session_id": session_id,
            "agent_logs": "\n".join(logs), "voice_mode": False}


def list_agents(grep: str | None = None, registry: str | None = None) -> list:
    reg = load_registry(registry)
    out = []
    for a in reg.get("agents", []):
        if grep and grep.lower() not in json.dumps(a).lower():
            continue
        out.append({k: a.get(k) for k in ("name", "display_name", "description", "category", "requires_env", "_file")})
    return out


# ── HTTP server ─────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def log_message(self, *a):  # quiet
        pass

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        path = self.path.split("?")[0]
        q = dict(p.split("=", 1) for p in self.path.split("?", 1)[1].split("&")) if "?" in self.path else {}
        try:
            if path == "/health":
                reg = load_registry()
                self._send(200, {"status": "ok", "agents": len(reg.get("agents", [])),
                                 "runtime": f"CPython {sys.version.split()[0]}",
                                 "registry": "RAR", "sdk": "vbrainstem_sdk/1"})
            elif path == "/agents":
                self._send(200, {"agents": list_agents(q.get("grep"))})
            else:
                self._send(404, {"error": "not found", "path": path})
        except Exception as e:
            self._send(500, {"error": str(e)})

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            b = self._body()
            if path == "/run":
                slug = b.get("slug") or b.get("agent")
                if not slug:
                    return self._send(400, {"error": "missing 'slug'"})
                self._send(200, run_slug(slug, b.get("request"), b.get("args")))
            elif path == "/eval":
                self._send(200, run_eval(b.get("code", "")))
            elif path == "/chat":
                auth = self.headers.get("Authorization", "")
                token = auth.split(None, 1)[1] if auth.lower().startswith("bearer ") else (
                    os.environ.get("RAPP_GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or "")
                self._send(200, chat(b.get("user_input", ""), token, b.get("conversation_history"), b.get("session_id"), b.get("model"), agents=b.get("agents")))
            else:
                self._send(404, {"error": "not found", "path": path})
        except Exception as e:
            self._send(500, {"error": str(e), "trace": traceback.format_exc()[-1000:]})


def serve(port: int, registry: str | None):
    if registry:
        os.environ["RAPP_REGISTRY"] = registry
    reg = load_registry(registry)
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError as e:
        print(f"vbrainstem_sdk: cannot bind port {port} ({e}). Another server (a brainstem?) is there — try --port <other>.", file=sys.stderr)
        sys.exit(1)
    print(f"vbrainstem_sdk: CPython {sys.version.split()[0]} | {len(reg.get('agents', []))} agents | http://localhost:{port}")
    print(f"  GET /health  GET /agents  POST /run {{slug,request}}  POST /eval {{code}}  POST /chat {{message}}")
    httpd.serve_forever()


# ── CLI ───────────────────────────────────────────────────────────────────
def main():
    p = argparse.ArgumentParser(prog="vbrainstem_sdk")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve"); s.add_argument("--port", type=int, default=7173); s.add_argument("--registry")
    g = sub.add_parser("agents"); g.add_argument("--grep"); g.add_argument("--registry")
    r = sub.add_parser("run"); r.add_argument("slug"); r.add_argument("request", nargs="?", default=""); r.add_argument("--arg", action="append", default=[]); r.add_argument("--registry")
    e = sub.add_parser("eval"); e.add_argument("code")
    c = sub.add_parser("chat"); c.add_argument("message"); c.add_argument("--model"); c.add_argument("--registry"); c.add_argument("--agents", help="comma-separated agent slugs to load as tools")
    a = p.parse_args()
    if a.cmd == "serve":
        serve(a.port, a.registry)
    elif a.cmd == "agents":
        for x in list_agents(a.grep, a.registry):
            print(f"{x['name']:48} {x.get('category',''):16} {x.get('display_name','')}")
    elif a.cmd == "run":
        args = dict(kv.split("=", 1) for kv in a.arg)
        print(json.dumps(run_slug(a.slug, a.request, args, a.registry), indent=2))
    elif a.cmd == "eval":
        print(run_eval(a.code)["output"])
    elif a.cmd == "chat":
        token = os.environ.get("RAPP_GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""
        print(json.dumps(chat(a.message, token, None, None, a.model, a.registry,
                              (a.agents.split(",") if a.agents else None)), indent=2))


if __name__ == "__main__":
    main()
