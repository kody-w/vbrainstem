#!/bin/bash
# vbridge.sh — operate a hosted vBrainstem neighborhood from the command line.
# Claude (or anything with a shell) becomes a peer: joins the host's peer-id over the
# PeerJS broker + WebRTC, sends ONE twin-chat envelope, prints the §6e response, exits.
# This is the CLI half of the tether — pair it with `curl localhost:7077/chat` (the local
# brainstem) and you can relay between the local brainstem and a live vBrainstem tab.
#
# Usage:
#   vbridge.sh <peer_id> <token> ask    "<text>"              # chat (kind:say) — token optional
#   vbridge.sh <peer_id> <token> eval   "<python>"            # console: rapp.eval(code)
#   vbridge.sh <peer_id> <token> run    "<@pub/slug>" "<req>" # console: rapp.run(slug, req)
#   vbridge.sh <peer_id> <token> chat   "<text>"              # console: rapp.chat({user_input})
#   vbridge.sh <peer_id> <token> agents ["<grep>"]            # console: rapp.agents(grep)
#   vbridge.sh <peer_id> <token> health                       # console: rapp.health()
set +e
PEER="$1"; TOKEN="$2"; CMD="$3"; ARG1="$4"; ARG2="$5"
[ -z "$PEER" ] && { echo "usage: vbridge.sh <peer_id> <token> <ask|eval|run|chat|agents|health> [args...]"; exit 2; }
PORT="${VBRIDGE_PORT:-8795}"
DBG="${VBRIDGE_DBG:-9336}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

# Build the operator page (envelope assembled safely in Python from the args).
PEER="$PEER" TOKEN="$TOKEN" CMD="$CMD" ARG1="$ARG1" ARG2="$ARG2" python3 - <<'PY'
import os, json
peer, token, cmd = os.environ['PEER'], os.environ['TOKEN'], os.environ['CMD']
a1, a2 = os.environ.get('ARG1',''), os.environ.get('ARG2','')
if   cmd == 'ask':    kind, payload = 'say', {'text': a1, 'token': token}
elif cmd == 'eval':   kind, payload = 'console', {'method':'eval','args':[a1],'token':token}
elif cmd == 'run':    kind, payload = 'console', {'method':'run','args':([a1,a2] if a2 else [a1]),'token':token}
elif cmd == 'chat':   kind, payload = 'console', {'method':'chat','args':[{'user_input':a1}],'token':token}
elif cmd == 'agents': kind, payload = 'console', {'method':'agents','args':([a1] if a1 else []),'token':token}
elif cmd == 'health': kind, payload = 'console', {'method':'health','args':[],'token':token}
else:                 kind, payload = 'console', {'method':cmd,'args':([a1] if a1 else []),'token':token}
page = '''<!doctype html><meta charset=utf-8><title>vbridge</title>
<script src="https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js"></script>
<script>
const PEER=%s, KIND=%s, PAYLOAD=%s, SECRET=%s, SEAL=%s;
// §5a sealed channel — same AES-256-GCM scheme/salt as the vBrainstem & bridge.
const _b64=u8=>btoa(String.fromCharCode.apply(null,new Uint8Array(u8)));
const _ub64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const _kc={};
async function _ck(s){ if(_kc[s])return _kc[s]; const e=new TextEncoder();
  const b=await crypto.subtle.importKey('raw',e.encode(s),'PBKDF2',false,['deriveKey']);
  const k=await crypto.subtle.deriveKey({name:'PBKDF2',salt:e.encode('rapp-neighborhood-5a/1'),iterations:210000,hash:'SHA-256'},b,{name:'AES-GCM',length:256},false,['encrypt','decrypt']); _kc[s]=k; return k; }
async function _seal(s,o){ const k=await _ck(s); const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},k,new TextEncoder().encode(JSON.stringify(o))); return {schema:'rapp-sealed/1.0',iv:_b64(iv),ct:_b64(ct)}; }
async function _open(s,sl){ const k=await _ck(s); const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:_ub64(sl.iv)},k,_ub64(sl.ct)); return JSON.parse(new TextDecoder().decode(pt)); }
window.addEventListener('load',()=>setTimeout(async()=>{
 const post=o=>fetch('/result',{method:'POST',body:JSON.stringify(o)});
 try{
  const p=new Peer();
  p.on('error',e=>post({ok:false,stage:'peer',err:String((e&&e.type)||e)}));
  p.on('open',()=>{
   const c=p.connect(PEER,{reliable:true});
   c.on('error',e=>post({ok:false,stage:'conn',err:String((e&&e.type)||e)}));
   c.on('open',async()=>{
    const nonce='vbridge-'+Math.random().toString(36).slice(2);
    const env={schema:'rapp-twin-chat/1.0',from_rappid:'claude-bridge',to_rappid:PEER,
               utc:new Date().toISOString(),nonce:nonce,kind:KIND,payload:PAYLOAD,facets:[]};
    c.on('data',async m=>{ let r=m;
      if(m&&m.schema==='rapp-sealed/1.0'){ if(!SEAL)return; try{ r=await _open(SECRET,m);}catch(e){return;} }
      if(r&&r.schema==='rapp-twin-chat-response/1.0'&&r.envelope&&r.envelope.nonce===nonce)
        post({ok:true,sealed:!!SEAL,status:r.status,kind:r.kind,response:r.response}); });
    c.send(SEAL ? await _seal(SECRET,env) : env);
   });
  });
  setTimeout(()=>post({ok:false,stage:'timeout'}),25000);
 }catch(e){ post({ok:false,stage:'load',err:String((e&&e.message)||e)}); }
},700));
</script>''' % (json.dumps(peer), json.dumps(kind), json.dumps(payload), json.dumps(token), ('true' if token else 'false'))
open('/tmp/vbridge_page.html','w').write(page)
PY

rm -f /tmp/vbridge_result.json
python3 - "$PORT" <<'PY' &
import http.server, socketserver, sys
PORT=int(sys.argv[1])
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_GET(self):
        b=open('/tmp/vbridge_page.html','rb').read()
        self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        n=int(self.headers.get('Content-Length',0)); open('/tmp/vbridge_result.json','wb').write(self.rfile.read(n))
        self.send_response(200); self.send_header('Access-Control-Allow-Origin','*'); self.end_headers(); self.wfile.write(b'ok')
socketserver.TCPServer.allow_reuse_address=True
socketserver.TCPServer(('127.0.0.1',PORT),H).serve_forever()
PY
SVPID=$!
sleep 1
"$CHROME" --headless=new --no-sandbox --disable-gpu --no-first-run \
  --user-data-dir="/tmp/vbridge_prof_$DBG" --remote-debugging-port="$DBG" "http://localhost:$PORT/" >/tmp/vbridge_chrome.log 2>&1 &
CHPID=$!
for i in $(seq 1 28); do [ -s /tmp/vbridge_result.json ] && break; sleep 1; done
cat /tmp/vbridge_result.json 2>/dev/null || echo '{"ok":false,"stage":"no-result"}'
echo ""
kill -9 $CHPID $SVPID 2>/dev/null
