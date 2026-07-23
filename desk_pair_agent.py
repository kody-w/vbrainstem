"""
desk_pair_agent.py — Desk Pair: pair a phone to THIS computer's brainstem,
Apple-style.

Ask the brainstem to "desk pair my phone" and it opens a pairing page in a
browser tab. The page hosts a sealed WebRTC bridge (rapp-neighborhood-protocol
/1.0, channel 5a-tether) in front of this brainstem's /chat and shows a QR.

The ceremony (deliberately shaped like Apple device pairing):
  1. Scan the QR with the phone — the QR carries ONLY a peer-id. Scanning
     alone grants nothing.
  2. The phone shows a 8-digit pairing code.
  3. The human types that code INTO THE COMPUTER (the pairing page). The code
     never crosses the network — only a salted hash does, and the host gets
     exactly ONE attempt per code.
  4. On match, the session token is sealed to the phone under a key derived
     from the code (AES-256-GCM, rapp-sealed/1.0). From then on the phone is
     a sealed remote control for this brainstem: its messages run here, on
     this machine's agents and memory.

Closing the pairing tab ends the session — exactly like stopping the server.
"""

import functools
import http.server
import json
import os
import secrets
import socket
import threading
import webbrowser

from agents.basic_agent import BasicAgent

PHONE_PAGE = "https://kody-w.github.io/vbrainstem/index.html"
DESKPAIR_PORT = int(os.environ.get("DESKPAIR_PORT", os.environ.get("TETHER_PORT", "7099")))


def _read_or_create_secret(brainstem_dir):
    """The brainstem's per-install secret (.brainstem_secret) gates cross-origin
    callers via the X-Brainstem-Secret header. The pairing page is served from
    its own loopback port (a different origin), so it must carry the header —
    that is the designed same-machine trust path, not a bypass. Mirror the
    server's read-or-generate behavior, including 0600 perms."""
    path = os.path.join(brainstem_dir, ".brainstem_secret")
    try:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                existing = f.read().strip()
            if existing:
                return existing
        value = secrets.token_hex(32)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(value)
        return value
    except Exception:
        return ""


# ── EXPERIMENTAL: host control (the "burrowed brainstem") ──────────────────────
# When explicitly enabled (allow_host_control=True), a paired vBrainstem can
# reach OUT of its browser sandbox and run code on THIS real machine — the same
# power the brainstem has running locally. Off by default. Every gate must hold:
#   1. Desk Pair ceremony done (human typed the 8-digit code) → sealed channel.
#   2. Host control armed here (the opt-in below), else /exec 403s.
#   3. The /exec endpoint is loopback-only and requires the per-install secret.
#   4. All tether traffic is rapp-sealed (AES-256-GCM).
# This runs in the brainstem's native Python process, so it IS the real machine.
_HOST_CONTROL = {"armed": False, "secret": "", "ns": {"__name__": "_deskpair_host_"}}


