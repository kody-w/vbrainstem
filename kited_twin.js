#!/usr/bin/env node
// kited_twin.js — the "kite string" for a KITED TWIN (rapp-neighborhood-protocol §5a, kite transport).
//
//   A KITED TWIN is a browser tab that exposes its I/O on the console (window.kite.outbox /
//   .inbox) and reaches NOTHING on its own. An operator (Claude) holds the *string* — this
//   process — and drives the tab over the Chrome DevTools Protocol. No WebRTC, no broker,
//   no STUN, no CORS. The string-holder is the transport.
//
//   It is TETHERED when the string also reaches the locally-running brainstem (--brainstem
//   <url>): the twin's turns are answered by that local brainstem (channel "5a-kite+tether").
//   With no --brainstem it is JUST KITED: answered by the tab's own in-page brainstem
//   (window.rapp.chat), channel "5a-kite". Either way it speaks the same rapp-twin-chat
//   envelopes, so other neighbors can't tell a kited twin from a WebRTC peer.
//
// Usage:
//   node kited_twin.js --port <cdp-port> [--brainstem http://localhost:7077] [--once]
const args = process.argv.slice(2);
const val  = (k, d) => { const i = args.indexOf(k); return (i >= 0 && args[i+1] && !args[i+1].startsWith('--')) ? args[i+1] : d; };
const PORT      = val('--port', '9350');
const BRAINSTEM = val('--brainstem', null);
const ONCE      = args.includes('--once');
const TETHERED  = !!BRAINSTEM;
const CHANNEL   = TETHERED ? '5a-kite+tether' : '5a-kite';

async function connectCDP(port) {
  const targets = await (await fetch(`http://localhost:${port}/json`)).json();
  const page = targets.find(t => t.type === 'page') ;
  if (!page) throw new Error('no page target on CDP port ' + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let _id = 0; const pending = {};
  ws.onmessage = ev => { const m = JSON.parse(ev.data);
    if (m.id && pending[m.id]) { m.error ? pending[m.id].rej(new Error(JSON.stringify(m.error))) : pending[m.id].res(m.result); delete pending[m.id]; } };
  const rpc = (method, params) => new Promise((res, rej) => { const id = ++_id; pending[id] = { res, rej };
    ws.send(JSON.stringify({ id, method, params })); setTimeout(() => rej(new Error(method + ' timeout')), 30000); });
  const evl = async expr => { const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval error'); return r.result.value; };
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  return { evl, ws };
}

(async () => {
  const { evl, ws } = await connectCDP(PORT);
  const descriptor = { schema: 'rapp-kited-twin/1.0', transport: 'kite', kited: true, tethered: TETHERED,
                       brainstem: TETHERED ? BRAINSTEM : null, channel: CHANNEL };
  console.log(JSON.stringify({ event: 'string-attached', ...descriptor }));
  // ensure the kite's I/O surface exists
  await evl(`window.kite = window.kite || {}; window.kite.outbox = window.kite.outbox || []; window.kite.inbox = window.kite.inbox || []; true`);

  async function drain() {
    const out = await evl(`(function(){ var o = window.kite.outbox.splice(0); return o; })()`);
    for (const env of (out || [])) {
      const text = (env.payload && env.payload.text) || '';
      let status = 200, response;
      try {
        if (TETHERED) {                                  // answered by the LOCAL brainstem (the tether)
          const r = await fetch(BRAINSTEM.replace(/\/$/, '') + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_input: text, conversation_history: (env.payload && env.payload.conversation_history) || [], session_id: (env.payload && env.payload.session_id) || 'kite' }) });
          response = await r.json();
        } else {                                         // just kited — answered by the tab's OWN brainstem
          response = await evl(`(async()=>{ try { return await window.rapp.chat({ user_input: ${JSON.stringify(text)} }); } catch(e){ return { error: String((e&&e.message)||e) }; } })()`);
        }
      } catch (e) { status = 502; response = { error: String((e && e.message) || e) }; }
      const resp = { schema: 'rapp-twin-chat-response/1.0', channel: CHANNEL, from_rappid: 'kited-twin',
        to_rappid: env.from_rappid || '?', kind: env.kind || 'say', envelope: env, status, response, tethered: TETHERED };
      await evl(`window.kite.inbox.push(${JSON.stringify(resp)}); true`);
      console.log(JSON.stringify({ event: 'relayed', kind: env.kind, status, tethered: TETHERED, answer: (response && response.response) || response }));
    }
    return (out || []).length;
  }

  if (ONCE) { await drain(); const inbox = await evl('window.kite.inbox'); console.log(JSON.stringify({ event: 'inbox', inbox })); ws.close(); process.exit(0); }
  console.log(JSON.stringify({ event: 'flying', note: 'polling window.kite.outbox every 500ms — close the tab to cut the string' }));
  setInterval(drain, 500);
})().catch(e => { console.log(JSON.stringify({ ok: false, err: String((e && e.message) || e) })); process.exit(1); });
