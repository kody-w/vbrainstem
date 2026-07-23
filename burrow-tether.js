/*
 * burrow-tether.js — minimal Burrow transport for the vBrainstem.
 * Pairs the browser Copilot to a tiny on-device burrow daemon over a sealed,
 * SPAKE2-authenticated WebRTC channel and runs host ops on the real machine.
 * Chat always stays in the browser; this only carries burrow host ops.
 *
 * Loaded by index.html AFTER vbrainstem-boot.js. Makes THIS vBrainstem the
 * Opened via a burrow QR/link (?burrow=<host-peer>), it runs
 * the Apple-style ceremony (phone shows a 6-digit code; the human types it
 * the computer), then the Brain Surgeon's burrow tools run on that machine
 * over the sealed channel. A background loop re-attaches by sealed key
 * possession (no new code) if the link drops. Chat never leaves the browser.
 */
(function () {
  'use strict';

  var qs = new URLSearchParams(location.search);
  var SESSION_KEY = 'burrow_session';
  var HOST_PEER = qs.get('burrow') || '';
  var HOST_NAME = qs.get('host') || 'your computer';

  var stored = null;
  try { stored = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { }
  if (!HOST_PEER && stored && stored.peer) {
    // Reopened without the QR link — try to resume the stored pair quietly.
    HOST_PEER = stored.peer;
    HOST_NAME = stored.host || HOST_NAME;
  }
  if (!HOST_PEER) return;   // no burrow in play — stock vBrainstem
  var quiet = !qs.get('burrow');
  var token = (stored && stored.peer === HOST_PEER) ? stored.token : null;

  // Audited SPAKE2 (PAKE) + Ed25519 identity — the 8-digit code is a true
  // password (MITM-resistant), and devices pin each other for code-free re-pair.
  var PCready = import('./pair-crypto.js');
  var MYID = null;
  function myId() { return MYID; }
  function pinKey(peer) { return 'rapp_pin_' + peer; }
  function pinPeer(peer, pub) { try { if (pub) localStorage.setItem(pinKey(peer), pub); } catch (e) { } }
  function pinnedPeer(peer) { try { return localStorage.getItem(pinKey(peer)); } catch (e) { return null; } }
  PCready.then(function (m) { MYID = m.loadOrCreateIdentity('rapp_pair_identity_sk'); }).catch(function () { });

  var BASE = (function () {
    var p = location.pathname;
    return p.endsWith('/') ? p : p.slice(0, p.lastIndexOf('/') + 1);
  })();
  // ── state ──
  var S = { conn: null, up: false, ceremonyDone: !!token, resumeTimer: null, backoff: 2000 };

  function saveSession() {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ peer: HOST_PEER, token: token, host: HOST_NAME, ts: Date.now() })); } catch (e) { }
  }
  function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) { } }
  function myRappid() {
    var r = localStorage.getItem('vb_rappid');
    if (!r) { r = (crypto.randomUUID ? crypto.randomUUID() : 'dp-' + Date.now().toString(36)); localStorage.setItem('vb_rappid', r); }
    return r;
  }

  // ── rapp-sealed/1.0 (canonical salt + iterations) ──
  var _b64 = function (u8) { return btoa(String.fromCharCode.apply(null, new Uint8Array(u8))); };
  var _ub64 = function (s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); };
  var _keyCache = {};
  async function _key(secret) {
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
    var key = await _key(secret);
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
    return { schema: 'rapp-sealed/1.0', iv: _b64(iv), ct: _b64(ct) };
  }
  async function open_(secret, sealed) {
    var key = await _key(secret);
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: _ub64(sealed.iv) }, key, _ub64(sealed.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  // ── UI: status chip (bottom-right; boot chip owns bottom-left) ──
  var chip = null;
  function setChip(text, color) {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () { setChip(text, color); }, { once: true });
      return;
    }
    if (!text) { if (chip) { chip.remove(); chip = null; } return; }
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'dp-chip';
      chip.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:9989;' +
        'background:#161b22;color:#8b949e;border:1px solid #30363d;border-radius:20px;' +
        'padding:6px 14px;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
        'display:flex;align-items:center;gap:8px;box-shadow:0 4px 16px rgba(0,0,0,.35)';
      var dot = document.createElement('span');
      dot.id = 'dp-chip-dot';
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%';
      var label = document.createElement('span');
      label.id = 'dp-chip-text';
      chip.appendChild(dot); chip.appendChild(label);
      document.body.appendChild(chip);
    }
    chip.querySelector('#dp-chip-dot').style.background = color || '#8b949e';
    chip.querySelector('#dp-chip-text').textContent = text;
  }

  // ── UI: the pairing ceremony overlay (Apple-style) ──
  var overlay = null;
  function showOverlay(html) {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () { showOverlay(html); }, { once: true });
      return;
    }
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'dp-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(1,4,9,.82);' +
        'display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML =
      '<div style="background:#161b22;border:1px solid #30363d;border-radius:22px;padding:32px 34px;' +
      'width:min(380px,92vw);text-align:center;color:#e6edf3;' +
      'font:15px/1.5 -apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;' +
      'box-shadow:0 18px 60px rgba(1,4,9,.6)">' + html + '</div>';
  }
  function hideOverlay() { if (overlay) { overlay.remove(); overlay = null; } }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  var code = '', salt = '';
  function newCode() {
    var digits = crypto.getRandomValues(new Uint8Array(8));
    code = Array.from(digits, function (b) { return String(b % 10); }).join('');
    salt = _b64(crypto.getRandomValues(new Uint8Array(12)));
  }  function showCode() {
    showOverlay(
      '<h2 style="margin:0 0 8px;font-size:20px;font-weight:650">Enter this code on ' + esc(HOST_NAME) + '</h2>' +
      '<p style="color:#8b949e;font-size:13.5px;margin:0 0 18px">Typing it there is the human sign-off — ' +
      'until then this vBrainstem can\'t drive that computer.</p>' +
      '<div class="dp-code" style="display:flex;justify-content:center;gap:9px;margin:8px 0 14px">' +
      code.split('').map(function (d) {
        return '<span style="width:42px;height:56px;display:flex;align-items:center;justify-content:center;' +
          'background:#0d1117;border:1px solid #30363d;border-radius:11px;' +
          'font:600 28px ui-monospace,Menlo,monospace">' + d + '</span>';
      }).join('') + '</div>' +
      '<div style="color:#484f58;font-size:11.5px">🔒 the code never travels the network</div>' +
      '<button id="dp-skip" style="margin-top:16px;background:none;border:none;color:#8b949e;' +
      'font-size:12.5px;cursor:pointer;text-decoration:underline">Skip — use the in-browser brainstem</button>');
    var b = document.getElementById('dp-skip');
    if (b) b.onclick = function () { hideOverlay(); setChip(null); };
  }

  // ── transport ──
  function loadPeerJs() {
    return new Promise(function (resolve, reject) {
      if (window.Peer) return resolve();
      var s = document.createElement('script');
      s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      s.onload = resolve; s.onerror = function () { reject(new Error('peerjs load failed')); };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  var pendingSay = {};
  var lastSeen = 0;
  var hbTimer = null;
  function heartbeat() {
    if (hbTimer) clearInterval(hbTimer);
    lastSeen = Date.now();
    hbTimer = setInterval(async function () {
      if (!S.up || !S.conn || !token) return;
      if (Date.now() - lastSeen > 30000) {
        // Three missed beats — the daemon is gone even if PeerJS never said so.
        try { S.conn.close(); } catch (e) { }
        markLost();
        return;
      }
      try {
        S.conn.send(await seal(token, { schema: 'rapp-twin-chat/1.0', kind: 'ping', from_rappid: myRappid() }));
      } catch (e) { markLost(); }
    }, 10000);
  }
  async function onData(raw) {
    lastSeen = Date.now();
    var msg = raw;
    if (raw && raw.schema === 'rapp-sealed/1.0') {
      // Post-pairing traffic is sealed under the session key. SPAKE2 handshake
      // messages are plaintext (elements + MACs are public); a legacy host's
      // grant is sealed under the code-derived key (pairSecret fallback).
      if (!token) return;
      try { msg = await open_(token, raw); } catch (e) { return; }
    }
    if (!msg || !msg.schema) return;
    if (msg.kind === 'pong') return;
    if (msg.kind === 'pair-grant' && msg.response && msg.response.spake2) {
      var PCm = await PCready;
      var fin;
      try { fin = PCm.spake2Finish(S.spakeA, PCm._util.fromHex(msg.response.spake2)); }
      catch (e) { return; }
      if (!fin.verify(PCm._util.fromHex(msg.response.mac || ''))) {
        // Wrong code or an active MITM — the SPAKE2 confirmation didn't verify.
        try { S.conn.send({ schema: 'rapp-twin-chat/1.0', kind: 'pair-denied', from_rappid: myRappid() }); } catch (e) { }
        if (!quiet) { newCode(); sendPairRequest(); }
        return;
      }
      token = fin.keyHex;                       // sealed-channel key = SPAKE2 output
      pinPeer(HOST_PEER, msg.response.idPub);    // remember this device
      try {
        S.conn.send({ schema: 'rapp-twin-chat/1.0', kind: 'pair-confirm', from_rappid: myRappid(),
          response: { mac: PCm._util.hex(fin.macMine), idPub: (myId() && myId().pubHex) || null } });
      } catch (e) { }
      S.up = true; S.ceremonyDone = true; S.backoff = 2000;
      S.hostControl = !!msg.response.host_control;
      // A burrow-only host (no brainstem) sets chat:false — keep /chat in the
      // browser, only route host ops to the machine.
      S.hostOs = msg.response.os || null;
      saveSession();
      showOverlay('<div style="width:64px;height:64px;border-radius:50%;background:#238636;display:flex;' +
        'align-items:center;justify-content:center;margin:4px auto 14px">' +
        '<svg viewBox="0 0 24 24" style="width:32px;height:32px;fill:none;stroke:#fff;stroke-width:3;' +
        'stroke-linecap:round;stroke-linejoin:round"><polyline points="4 12.5 10 18.5 20 6.5"/></svg></div>' +
        '<h2 style="margin:0 0 6px;font-size:20px;font-weight:650">Burrowed</h2>' +
        '<p style="color:#8b949e;font-size:13.5px;margin:0">Copilot can now run on ' + esc(HOST_NAME) + '.</p>');
      setTimeout(hideOverlay, 1400);
      setChip('burrowed · Copilot can run on ' + HOST_NAME, '#3fb950');
      updateTargetPill();
      return;
    }
    if (msg.kind === 'resume-grant') {
      S.up = true; S.backoff = 2000;
      if (msg.response) { S.hostControl = !!msg.response.host_control; S.hostOs = msg.response.os || S.hostOs; }
      saveSession();
      hideOverlay();
      setChip('burrowed · Copilot can run on ' + HOST_NAME, '#3fb950');
      updateTargetPill();
      return;
    }
    if (msg.kind === 'resume-denied') {
      // Host page no longer knows this token — a fresh ceremony is needed.
      clearSession(); token = null;
      if (quiet) { teardown(); return; }
      sendPairRequest();
      return;
    }
    if (msg.kind === 'pair-denied') {
      newCode();
      sendPairRequest();
      return;
    }
    if (msg.schema === 'rapp-twin-chat-response/1.0' && msg.envelope && pendingSay[msg.envelope.nonce]) {
      var cb = pendingSay[msg.envelope.nonce];
      delete pendingSay[msg.envelope.nonce];
      cb(msg);
    }
  }

  async function sendPairRequest() {
    var PCm = await PCready;
    newCode();
    var A = PCm.spake2Start('A', code);        // A = code generator, SPAKE2 mask M
    S.spakeA = A._state;
    S.conn.send({
      schema: 'rapp-twin-chat/1.0', from_rappid: myRappid(), to_rappid: HOST_PEER,
      utc: new Date().toISOString(), nonce: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()),
      kind: 'pair-request',
      payload: { spake2: PCm._util.hex(A.msg), device: 'vBrainstem (' + (navigator.platform || 'browser') + ')', idPub: (myId() && myId().pubHex) || null }
    });
    showCode();
  }
  async function sendResume() {
    S.conn.send(await seal(token, {
      schema: 'rapp-twin-chat/1.0', from_rappid: myRappid(), to_rappid: HOST_PEER,
      utc: new Date().toISOString(), nonce: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()),
      kind: 'resume', payload: {}
    }));
  }

  function teardown() {
    S.up = false;
    setChip(null);
    hideOverlay();
  }

  function markLost() {
    try { if (chatTarget === 'twin') { chatTarget = 'local'; } updateTargetPill(); } catch (e) {}
    if (!S.up && !S.ceremonyDone) return;
    S.up = false;
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    // In-flight turns must not wait out a dead link — reject them now so
    // each falls back to the in-browser brainstem immediately.
    Object.keys(pendingSay).forEach(function (nonce) {
      var cb = pendingSay[nonce];
      delete pendingSay[nonce];
      try { cb({ status: 599, response: { error: 'tether lost' } }); } catch (e) { }
    });
    if (token) {
      setChip('tether lost — answering in-browser · reconnecting…', '#d29922');
      scheduleReconnect();
    }
  }
  function scheduleReconnect() {
    if (S.resumeTimer) return;
    S.resumeTimer = setTimeout(function () {
      S.resumeTimer = null;
      if (S.up) return;
      S.backoff = Math.min(S.backoff * 1.5, 15000);
      connect();
    }, S.backoff);
  }

  var RETRYABLE = { 'server-error': 1, 'network': 1, 'socket-error': 1, 'socket-closed': 1, 'unavailable-id': 1 };
  function connect() {
    loadPeerJs().then(function () {
      var peer = new Peer();
      peer.on('open', function () {
        var conn = peer.connect(HOST_PEER, { reliable: true });
        S.conn = conn;
        conn.on('open', function () {
          heartbeat();
          // ICE state flips to disconnected/failed well before PeerJS emits
          // close when the other tab dies — watch it directly.
          try {
            var pc = conn.peerConnection;
            if (pc) pc.addEventListener('iceconnectionstatechange', function () {
              if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                try { conn.close(); } catch (e) { }
                markLost();
              }
            });
          } catch (e) { }
          if (token) sendResume(); else sendPairRequest();
        });
        conn.on('data', onData);
        conn.on('close', function () {
          try { peer.destroy(); } catch (e) { }
          markLost();
        });
      });
      peer.on('error', function (e) {
        var t = (e && e.type) || 'network';
        if (t === 'peer-unavailable') {
          // The burrow daemon page is gone (or re-minted its peer-id).
          try { peer.destroy(); } catch (err) { }
          if (quiet) { clearSession(); teardown(); return; }
          if (token) { markLost(); return; }   // keep trying — the tab may come back
          setChip('burrow daemon unreachable', '#8b949e');
          hideOverlay();
          return;
        }
        if (RETRYABLE[t]) {
          try { peer.destroy(); } catch (err) { }
          markLost();
          if (!token && !S.ceremonyDone) scheduleReconnect();
        }
      });
    }).catch(function () {
      setChip('burrow unavailable (peerjs blocked)', '#f85149');
    });
  }

  // Sealed host op — run on the REAL machine (python/shell/files) via the
  // burrow daemon's /exec executor. Same nonce
  // round-trip; resolves the executor's JSON.
  function hostOp(req) {
    return new Promise(function (resolve, reject) {
      if (!S.up || !S.conn || !token) return reject(new Error('tether down'));
      if (!S.hostControl) return reject(new Error('host control not enabled on this computer'));
      var nonce = crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
      var timer = setTimeout(function () { delete pendingSay[nonce]; reject(new Error('host op timeout')); }, 180000);
      pendingSay[nonce] = function (msg) {
        clearTimeout(timer);
        if (msg.status && msg.status >= 400) reject(new Error((msg.response && msg.response.error) || ('host ' + msg.status)));
        else resolve(msg.response || {});
      };
      var env = {
        schema: 'rapp-twin-chat/1.0', from_rappid: myRappid(), to_rappid: HOST_PEER,
        utc: new Date().toISOString(), nonce: nonce, kind: 'host', payload: { req: req, token: token }
      };
      seal(token, env).then(function (sealed) { S.conn.send(sealed); }).catch(reject);
    });
  }

  // Bridge for the Brain Surgeon: is the burrow reachable, and run on it.
  // Chat WITH the burrow twin (its own /chat, on-device). Returns the kernel
  // envelope {response, session_id, agent_logs, ...} — same shape the stock UI
  // and the Surgeon expect, so both can talk to the twin like a local brainstem.
  function twinChat(body) {
    return hostOp({ op: 'chat', message: (body && body.user_input) || '',
                    session_id: body && body.session_id, history: (body && body.conversation_history) || [] });
  }

  window.__BURROW_BRIDGE__ = {
    isPaired: function () { return !!(S.up && token); },
    canBurrow: function () { return !!(S.up && token && S.hostControl); },
    hostName: function () { return HOST_NAME; },
    hostOs: function () { return S.hostOs || null; },
    hostOp: hostOp,
    chat: twinChat,
    chatTarget: function () { return chatTarget; },
    setChatTarget: function (t) { chatTarget = (t === 'twin') ? 'twin' : 'local'; updateTargetPill(); }
  };

  // ── vBrainstem chat → burrow twin routing ──
  // When the user points the vBrainstem chat at the twin, POST /chat rides the
  // sealed tether to the twin's on-device /chat; otherwise it stays in-browser.
  var chatTarget = 'local';
  function isChatPath(url) {
    try { var u = new URL(url, location.href); if (u.origin !== location.origin) return null;
      var p = u.pathname; if (p.indexOf(BASE) === 0) p = '/' + p.slice(BASE.length);
      return (p === '/chat' || p === '/chat/stream') ? p : null; } catch (e) { return null; }
  }
  var prevFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    if (chatTarget !== 'twin' || !S.up || !token) return prevFetch(input, init);
    var url = (typeof input === 'string') ? input : ((input && input.url) || '');
    var p = isChatPath(url);
    if (!p) return prevFetch(input, init);
    if (p === '/chat/stream') return Promise.resolve(new Response(JSON.stringify({ error: 'twin: use /chat' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
    var body = {}; try { body = JSON.parse((init && init.body) || '{}'); } catch (e) { }
    return twinChat(body).then(function (env) {
      return new Response(JSON.stringify(env || {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }).catch(function () { return prevFetch(input, init); });
  };

  // A small pill (by the burrow chip) to switch the vBrainstem chat target.
  var tpill = null;
  function updateTargetPill() {
    if (!S.up || !token) { if (tpill) { tpill.remove(); tpill = null; } return; }
    if (!document.body) { document.addEventListener('DOMContentLoaded', updateTargetPill, { once: true }); return; }
    if (!tpill) {
      tpill = document.createElement('button');
      tpill.id = 'burrow-chat-target';
      tpill.style.cssText = 'position:fixed;bottom:44px;right:14px;z-index:9989;cursor:pointer;' +
        'background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:20px;' +
        'padding:5px 12px;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
        'display:flex;align-items:center;gap:7px;box-shadow:0 4px 16px rgba(0,0,0,.35)';
      tpill.onclick = function () { window.__BURROW_BRIDGE__.setChatTarget(chatTarget === 'twin' ? 'local' : 'twin'); };
      document.body.appendChild(tpill);
    }
    tpill.innerHTML = (chatTarget === 'twin')
      ? '<span style="width:8px;height:8px;border-radius:50%;background:#d29922"></span>brainstem chat → ' + esc(HOST_NAME) + ' (twin) · click for in-browser'
      : '<span style="width:8px;height:8px;border-radius:50%;background:#3fb950"></span>brainstem chat → in-browser · click to use ' + esc(HOST_NAME);
  }

  setChip(token ? 'resuming burrow…' : 'connecting to ' + HOST_NAME + '…', '#d29922');
  connect();
})();
