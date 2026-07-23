#!/usr/bin/env python3
"""
burrow.py — the smallest on-device footprint that gives the in-browser
vBrainstem real-machine access (shell, files, Python), with NO brainstem and
NO VS Code. Standard library only.

It is the Desk Pair host executor, extracted: a loopback HTTP server that
  1. serves a sealed WebRTC pairing page (rapp-neighborhood-protocol/1.0), and
  2. exposes POST /exec — run shell / python / file ops on THIS machine —
     armed, loopback-only, and gated by a per-install secret.

The browser vBrainstem's GitHub Copilot ("Brain Surgeon") pairs to it (scan or
same-device open + type the 6-digit code = human sign-off), then its
run_shell / run_python / read_file / write_file tools execute here, on the real
computer — the same on-device power the local brainstem + Copilot give you,
delivered by one line instead of a full install.

Chat stays in the browser (this host has no brainstem); only the sealed host
ops cross to the machine.

Run:  python3 burrow.py            (installed + launched by the one-liners)
Stop: Ctrl-C, or close the pairing tab.
"""

import http.server
import json
import os
import platform
import secrets
import socket
import sys
import threading
import webbrowser


def _os_label():
    if sys.platform.startswith("win"):
        return "Windows"
    if sys.platform == "darwin":
        return "macOS"
    return platform.system() or sys.platform


PORT = int(os.environ.get("BURROW_PORT", "7188"))
OS_LABEL = _os_label()
HOST_NAME = os.environ.get("BURROW_HOST_NAME", socket.gethostname() or "this computer")
VBRAINSTEM = os.environ.get("BURROW_VBRAINSTEM", "https://kody-w.github.io/vbrainstem/")
HOME = os.path.expanduser("~/.rapp-burrow")


