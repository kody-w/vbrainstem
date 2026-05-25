#!/usr/bin/env node
// claude_bridge.js <cdpPort> <brainstemUrl>
// Claude IS the bridge. A DEPLOYED public page (https://…github.io/…/brainstem_bridge.html)
// hosts the neighborhood door on the public web, but it can't reach http://localhost. So we
// don't make it: over CDP we replace its bsChat()/bsGet() with stubs that hand the request to
// THIS process (which is on the machine and can curl the local brainstem) and await the answer.
// The page does only WebRTC (public broker) + console I/O (CDP, local). The tether to :7077 is us.
const PORT = process.argv[2] || '9224';
const BS   = (process.argv[3] || 'http://localhost:7077').replace(/\/$/, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect(port) {
  let page;
  for (let i = 0; i < 60; i++) {                       // wait for the tab + CDP to come up
    try { const ts = await (await fetch(`http://localhost:${port}/json`)).json();
      page = ts.find(t => t.type === 'page' && /brainstem_bridge/.test(t.url || '')) || ts.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) break; } catch (e) {}
    await sleep(500);
  }
  if (!page) throw new Error('no bridge tab on CDP :' + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let _id = 0; const pend = {};
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend[m.id]) { m.error ? pend[m.id].rej(new Error(JSON.stringify(m.error))) : pend[m.id].res(m.result); delete pend[m.id]; } };
  const rpc = (me, p) => new Promise((res, rej) => { const id = ++_id; pend[id] = { res, rej }; ws.send(JSON.stringify({ id, method: me, params: p })); setTimeout(() => rej(new Error(me + ' timeout')), 30000); });
  const evl = async e => { const r = await rpc('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval'); return r.result.value; };
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  return { evl, ws };
}

async function drain(evl) {
  const items = await evl(`(function(){ var q=(window.__q||[]); window.__q=[]; return q; })()`).catch(() => []);
  for (const it of (items || [])) {
    let ans;
    try {
      if (it.kind === 'chat') { const r = await fetch(BS + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_input: it.text, conversation_history: it.history || [], session_id: it.session || 'bridge' }) }); ans = await r.json(); }
      else { const r = await fetch(BS + (it.path || '/health')); ans = await r.json(); }
    } catch (e) { ans = { error: String((e && e.message) || e) }; }
    await evl(`window.__ans[${JSON.stringify(it.id)}] = ${JSON.stringify(ans)}; true`).catch(() => {});
    console.log(JSON.stringify({ serviced: it.kind, path: it.path, via: BS }));
  }
}

(async () => {
  const { evl } = await connect(PORT);
  // 1) Replace the page's localhost-fetching functions with stubs that route through US.
  await evl(`
    window.__q = window.__q || []; window.__ans = window.__ans || {};
    bsChat = function(text,history,session){ return new Promise(res=>{ var id='q'+Math.random().toString(36).slice(2);
      window.__q.push({id:id,kind:'chat',text:String(text||''),history:history||[],session:session||'bridge'});
      var iv=setInterval(function(){ if(window.__ans[id]!==undefined){ clearInterval(iv); var a=window.__ans[id]; delete window.__ans[id]; res(a); } },100); }); };
    bsGet = function(path){ return new Promise(res=>{ var id='q'+Math.random().toString(36).slice(2);
      window.__q.push({id:id,kind:'get',path:String(path||'')});
      var iv=setInterval(function(){ if(window.__ans[id]!==undefined){ clearInterval(iv); var a=window.__ans[id]; delete window.__ans[id]; res(a); } },100); }); };
    window.bsChat=bsChat; window.bsGet=bsGet; true;
  `);
  console.log(JSON.stringify({ event: 'override-installed', note: 'bsChat/bsGet now route through Claude → ' + BS }));
  // 2) Host the door on the PUBLIC broker. host() calls our bsGet('/health') → serviced by the loop.
  await evl(`document.querySelector('#bs').value='claude://bridge (tethered by Claude)'; host(); true`);
  // 3) Service the queue + wait for the broker to assign peer-id + token.
  let info = null;
  for (let i = 0; i < 60; i++) { await drain(evl); info = await evl(`(_state&&_state.id&&_state.token)?{peer_id:_state.id,token:_state.token}:null`).catch(() => null); if (info && info.peer_id) break; await sleep(250); }
  if (!info) { console.log(JSON.stringify({ ok:false, err:'no peer-id (broker?)' })); process.exit(1); }
  console.log('PUBLIC_DOOR ' + info.peer_id + ' ' + info.token);
  console.log(JSON.stringify({ event: 'public-door-open', ...info, brainstem: BS, page: 'deployed https github pages' }));
  // 4) Be the bridge forever: drain the page's queue → answer from the LOCAL brainstem.
  while (true) { await drain(evl); await sleep(120); }
})().catch(e => { console.log(JSON.stringify({ ok:false, err: String((e && e.message) || e) })); process.exit(1); });
