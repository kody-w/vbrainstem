#!/bin/bash
# doorman_selftest.sh — prove THIS machine can be a sealed neighborhood doorman.
#
# Hosts the Brainstem Bridge (fronting the local brainstem) in headless Chrome, then a
# SEPARATE, E2E-SEALED vbridge peer drives it. Exits 0 only if the real local brainstem
# answered over the AES-256-GCM-sealed channel. Run it from a fresh checkout or let it
# fetch the tools itself. OS-portable (macOS / Linux Chrome auto-detect).
#
#   BRAINSTEM_URL=http://localhost:7077 bash doorman_selftest.sh
set +e
BRAINSTEM="${BRAINSTEM_URL:-http://localhost:7077}"
SDIR="$(cd "$(dirname "$0")" && pwd)"
RAW="https://raw.githubusercontent.com/kody-w/vbrainstem/main"

# --- detect Chrome / Chromium ---
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "$(command -v google-chrome 2>/dev/null)" "$(command -v google-chrome-stable 2>/dev/null)" \
           "$(command -v chromium 2>/dev/null)" "$(command -v chromium-browser 2>/dev/null)"; do
    [ -n "$c" ] && [ -x "$c" ] && { CHROME="$c"; break; }
  done
fi
[ -z "$CHROME" ] && { echo "FAIL: Chrome/Chromium not found — set CHROME=/path/to/chrome"; exit 1; }
command -v node >/dev/null || { echo "FAIL: node not found (need Node >= 18 for kited_twin.js / CDP)"; exit 1; }
echo "chrome:    $CHROME"
echo "node:      $(node -v)"
echo "brainstem: $BRAINSTEM"

# --- brainstem health ---
H=$(curl -s -m 5 "$BRAINSTEM/health")
echo "$H" | grep -q '"status"' || { echo "FAIL: no brainstem at $BRAINSTEM — start it first. got: $H"; exit 1; }
echo "brainstem health: OK"

WORK=$(mktemp -d); cd "$WORK" || exit 1
fetch(){ if [ -f "$SDIR/$1" ]; then cp "$SDIR/$1" "$1"; else curl -fsSL "$RAW/$1" -o "$1" || { echo "FAIL: cannot fetch $1"; exit 1; }; fi; }
fetch brainstem_bridge.html
fetch vbridge.sh

# --- host page: auto-host the bridge + publish {peer_id, token} ---
BS="$BRAINSTEM" python3 - <<'PY'
import os
html=open('brainstem_bridge.html').read()
driver=('<script>\n'
 'window.addEventListener("load",()=>setTimeout(async()=>{\n'
 ' try{ document.querySelector("#bs").value=%r; await host();\n'
 '  const t=setInterval(()=>{ if(_state.id&&_state.token){ clearInterval(t);\n'
 '   fetch("/hostinfo",{method:"POST",body:JSON.stringify({peer_id:_state.id,token:_state.token})}); } },300);\n'
 '  setTimeout(()=>{ if(!_state.id) fetch("/hostinfo",{method:"POST",body:JSON.stringify({err:"no peer id"})}); },12000);\n'
 ' }catch(e){ fetch("/hostinfo",{method:"POST",body:JSON.stringify({err:String((e&&e.message)||e)})}); }\n'
 '},900));\n</script>') % os.environ['BS']
open('host.html','w').write(html.replace('</body>',driver+'</body>',1))
PY

rm -f hostinfo.json
python3 - <<'PY' &
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_GET(self):
        b=open('host.html','rb').read(); self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        n=int(self.headers.get('Content-Length',0)); open('hostinfo.json','wb').write(self.rfile.read(n))
        self.send_response(200); self.send_header('Access-Control-Allow-Origin','*'); self.end_headers(); self.wfile.write(b'ok')
socketserver.TCPServer.allow_reuse_address=True
socketserver.TCPServer(('127.0.0.1',8796),H).serve_forever()
PY
SV=$!
sleep 1
"$CHROME" --headless=new --no-sandbox --disable-gpu --no-first-run --user-data-dir="$WORK/prof" --remote-debugging-port=9337 "http://localhost:8796/" >chrome.log 2>&1 &
CH=$!
for i in $(seq 1 30); do [ -s hostinfo.json ] && break; sleep 1; done
PEER=$(python3 -c "import json;print(json.load(open('hostinfo.json')).get('peer_id',''))" 2>/dev/null)
TOKEN=$(python3 -c "import json;print(json.load(open('hostinfo.json')).get('token',''))" 2>/dev/null)
if [ -z "$PEER" ]; then echo "FAIL: bridge did not host:"; cat hostinfo.json 2>/dev/null; kill -9 $CH $SV 2>/dev/null; exit 1; fi
echo "bridge hosting (sealed): peer=$PEER"

# --- a SEPARATE sealed vbridge peer drives the bridge → local brainstem ---
CHROME="$CHROME" VBRIDGE_PORT=8795 VBRIDGE_DBG=9340 bash vbridge.sh "$PEER" "$TOKEN" ask "Reply with exactly: DOORMAN_OK" > out.json 2>/dev/null
echo "sealed round-trip: $(cat out.json 2>/dev/null)"
kill -9 $CH $SV 2>/dev/null
if grep -q '"sealed":true' out.json && grep -q 'DOORMAN_OK' out.json; then
  echo "PASS ✅ — this machine is a working sealed doorman (remote peer reached the local brainstem, E2E encrypted)."; rm -rf "$WORK"; exit 0
else
  echo "FAIL — inspect $WORK/out.json and $WORK/chrome.log"; exit 1
fi
