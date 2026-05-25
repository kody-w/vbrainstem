#!/usr/bin/env node
// kite_vtwin.js <cdpPort> <brainstemUrl>
// Kite a DEPLOYED vBrainstem (index.html) twin: over CDP, override its rapp.chat to route
// through THIS process (which curls the local brainstem — the deployed HTTPS page can't reach
// localhost), host the neighborhood, and overlay the MS-logo "kite" + a scannable join-QR.
// Scanning it joins this kited neighborhood (sealed). Prints incoming messages so Claude sees them.
const PORT = process.argv[2] || '9226';
const BS   = (process.argv[3] || 'http://localhost:7077').replace(/\/$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const KITE =
  '<svg viewBox="0 0 100 134" width="150" height="201" style="filter:drop-shadow(0 4px 9px rgba(0,0,0,.5))">'
  + '<polygon points="50,6 10,40 50,40" fill="#F25022"/><polygon points="50,6 90,40 50,40" fill="#7FBA00"/>'
  + '<polygon points="50,98 90,40 50,40" fill="#FFB900"/><polygon points="50,98 10,40 50,40" fill="#00A4EF"/>'
  + '<polygon points="50,6 90,40 50,98 10,40" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/>'
  + '<line x1="50" y1="6" x2="50" y2="98" stroke="#fff" stroke-width="2.2"/><line x1="10" y1="40" x2="90" y2="40" stroke="#fff" stroke-width="2.2"/>'
  + '<path d="M50,98 Q58,108 52,116 Q46,124 54,131" fill="none" stroke="#8b949e" stroke-width="1.4" stroke-linecap="round"/>'
  + '<path d="M50.8,105.8 L54,109 L50.8,112.2 Z M57.2,105.8 L54,109 L57.2,112.2 Z" fill="#F25022"/>'
  + '<path d="M46.8,113.8 L50,117 L46.8,120.2 Z M53.2,113.8 L50,117 L53.2,120.2 Z" fill="#7FBA00"/>'
  + '<path d="M51.8,123.8 L55,127 L51.8,130.2 Z M58.2,123.8 L55,127 L58.2,130.2 Z" fill="#FFB900"/></svg>';

async function connect(port) {
  let page;
  for (let i = 0; i < 60; i++) {
    try { const ts = await (await fetch(`http://localhost:${port}/json`)).json();
      page = ts.find(t => t.type === 'page' && /github\.io\/vbrainstem/.test(t.url || '')) || ts.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) break; } catch (e) {}
    await sleep(500);
  }
  if (!page) throw new Error('no vbrainstem tab on CDP :' + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let _id = 0; const pend = {};
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend[m.id]) { m.error ? pend[m.id].rej(new Error(JSON.stringify(m.error))) : pend[m.id].res(m.result); delete pend[m.id]; } };
  const rpc = (me, p) => new Promise((res, rej) => { const id = ++_id; pend[id] = { res, rej }; ws.send(JSON.stringify({ id, method: me, params: p })); setTimeout(() => rej(new Error(me + ' timeout')), 30000); });
  const evl = async e => { const r = await rpc('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval'); return r.result.value; };
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  return { evl };
}

async function drain(evl) {
  const items = await evl(`(function(){ var q=(window.__q||[]); window.__q=[]; return q; })()`).catch(() => []);
  for (const it of (items || [])) {
    console.log(JSON.stringify({ '📩 from_phone': it.text }));
    let ans;
    try { const r = await fetch(BS + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_input: it.text, conversation_history: it.history || [], session_id: it.session || 'kite' }) }); ans = await r.json(); }
    catch (e) { ans = { error: String((e && e.message) || e) }; }
    await evl(`window.__ans[${JSON.stringify(it.id)}] = ${JSON.stringify(ans)}; true`).catch(() => {});
    console.log(JSON.stringify({ replied: (ans && ans.response || '').slice(0, 90) }));
  }
}

(async () => {
  const { evl } = await connect(PORT);
  // 1) override rapp.chat → route through us (the deployed HTTPS page can't fetch localhost)
  await evl(`
    window.__q = window.__q || []; window.__ans = window.__ans || {};
    window.rapp.chat = function(req){ return new Promise(res=>{ var id='q'+Math.random().toString(36).slice(2);
      window.__q.push({id:id, text:(req&&req.user_input)||'', history:(req&&req.conversation_history)||[], session:(req&&req.session_id)||'kite'});
      var iv=setInterval(function(){ if(window.__ans[id]!==undefined){ clearInterval(iv); var a=window.__ans[id]; delete window.__ans[id]; res(a); } },100); }); };
    true;`);
  // 2) host the kited neighborhood
  const info = await evl(`(async()=>{ const i = await window.rapp.neighborhood.host(); return {peer_id:i.peer_id, token:i.token, op_link:i.op_link}; })()`);
  // 3) overlay the kite + a real scannable join-QR (rendered client-side)
  await evl(`
    window.__kite = function(link){
      var o=document.getElementById('kv-overlay'); if(o) o.remove();
      o=document.createElement('div'); o.id='kv-overlay';
      o.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(13,17,23,.94);display:flex;flex-direction:column;align-items:center;justify-content:center;font:15px -apple-system,BlinkMacSystemFont,sans-serif;color:#e6edf3;text-align:center;padding:20px';
      o.innerHTML='<div style="margin-bottom:8px">${KITE}</div>'
        +'<div style="font-size:24px;font-weight:800;letter-spacing:-.3px">Kited — scan to join</div>'
        +'<div style="color:#8b949e;margin:6px 0 18px">this kited neighborhood · 🔒 sealed · tethered to your local brainstem</div>'
        +'<div id="kv-qr" style="background:#fff;padding:12px;border-radius:14px;line-height:0;min-width:220px;min-height:220px"></div>'
        +'<div id="kv-peers" style="margin-top:16px;color:#3fb950;font-weight:700;font-size:16px">neighbors: 0</div>';
      document.body.appendChild(o);
      var s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
      s.onload=function(){ try{ var qr=qrcode(0,'M'); qr.addData(link); qr.make(); document.getElementById('kv-qr').innerHTML=qr.createImgTag(6,0);
        var im=document.querySelector('#kv-qr img'); if(im){im.style.width='220px';im.style.height='220px';im.style.imageRendering='pixelated';} }
        catch(e){ document.getElementById('kv-qr').innerHTML='<img width=220 height=220 src="https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=8&data='+encodeURIComponent(link)+'">'; } };
      s.onerror=function(){ document.getElementById('kv-qr').innerHTML='<img width=220 height=220 src="https://api.qrserver.com/v1/create-qr-code/?size=360x360&margin=8&data='+encodeURIComponent(link)+'">'; };
      document.head.appendChild(s);
      setInterval(function(){ var e=document.getElementById('kv-peers'); if(e) e.textContent='neighbors: '+window.rapp.neighborhood.peers().length; },1500);
    };
    window.__kite(${JSON.stringify(info.op_link)}); true;`);
  console.log('KITED ' + info.peer_id + ' ' + info.token);
  console.log(JSON.stringify({ event: 'kited-twin-live', op_link: info.op_link, brainstem: BS }));
  while (true) { await drain(evl); await sleep(150); }
})().catch(e => { console.log(JSON.stringify({ ok: false, err: String((e && e.message) || e) })); process.exit(1); });