def _host_exec(req):
    op = (req or {}).get("op")
    try:
        if op == "python":
            import contextlib
            import io as _io
            buf = _io.StringIO()
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                code = req.get("code", "")
                try:
                    val = eval(code, _HOST_CONTROL["ns"])  # noqa: S307 — operator-approved
                    if val is not None:
                        print(repr(val))
                except SyntaxError:
                    exec(code, _HOST_CONTROL["ns"])  # noqa: S102 — operator-approved
            return {"output": buf.getvalue()}
        if op == "shell":
            import subprocess
            r = subprocess.run(
                req.get("command", ""), shell=True, capture_output=True,
                text=True, timeout=req.get("timeout", 120))
            return {"output": (r.stdout or "") + (r.stderr or ""), "code": r.returncode}
        if op == "read":
            with open(os.path.expanduser(req.get("path", "")), encoding="utf-8", errors="replace") as f:
                return {"content": f.read()}
        if op == "write":
            p = os.path.expanduser(req.get("path", ""))
            d = os.path.dirname(p)
            if d:
                os.makedirs(d, exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(req.get("content", ""))
            return {"ok": True, "path": p}
        if op == "list":
            p = os.path.expanduser(req.get("path", ".") or ".")
            return {"path": p, "files": sorted(os.listdir(p))}
        return {"error": "unknown op: " + str(op)}
    except Exception as e:
        return {"error": str(e)}


class _TetherPageHandler(http.server.SimpleHTTPRequestHandler):
    """Serves ONLY the tether directory, loopback Host values only, no listing.
    Also hosts POST /exec (host control) — armed + secret-gated + loopback."""

    def log_message(self, *args):
        pass

    def _loopback(self):
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        return host in ("localhost", "127.0.0.1", "[::1]", "::1")

    def do_GET(self):
        if not self._loopback():
            self.send_error(400, "loopback only")
            return
        if self.path.split("?")[0] not in ("/desk_pair_host.html",):
            self.send_error(404)
            return
        super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/exec":
            self.send_error(404)
            return
        if not self._loopback():
            self.send_error(400, "loopback only")
            return
        if not _HOST_CONTROL["armed"]:
            self.send_error(403, "host control not enabled")
            return
        supplied = self.headers.get("X-Brainstem-Secret", "") or ""
        if not _HOST_CONTROL["secret"] or supplied != _HOST_CONTROL["secret"]:
            self.send_error(403, "bad secret")
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
            req = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self.send_error(400, "bad json")
            return
        body = json.dumps(_host_exec(req)).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def _serve_tether_dir(directory, start_port):
    """Start (or reuse) the loopback page server. Walk a small port range:
    reuse a busy port only if it actually serves THIS page (an older server
    thread from a previous agent version may hold the port but 404 the new
    filename); otherwise bind the next free port. Returns the port, or None."""
    import urllib.request
    for port in range(start_port, start_port + 10):
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.settimeout(0.3)
        in_use = probe.connect_ex(("127.0.0.1", port)) == 0
        probe.close()
        if in_use:
            # Reuse ONLY a server of the current code version: it must serve the
            # page AND expose POST /exec (a stale thread from an older agent
            # version 501s on POST and would break host control). A 403 here =
            # the new handler (host-control/secret gate); reuse it.
            try:
                r = urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/desk_pair_host.html", timeout=1)
                if r.status != 200:
                    continue
            except Exception:
                continue
            try:
                req = urllib.request.Request(
                    f"http://127.0.0.1:{port}/exec", data=b"{}", method="POST",
                    headers={"Content-Type": "application/json"})
                urllib.request.urlopen(req, timeout=1)
                continue  # 2xx without a secret should never happen — treat as foreign
            except urllib.error.HTTPError as he:
                if he.code == 403:
                    return port      # current-version handler
                continue             # 501/404/etc → stale version, keep walking
            except Exception:
                continue
        try:
            handler = functools.partial(_TetherPageHandler, directory=directory)
            server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
            threading.Thread(target=server.serve_forever, daemon=True,
                             name="deskpair-page-server").start()
            return port
        except Exception:
            continue
    return None

__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@kody-w/desk_pair",
    "version": "1.0.0",
    "display_name": "Desk Pair",
    "description": "Opens a QR pairing page so a phone can become a sealed remote control for this brainstem — Apple-style: scan, then type the phone's code into the computer to confirm.",
    "author": "kody-w",
    "tags": ["deskpair", "tether", "neighborhood", "webrtc", "pairing", "remote"],
    "category": "platform",
    "quality_tier": "official",
    "requires_env": [],
    "example_call": "Desk pair my phone to this brainstem",
}