def _secret():
    os.makedirs(HOME, exist_ok=True)
    path = os.path.join(HOME, "secret")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            v = f.read().strip()
        if v:
            return v
    v = secrets.token_hex(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(v)
    return v


def host_exec(req):
    """Run one operation on the real machine. Same contract as Desk Pair."""
    op = (req or {}).get("op")
    try:
        if op == "python":
            import contextlib
            import io as _io
            buf = _io.StringIO()
            ns = host_exec.__dict__.setdefault("_ns", {"__name__": "_burrow_"})
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                code = req.get("code", "")
                try:
                    val = eval(code, ns)  # noqa: S307 — operator-approved
                    if val is not None:
                        print(repr(val))
                except SyntaxError:
                    exec(code, ns)  # noqa: S102 — operator-approved
            return {"output": buf.getvalue()}
        if op == "shell":
            import subprocess
            r = subprocess.run(req.get("command", ""), shell=True, capture_output=True,
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


SECRET = _secret()

PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RAPP Burrow</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0d1117; color:#e6edf3; min-height:100vh;
    display:flex; align-items:center; justify-content:center;
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:22px; padding:34px 38px;
    width:min(440px,94vw); text-align:center; box-shadow:0 18px 60px rgba(1,4,9,.6); }
  h1 { font-size:22px; font-weight:650; margin:0 0 6px; }
  .sub { color:#8b949e; font-size:14px; margin:0 0 18px; }
  #qr { border-radius:14px; background:#fff; padding:8px; width:200px; height:200px; }
  .open { display:inline-block; margin:16px 0 4px; background:#1f6feb; color:#fff; font-weight:600;
    border:none; border-radius:10px; padding:11px 20px; font-size:14px; cursor:pointer; text-decoration:none; }
  .pill { display:inline-flex; align-items:center; gap:7px; background:#0d1117; border:1px solid #30363d;
    border-radius:20px; padding:5px 13px; font-size:12.5px; color:#8b949e; margin-top:14px; }
  .pill .dot { width:8px; height:8px; border-radius:50%; background:#d29922; animation:pulse 1.2s ease-in-out infinite; }
  .pill.ok .dot { background:#3fb950; animation:none; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  .code-entry { display:none; } .code-entry.active { display:block; }
  .boxes { display:flex; justify-content:center; gap:9px; margin:20px 0 6px; }
  .boxes input { width:44px; height:58px; text-align:center; background:#0d1117; border:1px solid #30363d;
    border-radius:12px; color:#e6edf3; font:600 28px ui-monospace,Menlo,monospace; outline:none; }
  .boxes input:focus { border-color:#58a6ff; box-shadow:0 0 0 3px rgba(88,166,255,.25); }
  .err { color:#f85149; font-size:13px; min-height:18px; margin-top:6px; }
  .tick { width:70px; height:70px; border-radius:50%; background:#238636; display:flex; align-items:center;
    justify-content:center; margin:4px auto 16px; }
  .tick svg { width:34px; height:34px; fill:none; stroke:#fff; stroke-width:3; stroke-linecap:round; stroke-linejoin:round; }
  #log { display:none; background:#0d1117; border:1px solid #30363d; border-radius:10px; padding:9px; margin-top:14px;
    font:11.5px/1.5 ui-monospace,monospace; max-height:150px; overflow:auto; text-align:left; color:#8b949e; }
  .paired #log { display:block; }
  .foot { color:#484f58; font-size:11.5px; margin-top:16px; }
</style></head><body>
<div class="card" id="card">
  <div id="pair-panel">
    <h1>🕳️ RAPP Burrow</h1>
    <p class="sub">Give the in-browser vBrainstem access to <b id="hn"></b>.</p>
    <img id="qr" alt="Scan to burrow">
    <div><a class="open" id="open" target="_blank" rel="noopener">Open in vBrainstem →</a></div>
    <div class="pill" id="status"><span class="dot"></span><span id="status-text">starting…</span></div>
  </div>
  <div class="code-entry" id="code-panel">
    <h1>Enter the code from the vBrainstem</h1>
    <p class="sub">Typing it here is your sign-off to let it run on this computer.</p>
    <div class="boxes" id="boxes"></div>
    <div class="err" id="code-err"></div>
  </div>
  <div class="code-entry" id="done-panel">
    <div class="tick"><svg viewBox="0 0 24 24"><polyline points="4 12.5 10 18.5 20 6.5"/></svg></div>
    <h1>Burrowed</h1>
    <p class="sub">GitHub Copilot in the vBrainstem can now run on this computer. Close this tab to end access.</p>
    <div id="log"></div>
  </div>
  <div class="foot">rapp-neighborhood-protocol/1.0 · rapp-sealed/1.0 (AES-256-GCM) · loopback executor, secret-gated</div>
</div>
<script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"></script>
<script>
(function () {
  'use strict';
  var CFG = %%CONFIG%%;
  var $ = function (s) { return document.querySelector(s); };
  $('#hn').textContent = CFG.host_name;
  var logEl = $('#log');
  function log(m){ var d=document.createElement('div'); d.textContent='['+new Date().toLocaleTimeString()+'] '+m; logEl.appendChild(d); logEl.scrollTop=logEl.scrollHeight; }
  function status(t, ok){ $('#status-text').textContent=t; $('#status').classList.toggle('ok',!!ok); }
  function myRappid(){ var r=localStorage.getItem('vb_rappid'); if(!r){ r=(crypto.randomUUID?crypto.randomUUID():'burrow-'+Date.now().toString(36)); localStorage.setItem('vb_rappid',r);} return r; }

  var _b64=function(u8){return btoa(String.fromCharCode.apply(null,new Uint8Array(u8)));};
  var _ub64=function(s){return Uint8Array.from(atob(s),function(c){return c.charCodeAt(0);});};
  var _kc={};
  async function key(secret){ if(_kc[secret])return _kc[secret]; var e=new TextEncoder();
    var base=await crypto.subtle.importKey('raw',e.encode(secret),'PBKDF2',false,['deriveKey']);
    var k=await crypto.subtle.deriveKey({name:'PBKDF2',salt:e.encode('rapp-neighborhood-5a/1'),iterations:210000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    _kc[secret]=k; return k; }
  async function seal(secret,obj){ var k=await key(secret); var iv=crypto.getRandomValues(new Uint8Array(12));
    var ct=await crypto.subtle.encrypt({name:'AES-GCM',iv:iv},k,new TextEncoder().encode(JSON.stringify(obj))); return {schema:'rapp-sealed/1.0',iv:_b64(iv),ct:_b64(ct)}; }
  async function open_(secret,s){ var k=await key(secret); var pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:_ub64(s.iv)},k,_ub64(s.ct)); return JSON.parse(new TextDecoder().decode(pt)); }
  async function sha(s){ var d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)); return Array.from(new Uint8Array(d),function(b){return b.toString(16).padStart(2,'0');}).join(''); }

  var state={ id:null, token:null, pairing:null, pairedPeer:null };

  function showCode(pairing){
    $('#pair-panel').style.display='none'; $('#done-panel').classList.remove('active');
    var pnl=$('#code-panel'); pnl.classList.add('active'); $('#code-err').textContent='';
    var boxes=$('#boxes'); boxes.innerHTML=''; var ins=[];
    for(var i=0;i<6;i++){ var inp=document.createElement('input'); inp.maxLength=1; inp.inputMode='numeric'; boxes.appendChild(inp); ins.push(inp); }
    ins.forEach(function(inp,i){
      inp.addEventListener('input',function(){ inp.value=inp.value.replace(/\D/g,'').slice(0,1); if(inp.value&&i<5)ins[i+1].focus(); if(ins.every(function(x){return x.value;})) submitCode(ins.map(function(x){return x.value;}).join('')); });
      inp.addEventListener('keydown',function(e){ if(e.key==='Backspace'&&!inp.value&&i>0)ins[i-1].focus(); });
    });
    ins[0].focus();
  }
  async function submitCode(code){
    var pairing=state.pairing; if(!pairing)return; state.pairing=null;
    var conn=pairing.conn;
    var hash=await sha(code+'|'+pairing.salt+'|'+state.id+'|'+conn.peer);
    if(hash!==pairing.code_hash){ $('#code-err').textContent="That code didn't match — ask the vBrainstem for a new one."; log('DENIED (wrong code)'); try{conn.send({schema:'rapp-twin-chat/1.0',kind:'pair-denied',from_rappid:myRappid()});}catch(e){} return; }
    var pairSecret=code+'|'+pairing.salt+'|'+state.id+'|'+conn.peer;
    state.token=state.token||(crypto.randomUUID?crypto.randomUUID():'tk-'+Date.now().toString(36));
    state.pairedPeer=conn.peer;
    conn.send(await seal(pairSecret,{schema:'rapp-twin-chat/1.0',kind:'pair-grant',from_rappid:myRappid(),response:{token:state.token,host:CFG.host_name,host_control:true,chat:false,os:CFG.os}}));
    $('#code-panel').classList.remove('active'); $('#done-panel').classList.add('active'); $('#card').classList.add('paired');
    log('BURROWED — '+conn.peer.slice(0,8)+'… can run on '+CFG.host_name);
  }

  async function handle(conn, raw){
    var msg=raw, sealed=false;
    if(raw&&raw.schema==='rapp-sealed/1.0'){ sealed=true; try{ msg=await open_(state.token,raw); }catch(e){ try{conn.send({schema:'rapp-twin-chat/1.0',kind:'resume-denied',from_rappid:myRappid()});}catch(_){} return; } }
    if(!msg||msg.schema!=='rapp-twin-chat/1.0') return;
    var p=msg.payload||{};
    if(msg.kind==='pair-request'){ if(state.pairedPeer){return;} state.pairing={conn:conn,salt:p.salt,code_hash:p.code_hash,device:p.device}; log('pair-request from '+conn.peer.slice(0,8)+'…'); showCode(state.pairing); return; }
    if(sealed&&msg.kind==='resume'){ state.pairedPeer=conn.peer; log('RESUMED '+conn.peer.slice(0,8)+'…'); $('#pair-panel').style.display='none'; $('#code-panel').classList.remove('active'); $('#done-panel').classList.add('active'); $('#card').classList.add('paired'); conn.send(await seal(state.token,{schema:'rapp-twin-chat/1.0',kind:'resume-grant',from_rappid:myRappid(),response:{host:CFG.host_name,host_control:true,chat:false,os:CFG.os}})); return; }
    if(!sealed||conn.peer!==state.pairedPeer){ log('DENIED '+msg.kind); return; }
    var respond=async function(kind,st,resp){ conn.send(await seal(state.token,{schema:'rapp-twin-chat-response/1.0',channel:'5a-tether-sealed',from_rappid:myRappid(),to_rappid:msg.from_rappid,kind:kind,envelope:msg,status:st,response:resp})); };
    if(sealed&&msg.kind==='ping'){ conn.send(await seal(state.token,{schema:'rapp-twin-chat/1.0',kind:'pong',from_rappid:myRappid()})); return; }
    if(msg.kind==='host'){ log('🕳️ host.'+((p.req&&p.req.op)||'?')); var r=await fetch('/exec',{method:'POST',headers:{'Content-Type':'application/json','X-Burrow-Secret':CFG.secret||''},body:JSON.stringify(p.req||{})}); var j=await r.json().catch(function(){return {error:'exec '+r.status};}); await respond('host',r.status,j); return; }
    if(msg.kind==='say'){ await respond('say',501,{error:'This is a burrow host (no brainstem). Chat stays in your vBrainstem; only host ops run here.'}); return; }
  }

  var RETRY={'server-error':1,'network':1,'socket-error':1,'socket-closed':1,'unavailable-id':1};
  function start(attempt){ attempt=attempt||1; status(attempt>1?'reconnecting ('+attempt+')…':'starting…',false);
    var peer=new Peer();
    peer.on('open',function(id){ state.id=id;
      var join=CFG.vbrainstem+'?deskpair='+encodeURIComponent(id)+'&host='+encodeURIComponent(CFG.host_name)+'&burrow=1';
      $('#qr').src='https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=8&data='+encodeURIComponent(join);
      $('#open').href=join;
      status('waiting for the vBrainstem',false); window.__BURROW__={id:id,join:join}; log('hosting — peer '+id);
    });
    peer.on('connection',function(c){ status('vBrainstem connected — enter the code',true); c.on('data',function(m){handle(c,m);}); c.on('close',function(){ if(c.peer===state.pairedPeer){ state.pairedPeer=null; log('vBrainstem left — waiting for resume'); } }); });
    peer.on('error',function(e){ var t=(e&&e.type)||String(e); log('peer error: '+t); if(!state.id&&RETRY[t]&&attempt<6){ try{peer.destroy();}catch(_){} setTimeout(function(){start(attempt+1);},1000*attempt);} else if(!state.id){ status('cannot reach the broker — check the network, reload this tab',false);} });
  }
  start();
})();
</script></body></html>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _loopback(self):
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        return host in ("localhost", "127.0.0.1", "[::1]", "::1")

    def do_GET(self):
        if not self._loopback():
            self.send_error(400, "loopback only")
            return
        if self.path.split("?")[0] not in ("/", "/burrow_host.html"):
            self.send_error(404)
            return
        cfg = {"host_name": HOST_NAME, "secret": SECRET, "vbrainstem": VBRAINSTEM, "os": OS_LABEL}
        body = PAGE.replace("%%CONFIG%%", json.dumps(cfg)).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.split("?")[0] != "/exec":
            self.send_error(404)
            return
        if not self._loopback():
            self.send_error(400, "loopback only")
            return
        if (self.headers.get("X-Burrow-Secret", "") or "") != SECRET:
            self.send_error(403, "bad secret")
            return
        try:
            n = int(self.headers.get("Content-Length", "0") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            self.send_error(400, "bad json")
            return
        body = json.dumps(host_exec(req)).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    port = PORT
    for candidate in range(PORT, PORT + 12):
        try:
            server = http.server.ThreadingHTTPServer(("127.0.0.1", candidate), Handler)
            port = candidate
            break
        except OSError:
            continue
    else:
        raise SystemExit(f"no free port in {PORT}-{PORT + 11}")
    url = f"http://localhost:{port}/burrow_host.html"
    print("🕳️  RAPP Burrow running.")
    print(f"    Machine : {HOST_NAME}")
    print(f"    Pairing : {url}")
    print("    Opening the pairing page… scan/open it in the vBrainstem, then type the code.")
    print("    Ctrl-C to stop (or close the pairing tab).")
    threading.Thread(target=server.serve_forever, daemon=True, name="burrow").start()
    if not os.environ.get("BURROW_NO_OPEN"):
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print("\n🕳️  Burrow stopped.")


if __name__ == "__main__":
    main()
