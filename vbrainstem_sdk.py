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
            self.metadata = metadata or getattr(self, "metadata", {})
        def perform(self, **kwargs):
            return "Not implemented."
        def system_context(self):
            return None

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
    print(f"  GET /health  GET /agents  POST /run {{slug,request}}  POST /eval {{code}}")
    httpd.serve_forever()


# ── CLI ───────────────────────────────────────────────────────────────────
def main():
    p = argparse.ArgumentParser(prog="vbrainstem_sdk")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve"); s.add_argument("--port", type=int, default=7173); s.add_argument("--registry")
    g = sub.add_parser("agents"); g.add_argument("--grep"); g.add_argument("--registry")
    r = sub.add_parser("run"); r.add_argument("slug"); r.add_argument("request", nargs="?", default=""); r.add_argument("--arg", action="append", default=[]); r.add_argument("--registry")
    e = sub.add_parser("eval"); e.add_argument("code")
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


if __name__ == "__main__":
    main()