class DeskPairAgent(BasicAgent):
    def __init__(self):
        self.name = "DeskPair"
        self.metadata = {
            "name": self.name,
            "description": (
                "Desk Pair: pair a phone (or any other device) to this computer's brainstem as a "
                "remote control. Opens a browser tab with a QR code; the user scans it, "
                "the phone shows a 8-digit code, and typing that code into the computer "
                "completes the tether. Use when the user asks to desk pair, tether, pair, link, or "
                "control this brainstem from their phone."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "brainstem_url": {
                        "type": "string",
                        "description": (
                            "Base URL of the brainstem the phone should control. "
                            "Defaults to this local brainstem, http://localhost:7071."
                        ),
                    },
                    "open_browser": {
                        "type": "boolean",
                        "description": (
                            "Open the pairing page in a browser tab (default true). "
                            "Set false to only write the page and return its path."
                        ),
                    },
                    "allow_host_control": {
                        "type": "boolean",
                        "description": (
                            "EXPERIMENTAL. Default false. When true, a paired device may run "
                            "code, shell commands, and file operations on THIS real computer "
                            "(the 'burrowed brainstem') over the sealed channel — the same power "
                            "the brainstem has locally. Only enable when the user explicitly asks "
                            "to control the full computer from the paired device."
                        ),
                    },
                },
                "required": [],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        bs_url = (kwargs.get("brainstem_url") or "http://localhost:7071").rstrip("/")
        open_browser = kwargs.get("open_browser", True)
        if isinstance(open_browser, str):
            open_browser = open_browser.strip().lower() not in ("false", "0", "no")
        allow_host_control = kwargs.get("allow_host_control", False)
        if isinstance(allow_host_control, str):
            allow_host_control = allow_host_control.strip().lower() in ("true", "1", "yes")

        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        out_dir = os.path.join(base_dir, ".brainstem_data", "deskpair")
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, "desk_pair_host.html")

        secret = _read_or_create_secret(base_dir)
        # Arm (or disarm) host control for this run. Off unless explicitly asked.
        _HOST_CONTROL["armed"] = bool(allow_host_control)
        _HOST_CONTROL["secret"] = secret
        config = {
            "bs": bs_url,
            "secret": secret,
            "phone_page": os.environ.get("DESKPAIR_PHONE_PAGE", os.environ.get("TETHER_PHONE_PAGE", PHONE_PAGE)),
            "host_name": os.environ.get("DESKPAIR_HOST_NAME", os.environ.get("TETHER_HOST_NAME", "your computer")),
            "host_control": bool(allow_host_control),
            "session": secrets.token_hex(4),
        }
        html = _HOST_PAGE.replace("%%CONFIG%%", json.dumps(config))
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(html)
        try:
            os.chmod(out_path, 0o600)
        except Exception:
            pass

        port = _serve_tether_dir(out_dir, DESKPAIR_PORT)
        if not port:
            return (
                "Could not start the local pairing-page server (ports "
                f"{DESKPAIR_PORT}-{DESKPAIR_PORT + 9} all unusable). Set "
                "DESKPAIR_PORT to a free port and try again."
            )
        page_url = f"http://localhost:{port}/desk_pair_host.html"

        opened = False
        if open_browser:
            try:
                opened = webbrowser.open(page_url)
            except Exception:
                opened = False

        return (
            f"Desk Pair page ready{' — opening it in your browser now' if opened else ''}.\n\n"
            f"1. On the page that {'just opened' if opened else f'is at {page_url}'}, "
            f"a QR code appears.\n"
            f"2. Scan it with your phone's camera — the phone shows a 8-digit pairing code.\n"
            f"3. Type that code into the pairing page on this computer. That typed code is the "
            f"human sign-off: until you enter it, the phone can't control anything.\n\n"
            f"Once paired, your phone drives THIS brainstem ({bs_url}) over an end-to-end "
            f"sealed channel (rapp-sealed/1.0). Close the pairing tab to end the session."
        )


# ═══════════════════════════════════════════════════════════════════════
# The host pairing page. Adapted from vbrainstem's brainstem_bridge.html
# (same sealed codec, same twin-chat envelopes) plus the Apple-style
# pairing ceremony: QR carries only the peer-id; control requires the
# phone's code typed here; one attempt per code.
# ═══════════════════════════════════════════════════════════════════════
_HOST_PAGE = r"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Desk Pair</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0d1117; color:#e6edf3;
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    min-height:100vh; display:flex; align-items:center; justify-content:center; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:22px;
    padding:34px 38px; width:min(430px, 94vw); text-align:center;
    box-shadow:0 18px 60px rgba(1,4,9,.6); }
  h1 { font-size:22px; font-weight:650; letter-spacing:-.01em; margin:0 0 6px; }
  .sub { color:#8b949e; font-size:14px; margin:0 0 18px; }
  #qr { border-radius:14px; background:#fff; padding:8px; width:220px; height:220px; }
  .pill { display:inline-flex; align-items:center; gap:7px; background:#0d1117;
    border:1px solid #30363d; border-radius:20px; padding:5px 13px; font-size:12.5px;
    color:#8b949e; margin-top:16px; }
  .pill .dot { width:8px; height:8px; border-radius:50%; background:#d29922;
    animation: pulse 1.2s ease-in-out infinite; }
  .pill.ok .dot { background:#3fb950; animation:none; }
  @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:.3 } }
  .code-entry { display:none; }
  .code-entry.active { display:block; animation: rise .4s cubic-bezier(.2,.9,.3,1.2); }
  @keyframes rise { from { opacity:0; transform: translateY(14px) scale(.98); } }
  .device { font-weight:600; color:#e6edf3; }
  .boxes { display:flex; justify-content:center; gap:9px; margin:20px 0 6px; }
  .boxes input { width:46px; height:60px; text-align:center; background:#0d1117;
    border:1px solid #30363d; border-radius:12px; color:#e6edf3;
    font:600 30px ui-monospace,SFMono-Regular,Menlo,monospace; outline:none; }
  .boxes input:focus { border-color:#58a6ff; box-shadow:0 0 0 3px rgba(88,166,255,.25); }
  .err { color:#f85149; font-size:13px; min-height:20px; margin-top:8px; }
  .tick { width:72px; height:72px; border-radius:50%; background:#238636; display:flex;
    align-items:center; justify-content:center; margin:6px auto 18px;
    animation: pop .4s cubic-bezier(.2,.9,.3,1.4); }
  .tick svg { width:36px; height:36px; fill:none; stroke:#fff; stroke-width:3;
    stroke-linecap:round; stroke-linejoin:round; }
  @keyframes pop { from { transform: scale(.4); opacity:0; } }
  #log { display:none; background:#0d1117; border:1px solid #30363d; border-radius:10px;
    padding:10px; font:11.5px/1.5 ui-monospace,monospace; max-height:150px; overflow:auto;
    white-space:pre-wrap; text-align:left; margin-top:16px; color:#8b949e; }
  .paired #log { display:block; }
  .foot { color:#484f58; font-size:11.5px; margin-top:18px; }
</style>
</head><body>
<div class="card" id="card">
  <div id="scan-panel">
    <h1>Desk Pair</h1>
    <p class="sub">Scan with your phone's camera to pair it with this brainstem.</p>
    <img id="qr" alt="Scan to pair">
    <div class="pill" id="status"><span class="dot"></span><span id="status-text">starting…</span></div>
  </div>
  <div class="code-entry" id="code-panel">
    <h1>Enter the code shown on <span class="device" id="dev-name">the device</span></h1>
    <p class="sub">This confirms you — a human at this computer — approve the pair.</p>
    <div class="boxes" id="boxes"></div>
    <div class="err" id="code-err"></div>
  </div>
  <div class="code-entry" id="done-panel">
    <div class="tick"><svg viewBox="0 0 24 24"><polyline points="4 12.5 10 18.5 20 6.5"/></svg></div>
    <h1>Paired</h1>
    <p class="sub"><span class="device" id="dev-name2">The device</span> now drives this brainstem
      over a sealed channel. Close this tab to end the session.</p>
    <div id="log"></div>
  </div>
  <div class="foot">rapp-neighborhood-protocol/1.0 · rapp-sealed/1.0 (AES-256-GCM) ·
    the QR grants nothing without the typed code</div>
</div>

<script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"></script>
<script>
(function () {
  'use strict';
  var CFG = %%CONFIG%%;
  var $ = function (s) { return document.querySelector(s); };
  var logEl = $('#log');
  function log(msg) {
    var d = document.createElement('div');
    d.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight;
  }
  function status(t, ok) {
    $('#status-text').textContent = t;
    $('#status').classList.toggle('ok', !!ok);
  }
  function myRappid() {
    var r = localStorage.getItem('vb_rappid');
    if (!r) { r = (crypto.randomUUID ? crypto.randomUUID() : 'host-' + Date.now().toString(36)); localStorage.setItem('vb_rappid', r); }
    return r;
  }

  // ── rapp-sealed/1.0 codec — identical scheme/salt to the vBrainstem ──
  var _b64 = function (u8) { return btoa(String.fromCharCode.apply(null, new Uint8Array(u8))); };
  var _ub64 = function (s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); };
  var _keyCache = {};
  async function _channelKey(secret) {
    if (!secret) throw new Error('sealed channel needs a secret');
    if (_keyCache[secret]) return _keyCache[secret];
    var enc = new TextEncoder();
    var base = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
    var key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode('rapp-neighborhood-5a/1'), iterations: 210000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    _keyCache[secret] = key; return key;
  }
  async function seal(secret, obj) {
    var key = await _channelKey(secret);
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
    return { schema: 'rapp-sealed/1.0', iv: _b64(iv), ct: _b64(ct) };
  }
  async function open_(secret, sealed) {
    var key = await _channelKey(secret);
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: _ub64(sealed.iv) }, key, _ub64(sealed.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  async function sha256hex(s) {
    var d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(d), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  // ── Local brainstem plumbing (the exact brainstem.py /chat contract) ──
  // This page has a different loopback origin than the brainstem, so every
  // call carries the per-install secret — the brainstem's designed
  // same-machine trust header (X-Brainstem-Secret).
  function bsHeaders(extra) {
    var h = extra || {};
    if (CFG.secret) h['X-Brainstem-Secret'] = CFG.secret;
    return h;
  }
  async function bsChat(text, history, session) {
    var r = await fetch(CFG.bs.replace(/\/$/, '') + '/chat', {
      method: 'POST', headers: bsHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ user_input: String(text || ''), conversation_history: history || [], session_id: session || 'tether' })
    });
    if (!r.ok) throw new Error('brainstem ' + r.status);
    return await r.json();
  }
  async function bsGet(path) {
    var r = await fetch(CFG.bs.replace(/\/$/, '') + path, { headers: bsHeaders() });
    if (!r.ok) throw new Error('brainstem ' + r.status);
    return await r.json();
  }

  // ── Pairing state ──
  // token: minted at host, NEVER in the QR. Released to the phone only inside
  // a grant sealed under the code-derived key — i.e. only after the human
  // types the phone's code here. One attempt per pair-request.
  var state = { peer: null, id: null, token: null, conns: {}, pairing: null, pairedPeer: null };

  function showCodeEntry(pairing) {
    $('#scan-panel').style.display = 'none';
    $('#done-panel').classList.remove('active');
    var p = $('#code-panel');
    p.classList.add('active');
    $('#dev-name').textContent = pairing.device || 'the device';
    $('#code-err').textContent = '';
    var boxes = $('#boxes');
    boxes.innerHTML = '';
    var inputs = [];
    for (var i = 0; i < 8; i++) {
      var inp = document.createElement('input');
      inp.maxLength = 1; inp.inputMode = 'numeric'; inp.autocomplete = 'off';
      boxes.appendChild(inp); inputs.push(inp);
    }
    inputs.forEach(function (inp, i) {
      inp.addEventListener('input', function () {
        inp.value = inp.value.replace(/\D/g, '').slice(0, 1);
        if (inp.value && i < 5) inputs[i + 1].focus();
        if (inputs.every(function (x) { return x.value; })) submitCode(inputs.map(function (x) { return x.value; }).join(''));
      });
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace' && !inp.value && i > 0) inputs[i - 1].focus();
      });
      inp.addEventListener('paste', function (e) {
        var t = (e.clipboardData.getData('text') || '').replace(/\D/g, '');
        if (t.length >= 8) {
          e.preventDefault();
          inputs.forEach(function (x, j) { x.value = t[j] || ''; });
          submitCode(t.slice(0, 8));
        }
      });
    });
    inputs[0].focus();
  }

  async function submitCode(code) {
    var pairing = state.pairing;
    if (!pairing) return;
    state.pairing = null;                       // ONE attempt per pair-request
    var conn = pairing.conn;
    var hash = await sha256hex(code + '|' + pairing.salt + '|' + state.id + '|' + conn.peer);
    if (hash !== pairing.code_hash) {
      $('#code-err').textContent = "That code didn't match — ask the phone for a new one.";
      log('DENIED pairing (wrong code) from ' + conn.peer.slice(0, 8));
      try { conn.send({ schema: 'rapp-twin-chat/1.0', kind: 'pair-denied', from_rappid: myRappid() }); } catch (e) { }
      return;
    }
    // Human sign-off complete → release the session token under the
    // code-derived key. The code itself never crossed the network.
    var pairSecret = code + '|' + pairing.salt + '|' + state.id + '|' + conn.peer;
    state.token = state.token || (crypto.randomUUID ? crypto.randomUUID() : 'tk-' + Date.now().toString(36));
    state.pairedPeer = conn.peer;
    conn.send(await seal(pairSecret, {
      schema: 'rapp-twin-chat/1.0', kind: 'pair-grant', from_rappid: myRappid(),
      response: { token: state.token, host: CFG.host_name, host_control: !!CFG.host_control }
    }));
    $('#code-panel').classList.remove('active');
    $('#done-panel').classList.add('active');
    $('#dev-name2').textContent = pairing.device || 'The device';
    document.getElementById('card').classList.add('paired');
    log('PAIRED — ' + conn.peer.slice(0, 8) + '… now drives ' + CFG.bs);
  }

  // ── Envelope handling (twin-chat, sealed after pairing) ──
  async function handle(conn, raw) {
    var msg = raw, sealed = false;
    if (raw && raw.schema === 'rapp-sealed/1.0') {
      sealed = true;
      try { msg = await open_(state.token, raw); }
      catch (e) {
        // A stale token (this page was re-run since the phone paired) decrypts
        // to nothing — tell the phone plainly so it falls back to a fresh
        // pairing ceremony instead of hanging.
        log('DENIED sealed message (decrypt/auth failed)');
        try { conn.send({ schema: 'rapp-twin-chat/1.0', kind: 'resume-denied', from_rappid: myRappid() }); } catch (err) { }
        return;
      }
    }
    if (!msg || msg.schema !== 'rapp-twin-chat/1.0') return;
    var p = msg.payload || {};

    if (sealed && msg.kind === 'ping') {
      conn.send(await seal(state.token, { schema: 'rapp-twin-chat/1.0', kind: 'pong', from_rappid: myRappid() }));
      return;
    }
    if (msg.kind === 'pair-request') {
      if (state.pairedPeer) { log('ignored pair-request while paired'); return; }
      state.pairing = { conn: conn, salt: p.salt, code_hash: p.code_hash, device: p.device };
      log('pair-request from ' + conn.peer.slice(0, 8) + '… (' + (p.device || 'device') + ')');
      showCodeEntry(state.pairing);
      return;
    }

    // Desk Pair resume: a SEALED resume proves possession of the granted
    // token (the human-approved session). Re-bind it to the phone's new
    // peer-id — network hops and reloads change that id every time.
    if (sealed && msg.kind === 'resume') {
      state.pairedPeer = conn.peer;
      log('RESUMED — ' + conn.peer.slice(0, 8) + '… re-attached by key possession');
      $('#scan-panel').style.display = 'none';
      $('#code-panel').classList.remove('active');
      $('#done-panel').classList.add('active');
      document.getElementById('card').classList.add('paired');
      conn.send(await seal(state.token, {
        schema: 'rapp-twin-chat/1.0', kind: 'resume-grant', from_rappid: myRappid(),
        response: { host: CFG.host_name, host_control: !!CFG.host_control }
      }));
      return;
    }

    // Control requires the seal (key possession = the granted token).
    if (!sealed || conn.peer !== state.pairedPeer) {
      log('DENIED ' + msg.kind + ' (unsealed or unpaired peer)');
      return;
    }
    var respond = async function (kind, statusCode, response) {
      var out = {
        schema: 'rapp-twin-chat-response/1.0', channel: '5a-tether-sealed',
        from_rappid: myRappid(), to_rappid: msg.from_rappid,
        kind: kind, envelope: msg, status: statusCode, response: response
      };
      conn.send(await seal(state.token, out));
    };
    try {
      if (msg.kind === 'say') {
        log('🔒 say ← ' + JSON.stringify(String(p.text || '').slice(0, 60)));
        var reply = await bsChat(p.text, p.conversation_history, p.session_id);
        log('/chat → ' + JSON.stringify(String(reply && reply.response || '').slice(0, 60)));
        await respond('say', 200, reply);
      } else if (msg.kind === 'console') {
        if (p.method === 'health') await respond('console', 200, await bsGet('/health'));
        else if (p.method === 'agents') { var h = await bsGet('/health'); await respond('console', 200, { agents: h.agents || [] }); }
        else await respond('console', 400, { error: 'desk pair supports: say, console.health, console.agents' });
      } else if (msg.kind === 'host') {
        // EXPERIMENTAL burrow: run on THIS real machine via the loopback /exec
        // executor (armed by allow_host_control; secret-gated; loopback-only).
        if (!CFG.host_control) { await respond('host', 403, { error: 'host control not enabled on this computer' }); return; }
        log('🕳️ host.' + ((p.req && p.req.op) || '?') + ' ← burrow');
        var er = await fetch('/exec', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Brainstem-Secret': CFG.secret || '' },
          body: JSON.stringify(p.req || {})
        });
        var ej = await er.json().catch(function () { return { error: 'exec ' + er.status }; });
        await respond('host', er.status, ej);
      }
    } catch (e) {
      log('ERR ' + ((e && e.message) || e));
      respond(msg.kind, 502, { error: (e && e.message) || String(e) });
    }
  }

  // ── Boot ──
  bsGet('/health').then(function (h) {
    log('brainstem ok — v' + (h.version || '?') + ', ' + ((h.agents || []).length) + ' agents');
  }).catch(function () { log('warning: brainstem unreachable at ' + CFG.bs); });

  // The public PeerJS broker occasionally refuses a connection — recreate the
  // peer with backoff instead of dying on the first hiccup.
  var RETRYABLE = { 'server-error': 1, 'network': 1, 'socket-error': 1, 'socket-closed': 1, 'unavailable-id': 1 };
  function startPeer(attempt) {
    attempt = attempt || 1;
    status(attempt > 1 ? 'reconnecting to the broker (try ' + attempt + ')…' : 'starting…', false);
    var peer = new Peer();
    state.peer = peer;
    peer.on('open', function (id) {
      state.id = id;
      var join = CFG.phone_page + '?deskpair=' + encodeURIComponent(id) +
        '&host=' + encodeURIComponent(CFG.host_name);
      $('#qr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=440x440&margin=8&data=' + encodeURIComponent(join);
      status('waiting for a scan', false);
      window.__DESKPAIR__ = window.__TETHER__ = { id: id, join: join };   // test hook
      log('hosting — peer ' + id);
    });
    peer.on('connection', function (c) {
      state.conns[c.peer] = c;
      status('device connected — waiting for the code', true);
      c.on('data', function (m) { handle(c, m); });
      c.on('close', function () {
        delete state.conns[c.peer];
        // Keep the token: the phone resumes by key possession after a network
        // hop. The session only truly ends when this tab closes.
        if (c.peer === state.pairedPeer) {
          state.pairedPeer = null;
          log('paired device disconnected — waiting for it to resume');
        }
      });
    });
    peer.on('error', function (e) {
      var t = (e && e.type) || String(e);
      log('peer error: ' + t);
      if (!state.id && RETRYABLE[t] && attempt < 6) {
        try { peer.destroy(); } catch (err) { }
        setTimeout(function () { startPeer(attempt + 1); }, 1000 * attempt);
      } else if (!state.id) {
        status('cannot reach the broker — check the network, then reload this tab', false);
      } else {
        status('error: ' + t, false);
      }
    });
  }
  startPeer();
})();
</script>
</body></html>
"""
