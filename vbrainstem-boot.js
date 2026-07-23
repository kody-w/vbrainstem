/*
 * vbrainstem-boot.js — page-side bridge for the RAPP Brainstem browser edition.
 *
 * Loaded by index.html BEFORE the brainstem UI script. It makes the unmodified
 * local-brainstem UI (rapp_brainstem/index.html) run against a virtual server:
 *
 *   1. window.fetch is patched: same-origin brainstem routes (/chat, /health,
 *      /agents, /login, /models, ...) are dispatched to brainstem_web.py inside
 *      a Pyodide Web Worker; every other request passes through untouched
 *      (RAR registry, Azure/ElevenLabs TTS, auth worker).
 *   2. /chat/stream returns a real text/event-stream Response backed by a
 *      ReadableStream fed from the worker, so the UI's streaming renderer,
 *      agent-log events and abort handling work unchanged.
 *   3. window.open + <form> submits + <a> clicks that target virtual routes
 *      are intercepted (agent export, diagnostics report, workspace export).
 *   4. window.rapp (health/agents/run/eval/chat/summon/secrets/neighborhood)
 *      keeps the vbrainstem SDK/kite/doorman ecosystem talking to this page.
 *   5. Share links (#a=...), summon deep links (?agent=...), and #prompt=
 *      prefills keep every previously shared URL working.
 *   6. A VS Code-style Monaco editor overlay opens over the same virtual
 *      workspace (agents/, soul.md) — the browser twin of the header's
 *      "Open in VS Code" link.
 */

(function () {
  'use strict';

  // ── Base path + worker ─────────────────────────────────────────────────────
  var BASE = (function () {
    var path = location.pathname;
    return path.endsWith('/') ? path : path.slice(0, path.lastIndexOf('/') + 1);
  })();

  var ROUTE_PREFIXES = ['/chat', '/health', '/login', '/models', '/voice',
    '/agents', '/diagnostics', '/version', '/debug', '/workspace'];

  function virtualPath(url) {
    var u;
    try { u = new URL(url, location.href); } catch (e) { return null; }
    if (u.origin !== location.origin) return null;
    var p = u.pathname;
    if (p.indexOf(BASE) === 0) p = '/' + p.slice(BASE.length);
    for (var i = 0; i < ROUTE_PREFIXES.length; i++) {
      var pre = ROUTE_PREFIXES[i];
      if (p === pre || p.indexOf(pre + '/') === 0) {
        return { path: p, query: Object.fromEntries(u.searchParams.entries()) };
      }
    }
    return null;
  }

  var worker = new Worker(BASE + 'vbrainstem-worker.js');
  var readyResolve, readyReject;
  var ready = new Promise(function (res, rej) { readyResolve = res; readyReject = rej; });
  var pending = new Map();
  var streams = new Map();
  var seq = 0;
  var bootInfo = null;

  function nextId() { return 'vb' + (++seq); }

  worker.onmessage = function (event) {
    var msg = event.data || {};
    if (msg.type === 'boot-status') { setBootChip(msg.text); return; }
    if (msg.type === 'ready') {
      bootInfo = msg.info;
      setBootChip(null);
      readyResolve();
      return;
    }
    if (msg.type === 'boot-error') {
      setBootChip('Boot failed: ' + msg.error);
      readyReject(new Error(msg.error));
      return;
    }
    if (msg.type === 'auth-state') {
      try {
        if (msg.ghToken) localStorage.setItem('vb_gh_token', msg.ghToken);
        else localStorage.removeItem('vb_gh_token');
      } catch (e) {}
      return;
    }
    if (msg.type === 'response' || msg.type === 'rapp-result' || msg.type === 'rapp-error'
        || msg.type === 'fs-result' || msg.type === 'fs-error') {
      var entry = pending.get(msg.id);
      if (entry) { pending.delete(msg.id); entry(msg); }
      return;
    }
    if (msg.type && msg.type.indexOf('stream-') === 0) {
      var s = streams.get(msg.id);
      if (s) s(msg);
    }
  };

  function workerCall(payload, transfers) {
    return ready.then(function () {
      return new Promise(function (resolve) {
        payload.id = payload.id || nextId();
        pending.set(payload.id, resolve);
        worker.postMessage(payload, transfers || []);
      });
    });
  }

  try {
    worker.postMessage({
      type: 'init',
      base: BASE,
      ghToken: localStorage.getItem('vb_gh_token') || null,
      env: JSON.parse(localStorage.getItem('vb_env') || '{}'),
    });
  } catch (e) {
    worker.postMessage({ type: 'init', base: BASE, ghToken: null, env: {} });
  }

  // ── Boot chip (visible only while Pyodide is waking up) ────────────────────
  var chip = null;
  function setBootChip(text) {
    if (!text) { if (chip) { chip.remove(); chip = null; } return; }
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () { setBootChip(text); }, { once: true });
      return;
    }
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'vb-boot-chip';
      chip.style.cssText = 'position:fixed;bottom:14px;left:14px;z-index:9999;' +
        'background:#161b22;color:#8b949e;border:1px solid #30363d;border-radius:20px;' +
        'padding:6px 14px;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
        'display:flex;align-items:center;gap:8px;box-shadow:0 4px 16px rgba(0,0,0,.35)';
      var dot = document.createElement('span');
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#d29922;' +
        'animation:vbpulse 1s ease-in-out infinite';
      var style = document.createElement('style');
      style.textContent = '@keyframes vbpulse{0%,100%{opacity:1}50%{opacity:.3}}';
      chip.appendChild(style);
      chip.appendChild(dot);
      var label = document.createElement('span');
      label.id = 'vb-boot-chip-text';
      chip.appendChild(label);
      document.body.appendChild(chip);
    }
    var el = chip.querySelector('#vb-boot-chip-text');
    if (el) el.textContent = text;
  }

  // ── fetch patch ────────────────────────────────────────────────────────────
  var realFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    var vp = virtualPath(url);
    if (!vp) return realFetch(input, init);
    return virtualFetch(vp, input, init || {});
  };

  function collectHeaders(input, init) {
    var out = {};
    function absorb(h) {
      if (!h) return;
      if (typeof h.forEach === 'function' && h.entries) {
        h.forEach(function (v, k) { out[k.toLowerCase()] = v; });
      } else if (Array.isArray(h)) {
        h.forEach(function (pair) { out[String(pair[0]).toLowerCase()] = pair[1]; });
      } else if (typeof h === 'object') {
        Object.keys(h).forEach(function (k) { out[k.toLowerCase()] = h[k]; });
      }
    }
    if (typeof input === 'object' && input && input.headers) absorb(input.headers);
    if (init && init.headers) absorb(init.headers);
    return out;
  }

  async function extractBody(input, init) {
    var body = init.body != null ? init.body
      : (typeof input === 'object' && input && typeof input.clone === 'function'
        ? await input.clone().text().catch(function () { return null; }) : null);
    var result = { bodyJson: null, form: null, files: null, transfers: [] };
    if (body == null) return result;
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      result.form = {};
      result.files = {};
      var entries = Array.from(body.entries());
      for (var i = 0; i < entries.length; i++) {
        var k = entries[i][0], v = entries[i][1];
        if (typeof File !== 'undefined' && v instanceof File) {
          var buf = await v.arrayBuffer();
          result.files[k] = { filename: v.name, bytes: buf };
          result.transfers.push(buf);
        } else if (typeof Blob !== 'undefined' && v instanceof Blob) {
          var buf2 = await v.arrayBuffer();
          result.files[k] = { filename: (v.name || k), bytes: buf2 };
          result.transfers.push(buf2);
        } else {
          result.form[k] = String(v);
        }
      }
      if (!Object.keys(result.files).length) result.files = null;
      return result;
    }
    var text = (typeof body === 'string') ? body : null;
    if (text == null && body && typeof body.text === 'function') text = await body.text();
    if (text != null) {
      try { result.bodyJson = JSON.parse(text); }
      catch (e) { result.bodyJson = null; }
    }
    return result;
  }

  async function virtualFetch(vp, input, init) {
    var method = (init.method || (typeof input === 'object' && input && input.method) || 'GET').toUpperCase();
    var signal = init.signal || (typeof input === 'object' && input && input.signal) || null;
    if (signal && signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

    var extracted = await extractBody(input, init);
    var headers = collectHeaders(input, init);
    var id = nextId();
    if (signal && signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

    if (method === 'POST' && vp.path === '/chat/stream') {
      return virtualStreamFetch(id, vp, extracted, headers, signal);
    }

    await ready;
    // An abort can land during the (multi-second) Pyodide boot while we're
    // parked on `await ready`; adding the listener to an already-aborted signal
    // never fires, so re-check here before dispatching.
    if (signal && signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    var msg = await new Promise(function (resolve, reject) {
      var onAbort = null;
      if (signal) {
        onAbort = function () {
          pending.delete(id);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      pending.set(id, function (m) {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        resolve(m);
      });
      worker.postMessage({
        type: 'request', id: id, method: method, path: vp.path, query: vp.query,
        bodyJson: extracted.bodyJson, form: extracted.form, files: extracted.files,
        headers: headers,
      }, extracted.transfers);
    });

    if (msg.download) {
      return new Response(new Blob([msg.download.bytes], { type: msg.download.mimetype }), {
        status: msg.status,
        headers: {
          'Content-Type': msg.download.mimetype,
          'Content-Disposition': 'attachment; filename=' + msg.download.name,
        },
      });
    }
    if (msg.redirect) {
      return new Response(JSON.stringify({ status: 'draft', issue_url: msg.redirect }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(msg.json == null ? {} : msg.json), {
      status: msg.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function virtualStreamFetch(id, vp, extracted, headers, signal) {
    var encoder = new TextEncoder();
    return ready.then(function () {
      return new Promise(function (resolve, reject) {
        var controllerRef = null;
        var started = false;
        var closed = false;

        // Abort may have landed while we awaited boot; honor it before dispatch.
        if (signal && signal.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }

        function abort() {
          worker.postMessage({ type: 'abort', id: id });
          streams.delete(id);
          if (!started) {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          } else if (controllerRef && !closed) {
            closed = true;
            try { controllerRef.error(new DOMException('The operation was aborted.', 'AbortError')); }
            catch (e) {}
          }
        }
        if (signal) signal.addEventListener('abort', abort, { once: true });

        // A pre-stream validation error arrives as a plain response (the local
        // server validates before opening the event stream) — resolve it as JSON
        // so the UI's `!r.ok` check triggers its documented POST fallback.
        pending.set(id, function (msg) {
          streams.delete(id);
          resolve(new Response(JSON.stringify(msg.json == null ? {} : msg.json), {
            status: msg.status, headers: { 'Content-Type': 'application/json' },
          }));
        });

        streams.set(id, function (msg) {
          pending.delete(id);
          if (msg.type === 'stream-start') {
            if (started) return;
            started = true;
            var stream = new ReadableStream({
              start: function (controller) { controllerRef = controller; },
              cancel: function () { worker.postMessage({ type: 'abort', id: id }); streams.delete(id); },
            });
            resolve(new Response(stream, {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
            }));
          } else if (msg.type === 'stream-chunk') {
            if (controllerRef && !closed) controllerRef.enqueue(encoder.encode(msg.text));
          } else if (msg.type === 'stream-end') {
            streams.delete(id);
            if (controllerRef && !closed) { closed = true; try { controllerRef.close(); } catch (e) {} }
          } else if (msg.type === 'stream-error') {
            streams.delete(id);
            if (!started) {
              resolve(new Response(JSON.stringify({ error: msg.error }), { status: 500 }));
            } else if (controllerRef && !closed) {
              closed = true;
              try { controllerRef.error(new Error(msg.error)); } catch (e) {}
            }
          }
        });

        worker.postMessage({
          type: 'request', id: id, method: 'POST', path: vp.path, query: vp.query,
          bodyJson: extracted.bodyJson, form: extracted.form, files: extracted.files,
          headers: headers,
        }, extracted.transfers);
      });
    });
  }

  // ── window.open / form / anchor interception ───────────────────────────────
  var realOpen = window.open ? window.open.bind(window) : null;
  window.open = function (url, target, features) {
    var vp = url ? virtualPath(url) : null;
    if (!vp) return realOpen ? realOpen(url, target, features) : null;
    virtualDownload(vp);
    return null;
  };

  function virtualDownload(vp) {
    workerCall({ type: 'request', method: 'GET', path: vp.path, query: vp.query })
      .then(function (msg) {
        if (msg.download) {
          triggerDownload(new Blob([msg.download.bytes], { type: msg.download.mimetype }),
            msg.download.name);
        } else if (msg.json && msg.json.error) {
          alert(msg.json.error);
        }
      });
  }

  function triggerDownload(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name || 'download';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  function virtualFormSubmit(form) {
    var vp = form && form.action ? virtualPath(form.action) : null;
    if (!vp) return false;
    var fields = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (el.name) fields[el.name] = el.value;
    });
    workerCall({
      type: 'request', method: (form.method || 'POST').toUpperCase(),
      path: vp.path, query: vp.query, form: fields,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }).then(function (msg) {
      var url = msg.redirect || (msg.json && msg.json.issue_url);
      if (url && realOpen) realOpen(url, '_blank', 'noopener');
      else if (msg.json && msg.json.error) alert(msg.json.error);
    });
    return true;
  }

  document.addEventListener('submit', function (event) {
    if (virtualFormSubmit(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  // Programmatic form.submit() never fires the submit event — the UI's Get
  // Help flow uses exactly that (hidden form + form.submit()), so wrap it.
  var realFormSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    if (virtualFormSubmit(this)) return;
    return realFormSubmit.apply(this, arguments);
  };

  document.addEventListener('click', function (event) {
    var a = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!a) return;
    var vp = virtualPath(a.href);
    if (!vp) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    virtualDownload(vp);
  }, true);

  // ── Header "VS Code" button -> GitHub Copilot (Brain Surgeon) ──────────────
  // There's no VS Code to open in the browser; the button launches the Copilot
  // agent panel (surgeon.js) instead. Falls back to the Monaco editor if the
  // Surgeon isn't present.
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('#vscode-link') : null;
    if (!link) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (typeof window.__openSurgeon === 'function') window.__openSurgeon();
    else openEditor();
  }, true);

  // ── Secrets vault (AES-GCM, PBKDF2-SHA256 / 210000) ────────────────────────
  var VAULT_ITER = 210000;
  var _secrets = null;
  var _vaultPass = null;

  function b64encode(bytes) {
    var s = '';
    bytes = new Uint8Array(bytes);
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64decode(str) {
    var raw = atob(str);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  async function deriveKey(pass, salt) {
    var material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass),
      'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: VAULT_ITER },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encryptJSON(obj, pass) {
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var key = await deriveKey(pass, salt);
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key,
      new TextEncoder().encode(JSON.stringify(obj)));
    return { v: 1, kdf: 'PBKDF2-SHA256', iter: VAULT_ITER, salt: b64encode(salt), iv: b64encode(iv), ct: b64encode(ct) };
  }
  async function decryptJSON(blob, pass) {
    var key = await deriveKey(pass, b64decode(blob.salt));
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(blob.iv) }, key, b64decode(blob.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  async function unlockVault(pass) {
    var raw = localStorage.getItem('vb_secrets_enc');
    if (!raw) { _secrets = {}; _vaultPass = pass; return _secrets; }
    try {
      _secrets = await decryptJSON(JSON.parse(raw), pass);
      _vaultPass = pass;
      pushSecretsToRuntime();
      return _secrets;
    } catch (e) { throw new Error('wrong passphrase'); }
  }
  async function persistVault() {
    if (_secrets == null || !_vaultPass) return;
    localStorage.setItem('vb_secrets_enc', JSON.stringify(await encryptJSON(_secrets, _vaultPass)));
  }
  function pushSecretsToRuntime() {
    if (!_secrets) return;
    workerCall({ type: 'rapp', fn: 'eval', args: [
      'import os\nimport json\nos.environ.update(json.loads(' + JSON.stringify(JSON.stringify(_secrets)) + '))\n"secrets loaded"',
    ] });
  }

  // ── window.rapp — SDK/kite/doorman-compatible console API ──────────────────
  var registryCache = null;
  var REGISTRY_URL = 'https://raw.githubusercontent.com/kody-w/RAR/main/registry.json';
  var RAW_BASE = 'https://raw.githubusercontent.com/kody-w/RAR/main/';

  async function loadRegistry() {
    if (registryCache) return registryCache;
    var resp = await realFetch(REGISTRY_URL);
    if (!resp.ok) throw new Error('registry HTTP ' + resp.status);
    var data = await resp.json();
    registryCache = (data.agents || []).filter(function (a) { return a._file; });
    return registryCache;
  }

  function flatAgentName(slugOrPath) {
    var base = String(slugOrPath || 'agent').split('/').pop().replace(/\.py$/i, '');
    base = base.replace(/[^A-Za-z0-9_]/g, '_');
    if (!/_agent$/.test(base)) base += '_agent';
    return base + '.py';
  }

  async function rappAgents(grep) {
    var agents = await loadRegistry();
    var mapped = agents.map(function (a) {
      return {
        name: a.name, display_name: a.display_name, description: a.description,
        category: a.category, requires_env: a.requires_env || [], _file: a._file,
      };
    });
    if (!grep) return mapped;
    var needle = String(grep).toLowerCase();
    return mapped.filter(function (a) { return JSON.stringify(a).toLowerCase().indexOf(needle) !== -1; });
  }

  async function resolveAgent(slug) {
    var agents = await loadRegistry();
    var norm = function (s) { return String(s || '').toLowerCase().replace(/[-_]/g, ''); };
    var found = agents.find(function (a) { return a.name === slug; })
      || agents.find(function (a) { return norm(a.name) === norm(slug); })
      || agents.find(function (a) { return norm(a.name.split('/').pop()) === norm(String(slug).split('/').pop()); });
    if (!found) throw new Error('Agent not found: ' + slug);
    if (/\.stub$/.test(found._file)) throw new Error('Agent is private (stub): ' + slug);
    var resp = await realFetch(encodeURI(RAW_BASE + found._file));
    if (!resp.ok) throw new Error('agent fetch HTTP ' + resp.status);
    return { entry: found, source: await resp.text() };
  }

  async function rappRun(slug, request, args) {
    var resolved = await resolveAgent(slug);
    var msg = await workerCall({
      type: 'rapp', fn: 'run',
      args: [resolved.source, resolved.entry.display_name || resolved.entry.name, request || '', args || null],
    });
    if (msg.type === 'rapp-error') return { agent: resolved.entry.display_name, slug: slug, executed: false, error: msg.error };
    var result = msg.result || {};
    result.agent = resolved.entry.display_name || resolved.entry.name;
    result.slug = resolved.entry.name;
    return result;
  }

  async function installAgentSource(filename, source) {
    var fd = new FormData();
    fd.append('file', new Blob([source], { type: 'text/x-python' }), filename);
    var resp = await window.fetch('/agents/import', { method: 'POST', body: fd });
    return resp.json();
  }

  window.rapp = {
    health: async function () {
      var msg = await workerCall({ type: 'rapp', fn: 'health', args: [] });
      if (msg.type === 'rapp-error') return { status: 'error', error: msg.error };
      var h = msg.result;
      h.secrets_unlocked = !!_secrets;
      return h;
    },
    agents: rappAgents,
    run: rappRun,
    eval: async function (code) {
      var msg = await workerCall({ type: 'rapp', fn: 'eval', args: [String(code || '')] });
      if (msg.type === 'rapp-error') return { output: 'error: ' + msg.error };
      return msg.result;
    },
    chat: async function (input, history) {
      var body = (typeof input === 'object' && input) ? input
        : { user_input: String(input || ''), conversation_history: history || [] };
      var resp = await window.fetch('/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return resp.json();
    },
    summon: async function (slug) {
      var resolved = await resolveAgent(slug);
      var result = await installAgentSource(flatAgentName(resolved.entry.name), resolved.source);
      return result;
    },
    secrets: {
      list: function () { return _secrets ? Object.keys(_secrets) : []; },
      unlock: unlockVault,
      set: async function (k, v) {
        if (_secrets == null) throw new Error('vault locked — rapp.secrets.unlock(pass) first');
        _secrets[String(k)] = String(v);
        await persistVault();
        pushSecretsToRuntime();
        return true;
      },
    },
    help: function () {
      return [
        'rapp.health()                     virtual brainstem status',
        'rapp.agents(grep?)                RAR registry listing',
        'await rapp.run(slug, req, args?)  run one agent in Pyodide',
        'await rapp.eval(code)             python REPL in the workspace',
        'await rapp.chat(input, history?)  full brainstem /chat loop',
        'await rapp.summon(slug)           install a registry agent',
        'rapp.secrets.unlock/set/list      encrypted env vault',
        'rapp.neighborhood.host/join/ask   sealed WebRTC tether',
        'rapp.shareAgent(nameOrSource)     agent-in-a-link share sheet',
        '— driver console (drive the page like a person) —',
        'await rapp.ui.send(text)          type into the real chat and await the reply',
        'rapp.ui.lastReply()               last assistant bubble text',
        'rapp.ui.transcript()              [{role, content}] of every visible bubble',
        'rapp.ui.agentCalls()              agent-log disclosures ("agent called ...")',
        'rapp.tour.start()/rapp.tour.exit()  the guided tour ("The First Interview")',
        'rapp.editor()                     VS Code (Monaco) over the live workspace',
        'await rapp.fs.list()/read/write   virtual workspace files (hot-reload)',
        'await rapp.workspace()            download the tether workspace zip',
      ].join('\n');
    },
    editor: function () { openEditor(); },
    fs: {
      list: function () { return fsCall('list'); },
      read: function (path) { return fsCall('read', path).then(function (r) { return r.content; }); },
      write: function (path, content) { return fsCall('write', path, content); },
    },
    workspace: function () { return virtualDownload({ path: '/workspace/export', query: {} }); },
    tour: {
      start: function (step) { if (window.startTour) window.startTour(step); },
      exit: function () {
        var card = document.getElementById('tour-card');
        if (!card) return;
        var x = Array.prototype.find.call(card.querySelectorAll('button, [role="button"], span'),
          function (b) { return /✕|×/.test(b.textContent); });
        if (x) x.click();
      },
    },
    ui: {
      send: function (text, timeoutMs) {
        // Drives the REAL UI path (streaming renderer, agent logs, tour hooks) —
        // exactly what a person typing would trigger. Resolves with the NEW
        // assistant reply, or rejects with the error the UI surfaced. It keys on
        // a fresh assistant bubble (not total .msg growth, which the user bubble
        // alone satisfies) so an error turn never returns the previous reply.
        return new Promise(function (resolve, reject) {
          var input = document.getElementById('input');
          var send = document.getElementById('send');
          if (!input || !send) { reject(new Error('chat UI not present')); return; }
          var chat = document.getElementById('chat');
          var assistantSel = '.msg:not(.user):not(.system) .bubble';
          var systemSel = '.msg.system .bubble';
          var beforeAssistant = chat.querySelectorAll(assistantSel).length;
          var beforeSystem = chat.querySelectorAll(systemSel).length;
          input.value = String(text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          send.click();
          var deadline = Date.now() + (timeoutMs || 120000);
          (function poll() {
            var typing = chat.querySelector('.typing');
            var streaming = chat.querySelector('.stream-arriving, .stream-mask');
            var assistants = chat.querySelectorAll(assistantSel);
            var systems = chat.querySelectorAll(systemSel);
            if (assistants.length > beforeAssistant && !typing && !streaming) {
              resolve(assistants[assistants.length - 1].textContent);
              return;
            }
            // The UI reports errors (stopped, interrupted, not-signed-in,
            // could-not-reach) as a NEW system bubble — reject with its text so
            // a driver never mistakes a failure for the last good answer.
            if (systems.length > beforeSystem && !typing && !streaming) {
              reject(new Error(systems[systems.length - 1].textContent.trim().slice(0, 300) || 'chat error'));
              return;
            }
            if (Date.now() > deadline) { reject(new Error('reply timeout')); return; }
            setTimeout(poll, 250);
          })();
        });
      },
      lastReply: function () {
        var msgs = document.querySelectorAll('#chat .msg:not(.user):not(.system) .bubble');
        return msgs.length ? msgs[msgs.length - 1].textContent : null;
      },
      transcript: function () {
        return Array.prototype.map.call(document.querySelectorAll('#chat .msg'), function (m) {
          var bubble = m.querySelector('.bubble');
          return {
            role: m.classList.contains('user') ? 'user'
              : (m.classList.contains('system') ? 'system' : 'assistant'),
            content: bubble ? bubble.textContent : '',
          };
        });
      },
      agentCalls: function () {
        return Array.prototype.map.call(document.querySelectorAll('.logs-label'), function (b) {
          return b.textContent.trim();
        });
      },
    },
  };

  // ── Share links (#a= gzip/base64url) — rapp-share compatible ──────────────
  function b64urlToBytes(payload) {
    var s = payload.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return b64decode(s);
  }
  function bytesToB64url(bytes) {
    return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function decodeAgentPayload(payload) {
    var kind = payload[0];
    var data = b64urlToBytes(payload.slice(1));
    if (kind === 'B') return new TextDecoder().decode(data);
    if (kind === 'G') {
      var ds = new DecompressionStream('gzip');
      var stream = new Blob([data]).stream().pipeThrough(ds);
      return await new Response(stream).text();
    }
    throw new Error('unknown share payload');
  }
  async function encodeAgentPayload(source) {
    try {
      var cs = new CompressionStream('gzip');
      var stream = new Blob([new TextEncoder().encode(source)]).stream().pipeThrough(cs);
      var buf = await new Response(stream).arrayBuffer();
      return 'G' + bytesToB64url(new Uint8Array(buf));
    } catch (e) {
      return 'B' + bytesToB64url(new TextEncoder().encode(source));
    }
  }

  window.rapp.shareAgent = async function (sourceOrName, name) {
    var source = String(sourceOrName || '');
    if (source.indexOf('\n') === -1 && source.indexOf('{') === -1 && /\.py$/.test(source)) {
      var msg = await workerCall({ type: 'fs', op: 'read', path: 'agents/' + source.split('/').pop() });
      if (msg.type === 'fs-result') source = msg.result.content;
    }
    var displayName = name
      || (source.match(/display_name['"]?\s*[:=]\s*['"]([^'"]+)['"]/) || [])[1]
      || (source.match(/self\.name\s*=\s*['"]([^'"]+)['"]/) || [])[1]
      || 'shared_agent';
    var payload = await encodeAgentPayload(source);
    var link = location.origin + BASE + 'share.html#a=' + payload + '&n=' + encodeURIComponent(displayName);
    try { await navigator.clipboard.writeText(link); } catch (e) {}
    console.log('[vbrainstem] share link copied:', link);
    return link;
  };

  function parseAgentLink(text) {
    var m = /[#?&]a=([A-Za-z0-9\-_]+)/.exec(String(text || ''));
    if (!m) return null;
    var n = /[#?&]n=([^&\s]+)/.exec(String(text || ''));
    return { payload: m[1], name: n ? decodeURIComponent(n[1]) : null };
  }

  async function installFromLink(linkText) {
    var parsed = parseAgentLink(linkText);
    if (!parsed) return false;
    var source = await decodeAgentPayload(parsed.payload);
    var filename = flatAgentName(parsed.name || 'shared_agent');
    // ALWAYS confirm — matching the local brainstem's own .py-drop confirm.
    // A share link can be forged inside chat markdown (the sanitizer permits
    // relative/fragment hrefs), so installing a #a= link is code execution and
    // must never be silent, whether it arrived by drop, click, or hash.
    var ok = confirm('Install shared agent "' + (parsed.name || filename) + '"?\n\n' +
      'This runs Python code in your browser sandbox. Only install agents from sources you trust.');
    if (!ok) return true;
    var result = await installAgentSource(filename, source);
    if (result && result.status === 'ok') console.log('[vbrainstem] installed shared agent', filename);
    else if (result && result.error) alert(result.error);
    return true;
  }

  // A dropped share-link installs the same as the local brainstem's .py drop:
  // with an explicit confirm. (The brainstem UI's own drop handler only
  // understands .py Files and ignores text, so this text path is ours.)
  window.addEventListener('drop', function (event) {
    var dt = event.dataTransfer;
    if (!dt) return;
    // Only intercept when NO real files are being dropped — a .py file drop is
    // the local UI's job. This also avoids hijacking a drag of a chat anchor.
    if (dt.files && dt.files.length) return;
    var text = dt.getData('text/uri-list') || dt.getData('text/plain') || dt.getData('URL');
    if (text && parseAgentLink(text)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      installFromLink(text);
      var overlay = document.getElementById('drop-overlay');
      if (overlay) overlay.style.display = 'none';
    }
  }, true);

  // ── Deep links: #a= install, ?agent= summon, #prompt= prefill ─────────────
  async function handleDeepLinks() {
    try {
      if (location.hash && /[#&]a=/.test(location.hash)) {
        var handled = await installFromLink(location.hash);
        if (handled) history.replaceState(null, '', location.pathname + location.search);
      }
      var params = new URLSearchParams(location.search);
      var summons = params.getAll('agent');
      if (summons.length) {
        for (var i = 0; i < summons.length; i++) {
          try { await window.rapp.summon(summons[i]); } catch (e) { console.warn('summon failed', summons[i], e); }
        }
        params.delete('agent');
        history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash);
      }
      var promptMatch = /[#&]prompt=([^&]+)/.exec(location.hash);
      if (promptMatch) {
        var text = decodeURIComponent(promptMatch[1]);
        var attempt = function () {
          var input = document.getElementById('input');
          if (input) {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
            history.replaceState(null, '', location.pathname + location.search);
          } else setTimeout(attempt, 300);
        };
        attempt();
      }
    } catch (e) { console.warn('[vbrainstem] deep link handling failed', e); }
  }
  ready.then(function () {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', handleDeepLinks, { once: true });
    } else handleDeepLinks();
  });

  // ── Neighborhood (sealed WebRTC tether) — rapp-neighborhood-protocol/1.0 ──
  var SEALED_SALT = 'rapp-neighborhood-5a/1';
  var SEALED_ITER = 210000;
  var _hood = { peer: null, conns: {}, opToken: null, approved: {}, log: [] };
  var _keyCache = {};

  function myRappid() {
    var id = localStorage.getItem('vb_rappid');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('vb_rappid', id); }
    return id;
  }

  async function channelKey(secret) {
    if (_keyCache[secret]) return _keyCache[secret];
    var material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']);
    var key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(SEALED_SALT), iterations: SEALED_ITER },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    _keyCache[secret] = key;
    return key;
  }
  async function seal(obj, secret) {
    var key = await channelKey(secret);
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key,
      new TextEncoder().encode(JSON.stringify(obj)));
    return { schema: 'rapp-sealed/1.0', iv: b64encode(iv), ct: b64encode(ct) };
  }
  async function open_(blob, secret) {
    var key = await channelKey(secret);
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(blob.iv) }, key, b64decode(blob.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  }
  async function sasPin(secret, idA, idB) {
    var ids = [idA, idB].sort();
    var data = new TextEncoder().encode('rapp-sas/1|' + secret + '|' + ids.join('|'));
    var h = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    var pin = String(((h[0] << 16) | (h[1] << 8) | h[2]) % 1000000).padStart(6, '0');
    return pin;
  }
  function pinFmt(pin) { return pin.slice(0, 3) + ' ' + pin.slice(3); }

  function ensurePeerJs() {
    return new Promise(function (resolve, reject) {
      if (window.Peer) return resolve();
      var s = document.createElement('script');
      s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('PeerJS unavailable')); };
      document.head.appendChild(s);
    });
  }

  function hoodEnsure() {
    if (_hood.peer && _hood.peer.open) return Promise.resolve(_hood.peer.id);
    return ensurePeerJs().then(function () {
      return new Promise(function (resolve, reject) {
        var peer = new Peer();
        _hood.peer = peer;
        peer.on('open', function (id) { resolve(id); });
        peer.on('error', function (e) { reject(e); });
        peer.on('connection', function (conn) { hoodWire(conn); });
      });
    });
  }

  function hoodWire(conn) {
    _hood.conns[conn.peer] = conn;
    conn.on('data', function (data) { hoodHandle(conn, data); });
    conn.on('close', function () { delete _hood.conns[conn.peer]; });
  }

  async function hoodHandle(conn, data) {
    var env = data;
    var wasSealed = false;
    if (data && data.schema === 'rapp-sealed/1.0') {
      wasSealed = true;
      try { env = await open_(data, _hood.opToken || ''); }
      catch (e) {
        var denied = { schema: 'rapp-twin-chat-response/1.0', channel: '5a-tether-sealed',
          from_rappid: myRappid(), to_rappid: null, kind: null, envelope: null,
          status: 403, response: { error: 'decrypt/auth failed' } };
        try { conn.send(await seal(denied, _hood.opToken || '')); } catch (e2) {}
        return;
      }
    }
    if (!env || env.schema !== 'rapp-twin-chat/1.0') return;

    async function respond(status, response) {
      var out = {
        schema: 'rapp-twin-chat-response/1.0',
        channel: wasSealed ? '5a-tether-sealed' : '5a-tether',
        from_rappid: myRappid(), to_rappid: env.from_rappid,
        kind: env.kind, envelope: env, status: status, response: response,
      };
      conn.send(wasSealed ? await seal(out, _hood.opToken) : out);
    }

    // SAS PIN gate: sealed traffic from an unapproved connection waits for the
    // host's explicit approval. The PIN is hashed over the two PeerJS peer ids
    // (host self-id + joiner conn.peer) — both endpoints observe that same pair
    // identically, so the displayed PINs match (rappids do NOT, since new Peer()
    // gets an unrelated broker id).
    if (wasSealed && !_hood.approved[conn.peer] && (env.kind === 'say' || env.kind === 'console')) {
      var pin = await sasPin(_hood.opToken, _hood.peer.id, conn.peer);
      pairPrompt(conn.peer, pin);
      await respond(409, { error: 'awaiting PIN approval on the host device', sas: pinFmt(pin), pin: pin, pending: true });
      return;
    }

    try {
      if (env.kind === 'say') {
        var payload = env.payload || {};
        var reply = await window.rapp.chat({
          user_input: payload.text || '',
          conversation_history: payload.conversation_history || [],
          session_id: payload.session_id,
        });
        await respond(200, reply);
      } else if (env.kind === 'console') {
        var p = env.payload || {};
        if (!wasSealed && p.token !== _hood.opToken) {
          await respond(403, { error: 'operator token required' });
          return;
        }
        var target = window.rapp;
        var parts = String(p.method || '').split('.');
        for (var i = 0; i < parts.length - 1; i++) target = target && target[parts[i]];
        var fn = target && target[parts[parts.length - 1]];
        if (typeof fn !== 'function') { await respond(502, { error: 'unknown method: ' + p.method }); return; }
        var result = await fn.apply(target, p.args || []);
        await respond(200, result);
      }
    } catch (e) {
      try { await respond(502, { error: String(e).slice(0, 300) }); } catch (e2) {}
    }
  }

  function pairPrompt(peerId, pin) {
    if (document.getElementById('pair-' + peerId)) return;
    var card = document.createElement('div');
    card.id = 'pair-' + peerId;
    card.style.cssText = 'position:fixed;top:70px;right:14px;z-index:9998;background:#161b22;' +
      'color:#e6edf3;border:1px solid #30363d;border-radius:12px;padding:16px;max-width:280px;' +
      'font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4)';
    card.innerHTML = '<div style="font-weight:600;margin-bottom:6px">🪁 Pairing request</div>' +
      '<div style="color:#8b949e;margin-bottom:8px">Confirm this PIN matches the joining device:</div>' +
      '<div style="font-family:monospace;font-size:22px;letter-spacing:3px;text-align:center;margin-bottom:12px"></div>' +
      '<div style="display:flex;gap:8px"><button data-act="ok" style="flex:1;background:#238636;color:#fff;border:0;border-radius:6px;padding:7px;cursor:pointer">Approve</button>' +
      '<button data-act="no" style="flex:1;background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:7px;cursor:pointer">Reject</button></div>';
    card.querySelector('div[style*="monospace"]').textContent = pinFmt(pin);
    card.querySelector('[data-act="ok"]').onclick = function () { _hood.approved[peerId] = true; card.remove(); };
    card.querySelector('[data-act="no"]').onclick = function () {
      var conn = _hood.conns[peerId];
      if (conn) try { conn.close(); } catch (e) {}
      card.remove();
    };
    document.body.appendChild(card);
  }

  window.rapp.neighborhood = {
    host: async function (opts) {
      opts = opts || {};
      var id = await hoodEnsure();
      if (!_hood.opToken) _hood.opToken = opts.token || crypto.randomUUID();
      var link = location.origin + location.pathname + '?peer=' + id;
      var info = {
        peer_id: id, rappid: myRappid(), link: link,
        op_link: link + '&op=' + encodeURIComponent(_hood.opToken),
        token: _hood.opToken, secret: _hood.opToken,
        qr: 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=8&data=' + encodeURIComponent(link),
      };
      showKitePanel(info);
      return info;
    },
    join: function (peerId) {
      return hoodEnsure().then(function () {
        return new Promise(function (resolve, reject) {
          var conn = _hood.peer.connect(peerId);
          conn._outbound = true;
          var timer = setTimeout(function () { reject(new Error('connect timeout')); }, 15000);
          conn.on('open', function () { clearTimeout(timer); hoodWire(conn); resolve(conn.peer); });
          conn.on('error', function (e) { clearTimeout(timer); reject(e); });
        });
      });
    },
    peers: function () { return Object.keys(_hood.conns); },
    ask: function (peerId, text, secret) {
      return hoodSend(peerId, 'say', { text: text }, secret);
    },
    operate: function (peerId, method, args, secret) {
      if (!secret) return Promise.reject(new Error('operate requires the session secret'));
      return hoodSend(peerId, 'console', { method: method, args: args || [] }, secret);
    },
    onMessage: function (fn) { _hood.onMessage = fn; },
    id: function () { return _hood.peer ? _hood.peer.id : null; },
    log: function () { return _hood.log.slice(); },
    _seal: seal, _open: open_, _channelKey: channelKey, _sasPin: sasPin,
  };

  async function hoodSend(peerId, kind, payload, secret) {
    var conn = _hood.conns[peerId];
    if (!conn) {
      await window.rapp.neighborhood.join(peerId);
      conn = _hood.conns[peerId];
    }
    var env = {
      schema: 'rapp-twin-chat/1.0', from_rappid: myRappid(), to_rappid: null,
      utc: new Date().toISOString(), nonce: crypto.randomUUID(),
      kind: kind, payload: payload, facets: [],
    };
    var out = secret ? await seal(env, secret) : env;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { cleanup(); reject(new Error('response timeout')); }, 60000);
      function cleanup() { clearTimeout(timer); conn.off('data', onData); }
      async function onData(data) {
        var resp = data;
        if (data && data.schema === 'rapp-sealed/1.0' && secret) {
          try { resp = await open_(data, secret); } catch (e) { return; }
        }
        if (!resp || resp.schema !== 'rapp-twin-chat-response/1.0') return;
        var envIn = resp.envelope || {};
        if (envIn.nonce === env.nonce || envIn.utc === env.utc) { cleanup(); resolve(resp); }
      }
      conn.on('data', onData);
      conn.send(out);
    });
  }

  window.hostNeighborhood = function () { return window.rapp.neighborhood.host(); };

  function showKitePanel(info) {
    var old = document.getElementById('vb-kite-panel');
    if (old) old.remove();
    var panel = document.createElement('div');
    panel.id = 'vb-kite-panel';
    panel.style.cssText = 'position:fixed;top:70px;right:14px;z-index:9997;background:#161b22;' +
      'color:#e6edf3;border:1px solid #30363d;border-radius:12px;padding:16px;width:280px;' +
      'font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4)';
    var mark = document.getElementById('vb-kite-mark');
    panel.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      (mark ? mark.innerHTML : '🪁') +
      '<b>Hosting a kite</b><span style="flex:1"></span>' +
      '<button id="vb-kite-close" style="background:none;border:0;color:#8b949e;cursor:pointer;font-size:16px">✕</button></div>' +
      '<div style="color:#8b949e;margin-bottom:8px">Scan to join this brainstem from another device:</div>' +
      '<img alt="join QR" style="width:100%;border-radius:8px;background:#fff" src="' + info.qr + '">' +
      '<button id="vb-kite-copy" style="margin-top:10px;width:100%;background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:8px;cursor:pointer">Copy operator link</button>';
    document.body.appendChild(panel);
    panel.querySelector('#vb-kite-close').onclick = function () { panel.remove(); };
    panel.querySelector('#vb-kite-copy').onclick = function () {
      navigator.clipboard.writeText(info.op_link).catch(function () {});
    };
  }

  // ?peer= dial deep link — join a hosted brainstem/kite from this page.
  ready.then(function () {
    var params = new URLSearchParams(location.search);
    var peerId = params.get('peer');
    if (!peerId) return;
    var op = params.get('op');
    setTimeout(async function () {
      try {
        await window.rapp.neighborhood.join(peerId);
        if (op) {
          // Same peer-id pair as the host computes, so the PINs match.
          var pin = await sasPin(op, peerId, _hood.peer.id);
          var okPin = confirm('Sealed channel PIN: ' + pinFmt(pin) +
            '\n\nConfirm the SAME PIN is shown on the host device, then press OK.');
          if (!okPin) return;
        }
        var text = prompt('Connected to ' + peerId + '.\nSay something to the remote brainstem:');
        if (!text) return;
        // The host only shows its Approve modal AFTER the first sealed message,
        // so that first ask returns 409 (pending). Retry a few times to give the
        // operator time to approve on the host device.
        var resp = null;
        for (var attempt = 0; attempt < 12; attempt++) {
          resp = await window.rapp.neighborhood.ask(peerId, text, op || undefined);
          if (!resp || resp.status !== 409) break;
          if (attempt === 0) alert('Waiting for the host to approve the pairing (PIN ' + pinFmt(pin) + ')…');
          await new Promise(function (r) { setTimeout(r, 2500); });
        }
        if (resp && resp.status === 409) { alert('Pairing was not approved on the host device.'); return; }
        alert('Remote brainstem: ' +
          ((resp && resp.response && (resp.response.response || resp.response.error)) || JSON.stringify(resp && resp.response)).slice(0, 800));
      } catch (e) { console.warn('[vbrainstem] dial failed', e); }
    }, 1200);
  });

  // ── VS Code-style workspace: activity bar + explorer + Monaco + Copilot Chat ─
  // Monaco is the same editor engine VS Code ships. Around it we build the VS
  // Code shell — an activity bar, a file tree over the real brainstem workspace,
  // and a Copilot-Chat-style panel on the right wired to the brainstem's
  // streaming /chat. The human talks to the brainstem there while editing; the
  // "brain surgeon" (autopilot/rapp.editor.send) drives that same panel in the
  // user's place — the browser twin of VS Code + GitHub Copilot Chat.
  var editorState = {
    overlay: null, monaco: null, editor: null, currentPath: null, dirty: false,
    chatHistory: [], chatSession: null, chatBusy: false, view: 'explorer',
  };

  function fsCall(op, path, content) {
    return workerCall({ type: 'fs', op: op, path: path || '', content: content }).then(function (msg) {
      if (msg.type === 'fs-error') throw new Error(msg.error);
      return msg.result;
    });
  }

  function loadMonaco() {
    if (editorState.monaco) return Promise.resolve(editorState.monaco);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.js';
      s.onload = function () {
        window.require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
        window.require(['vs/editor/editor.main'], function () {
          editorState.monaco = window.monaco;
          resolve(window.monaco);
        });
      };
      s.onerror = function () { reject(new Error('Monaco unavailable')); };
      document.head.appendChild(s);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Minimal, safe markdown for the chat panel (escape first, then format).
  function chatMarkdown(text) {
    var html = escapeHtml(text);
    html = html.replace(/```([\s\S]*?)```/g, function (_m, code) {
      return '<pre style="background:#1e1e1e;border:1px solid #333;border-radius:5px;padding:8px;overflow-x:auto;margin:6px 0"><code>' + code.trim() + '</code></pre>';
    });
    html = html.replace(/`([^`]+)`/g, '<code style="background:#333;border-radius:3px;padding:1px 4px">$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  async function openEditor() {
    if (editorState.overlay) {
      editorState.overlay.style.display = 'flex';
      refreshTree();
      return editorState.overlay;
    }
    var overlay = document.createElement('div');
    overlay.id = 'vb-editor';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9995;display:flex;flex-direction:column;' +
      'background:#1e1e1e;color:#cccccc;font:13px "Segoe UI",-apple-system,sans-serif';
    overlay.innerHTML =
      // Title bar
      '<div style="display:flex;align-items:center;gap:10px;background:#323233;padding:6px 12px">' +
        '<span style="font-weight:600;color:#ccc">🧠 rapp_brainstem — Brainstem Studio</span>' +
        '<span id="vb-ed-dirty" style="color:#e2c08d"></span>' +
        '<span style="flex:1"></span>' +
        '<button id="vb-ed-save" style="background:#0e639c;color:#fff;border:0;border-radius:3px;padding:4px 14px;cursor:pointer">Save (Ctrl+S)</button>' +
        '<button id="vb-ed-close" style="background:none;color:#ccc;border:0;font-size:18px;cursor:pointer" title="Close">✕</button>' +
      '</div>' +
      // Body: activity bar | explorer | editor | chat
      '<div style="flex:1;display:flex;min-height:0">' +
        '<div id="vb-ed-activity" style="width:48px;background:#333333;display:flex;flex-direction:column;align-items:center;padding-top:8px;gap:4px;border-right:1px solid #1b1b1b">' +
          '<button data-view="explorer" title="Explorer" style="background:none;border:0;border-left:2px solid #007acc;color:#fff;font-size:20px;cursor:pointer;padding:8px 6px;width:100%">🗂️</button>' +
          '<button data-view="chat" title="Brainstem Chat" style="background:none;border:0;border-left:2px solid transparent;color:#858585;font-size:20px;cursor:pointer;padding:8px 6px;width:100%">💬</button>' +
        '</div>' +
        '<div id="vb-ed-explorer" style="width:240px;background:#252526;overflow-y:auto;border-right:1px solid #1b1b1b;display:flex;flex-direction:column">' +
          '<div style="padding:8px 12px 4px;font-size:11px;letter-spacing:.6px;color:#bbbbbb;text-transform:uppercase;display:flex;align-items:center">Explorer' +
            '<span style="flex:1"></span>' +
            '<button id="vb-ed-new" title="New agent" style="background:none;border:0;color:#ccc;cursor:pointer;font-size:15px">＋</button></div>' +
          '<div style="padding:2px 12px 8px;font-size:11px;font-weight:700;color:#cccccc">RAPP_BRAINSTEM</div>' +
          '<div id="vb-ed-tree" style="flex:1;overflow-y:auto;padding-bottom:8px"></div>' +
        '</div>' +
        '<div style="flex:1;min-width:0;display:flex;flex-direction:column">' +
          '<div id="vb-ed-tab" style="height:32px;background:#2d2d2d;display:flex;align-items:center;padding:0 12px;font-size:12px;color:#cccccc;border-bottom:1px solid #1b1b1b">No file open</div>' +
          '<div id="vb-ed-editor" style="flex:1;min-width:0"></div>' +
        '</div>' +
        // Copilot-Chat-style panel
        '<div id="vb-ed-chat" style="width:380px;min-width:280px;background:#1e1e1e;border-left:1px solid #1b1b1b;display:flex;flex-direction:column">' +
          '<div style="padding:10px 14px;border-bottom:1px solid #2b2b2b;display:flex;align-items:center;gap:8px">' +
            '<span style="font-size:16px">🧠</span><b style="color:#eaeaea">Brainstem Chat</b>' +
            '<span style="flex:1"></span>' +
            '<button id="vb-ed-chat-clear" title="Clear chat" style="background:none;border:0;color:#858585;cursor:pointer;font-size:13px">Clear</button></div>' +
          '<div id="vb-ed-chat-log" style="flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px"></div>' +
          '<div style="padding:10px 12px;border-top:1px solid #2b2b2b">' +
            '<div style="display:flex;gap:8px;align-items:flex-end">' +
              '<textarea id="vb-ed-chat-input" rows="1" placeholder="Ask your brainstem…" style="flex:1;resize:none;max-height:120px;background:#2d2d2d;color:#eaeaea;border:1px solid #3c3c3c;border-radius:6px;padding:8px 10px;font:13px inherit;outline:none"></textarea>' +
              '<button id="vb-ed-chat-send" style="background:#0e639c;color:#fff;border:0;border-radius:6px;padding:8px 14px;cursor:pointer">Send</button>' +
            '</div>' +
            '<div style="color:#6a6a6a;font-size:11px;margin-top:6px">Talks to this brainstem — the same engine as the main chat. Save an agent, then ask it here.</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      // Status bar
      '<div style="background:#007acc;color:#fff;padding:2px 12px;font-size:12px;display:flex;gap:16px;align-items:center">' +
        '<span>🧠 RAPP Brainstem — browser edition</span><span id="vb-ed-path"></span>' +
        '<span style="flex:1"></span><span>Agents hot-reload on every message — save and just ask.</span></div>';
    document.body.appendChild(overlay);
    editorState.overlay = overlay;

    overlay.querySelector('#vb-ed-close').onclick = function () { overlay.style.display = 'none'; };
    overlay.querySelector('#vb-ed-save').onclick = saveCurrent;
    overlay.querySelector('#vb-ed-new').onclick = newAgentFile;
    overlay.querySelector('#vb-ed-chat-clear').onclick = function () {
      editorState.chatHistory = [];
      editorState.chatSession = null;
      renderChatLog();
    };
    overlay.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveCurrent(); }
    });

    // Activity bar: on narrow widths, collapse the explorer or chat.
    Array.prototype.forEach.call(overlay.querySelectorAll('#vb-ed-activity button'), function (btn) {
      btn.onclick = function () { setEditorView(btn.getAttribute('data-view')); };
    });

    // Chat input wiring
    var chatInput = overlay.querySelector('#vb-ed-chat-input');
    chatInput.addEventListener('input', function () {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    });
    chatInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); triggerEditorChat(); }
    });
    overlay.querySelector('#vb-ed-chat-send').onclick = triggerEditorChat;

    renderChatLog();
    await refreshTree();
    try {
      var monaco = await loadMonaco();
      editorState.editor = monaco.editor.create(overlay.querySelector('#vb-ed-editor'), {
        theme: 'vs-dark', automaticLayout: true, fontSize: 13,
        minimap: { enabled: true }, value: '# Select a file on the left, or ask the brainstem on the right to build one.\n', language: 'python',
      });
      editorState.editor.onDidChangeModelContent(function () {
        editorState.dirty = true;
        overlay.querySelector('#vb-ed-dirty').textContent = '● unsaved';
      });
    } catch (e) {
      var ta = document.createElement('textarea');
      ta.id = 'vb-ed-fallback';
      ta.style.cssText = 'width:100%;height:100%;background:#1e1e1e;color:#ccc;border:0;' +
        'font:13px "SF Mono",Consolas,monospace;padding:12px;resize:none;outline:none';
      ta.oninput = function () { editorState.dirty = true; overlay.querySelector('#vb-ed-dirty').textContent = '● unsaved'; };
      overlay.querySelector('#vb-ed-editor').appendChild(ta);
    }
    var files = await fsCall('list');
    var first = files.indexOf('soul.md') !== -1 ? 'soul.md' : files[0];
    if (first) await openFile(first);
    setEditorView('explorer');
    return overlay;
  }

  function setEditorView(view) {
    editorState.view = view;
    var overlay = editorState.overlay;
    if (!overlay) return;
    var narrow = window.innerWidth < 900;
    // On wide screens both explorer and chat stay visible; the activity bar just
    // scrolls the requested one into focus. On narrow screens, toggle.
    if (narrow) {
      overlay.querySelector('#vb-ed-explorer').style.display = view === 'explorer' ? 'flex' : 'none';
      overlay.querySelector('#vb-ed-chat').style.display = view === 'chat' ? 'flex' : 'none';
    } else {
      overlay.querySelector('#vb-ed-explorer').style.display = 'flex';
      overlay.querySelector('#vb-ed-chat').style.display = 'flex';
      if (view === 'chat') overlay.querySelector('#vb-ed-chat-input').focus();
    }
    Array.prototype.forEach.call(overlay.querySelectorAll('#vb-ed-activity button'), function (btn) {
      var active = btn.getAttribute('data-view') === view;
      btn.style.borderLeftColor = active ? '#007acc' : 'transparent';
      btn.style.color = active ? '#fff' : '#858585';
    });
  }

  async function newAgentFile() {
    var name = prompt('New agent filename (must end in _agent.py):', 'my_new_agent.py');
    if (!name) return;
    if (!/_agent\.py$/.test(name)) name = name.replace(/\.py$/, '') + '_agent.py';
    var stem = name.replace(/_agent\.py$/, '');
    var cls = stem.replace(/(^|_)(\w)/g, function (_m, _s, c) { return c.toUpperCase(); }) + 'Agent';
    await fsCall('write', 'agents/' + name,
      'from agents.basic_agent import BasicAgent\n\n\nclass ' + cls + '(BasicAgent):\n' +
      '    def __init__(self):\n        self.name = "' + stem.replace(/_/g, ' ').replace(/(^|\s)\w/g, function (m) { return m.toUpperCase(); }).replace(/\s/g, '') + '"\n        self.metadata = {\n' +
      '            "name": self.name,\n            "description": "Describe when the AI should call this agent.",\n' +
      '            "parameters": {"type": "object", "properties": {}, "required": []}\n        }\n' +
      '        super().__init__(name=self.name, metadata=self.metadata)\n\n' +
      '    def perform(self, **kwargs):\n        return "Hello from your new agent!"\n');
    await refreshTree();
    openFile('agents/' + name);
  }

  function fileIcon(name) {
    if (/\.py$/.test(name)) return '🐍';
    if (/\.md$/.test(name)) return '📝';
    if (/\.json$/.test(name)) return '⚙️';
    return '📄';
  }

  async function refreshTree() {
    var tree = editorState.overlay.querySelector('#vb-ed-tree');
    var files = await fsCall('list');
    // Group into folders + root files so the tree reads like the on-device
    // rapp_brainstem layout (agents/ folder, soul.md, engine files).
    var folders = {};
    var rootFiles = [];
    files.forEach(function (f) {
      var slash = f.indexOf('/');
      if (slash === -1) rootFiles.push(f);
      else {
        var dir = f.slice(0, slash);
        (folders[dir] = folders[dir] || []).push(f);
      }
    });
    tree.innerHTML = '';
    function row(label, icon, fullpath, depth, isFolder) {
      var el = document.createElement('div');
      el.textContent = icon + ' ' + label;
      el.style.cssText = 'padding:3px 8px 3px ' + (10 + depth * 14) + 'px;cursor:pointer;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px' +
        (fullpath === editorState.currentPath ? ';background:#37373d;color:#fff' : ';color:#cccccc');
      if (!isFolder) el.onclick = function () { openFile(fullpath); };
      tree.appendChild(el);
      return el;
    }
    // Folders first (agents/ etc.), then root files — matching VS Code ordering.
    Object.keys(folders).sort().forEach(function (dir) {
      row(dir + '/', '📁', null, 0, true);
      folders[dir].sort().forEach(function (f) {
        row(f.slice(dir.length + 1), fileIcon(f), f, 1, false);
      });
    });
    rootFiles.sort().forEach(function (f) { row(f, fileIcon(f), f, 0, false); });
  }

  async function openFile(path) {
    var data = await fsCall('read', path);
    editorState.currentPath = path;
    editorState.dirty = false;
    editorState.overlay.querySelector('#vb-ed-dirty').textContent = '';
    editorState.overlay.querySelector('#vb-ed-path').textContent = '/brainstem/' + path;
    editorState.overlay.querySelector('#vb-ed-tab').textContent = fileIcon(path) + ' ' + path;
    var lang = path.endsWith('.py') ? 'python' : (path.endsWith('.md') ? 'markdown' : 'plaintext');
    if (editorState.editor && editorState.monaco) {
      var model = editorState.monaco.editor.createModel(data.content, lang);
      var oldModel = editorState.editor.getModel();
      editorState.editor.setModel(model);
      if (oldModel) oldModel.dispose();
    } else {
      var ta = editorState.overlay.querySelector('#vb-ed-fallback');
      if (ta) ta.value = data.content;
    }
    refreshTree();
  }

  async function saveCurrent() {
    if (!editorState.currentPath) return;
    var content = editorState.editor ? editorState.editor.getValue()
      : (editorState.overlay.querySelector('#vb-ed-fallback') || {}).value || '';
    await fsCall('write', editorState.currentPath, content);
    editorState.dirty = false;
    editorState.overlay.querySelector('#vb-ed-dirty').textContent = '';
  }

  // ── Copilot-Chat panel: streams the brainstem's /chat/stream ──────────────
  function renderChatLog() {
    var log = editorState.overlay && editorState.overlay.querySelector('#vb-ed-chat-log');
    if (!log) return;
    if (!editorState.chatHistory.length) {
      log.innerHTML = '<div style="color:#8a8a8a;font-size:12px;line-height:1.6">' +
        'Ask your brainstem anything, or have it build an agent for you —<br>' +
        '<em>"make an agent that reverses a string"</em>, <em>"what agents do I have?"</em>, ' +
        '<em>"remember my name is Ada"</em>.<br><br>' +
        'Same memory and agents as the main chat. This is where the <b>brain surgeon</b> ' +
        'drives your brainstem in your place.</div>';
      return;
    }
    log.innerHTML = '';
    editorState.chatHistory.forEach(function (m) {
      var wrap = document.createElement('div');
      var isUser = m.role === 'user';
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:3px' + (isUser ? ';align-items:flex-end' : '');
      var who = document.createElement('div');
      who.textContent = isUser ? 'You' : '🧠 Brainstem';
      who.style.cssText = 'font-size:11px;color:#8a8a8a';
      var bubble = document.createElement('div');
      bubble.style.cssText = 'max-width:92%;padding:8px 11px;border-radius:8px;font-size:13px;line-height:1.5;' +
        (isUser ? 'background:#0e639c;color:#fff' : 'background:#2d2d2d;color:#eaeaea');
      if (isUser) bubble.textContent = m.content;
      else bubble.innerHTML = chatMarkdown(m.content || '…');
      wrap.appendChild(who);
      wrap.appendChild(bubble);
      if (!isUser && m.logs) {
        var logsEl = document.createElement('div');
        logsEl.style.cssText = 'font-size:11px;color:#7ee787;background:#161b22;border-radius:6px;padding:6px 9px;max-width:92%;white-space:pre-wrap;overflow-x:auto';
        logsEl.textContent = m.logs;
        wrap.appendChild(logsEl);
      }
      log.appendChild(wrap);
    });
    log.scrollTop = log.scrollHeight;
  }

  function triggerEditorChat() {
    var input = editorState.overlay.querySelector('#vb-ed-chat-input');
    var text = (input.value || '').trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    editorChatSend(text);
  }

  // Sends to the brainstem's streaming /chat and renders the reply. Returns the
  // final reply text (so the brain surgeon / autopilot can await it).
  async function editorChatSend(text) {
    if (editorState.chatBusy) return;
    editorState.chatBusy = true;
    var sendBtn = editorState.overlay.querySelector('#vb-ed-chat-send');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '…'; }
    editorState.chatHistory.push({ role: 'user', content: text });
    var reply = { role: 'assistant', content: '', logs: '' };
    editorState.chatHistory.push(reply);
    renderChatLog();

    var history = editorState.chatHistory
      .slice(0, -1)
      .filter(function (m) { return m.role === 'user' || (m.role === 'assistant' && m.content); })
      .map(function (m) { return { role: m.role, content: m.content }; });

    try {
      var resp = await window.fetch('/chat/stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_input: text,
          conversation_history: history.slice(0, -1),
          session_id: editorState.chatSession,
        }),
      });
      if (!resp.ok || !resp.body) {
        var errBody = await resp.json().catch(function () { return {}; });
        throw new Error(errBody.error || ('chat error ' + resp.status));
      }
      var readerRdr = resp.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      while (true) {
        var chunk = await readerRdr.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        var frames = buf.split('\n\n');
        buf = frames.pop();
        for (var i = 0; i < frames.length; i++) {
          var line = frames[i].split('\n').find(function (l) { return l.indexOf('data:') === 0; });
          if (!line) continue;
          var evt;
          try { evt = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
          if (evt.type === 'delta') { reply.content += evt.text; renderChatLog(); }
          else if (evt.type === 'agent') { reply.logs = evt.logs; renderChatLog(); }
          else if (evt.type === 'done') {
            if (evt.response != null && evt.response !== '') reply.content = evt.response;
            if (evt.agent_logs) reply.logs = evt.agent_logs;
            if (evt.session_id) editorState.chatSession = evt.session_id;
            renderChatLog();
          } else if (evt.type === 'error') {
            reply.content = evt.error || 'The brainstem hit an error.';
            renderChatLog();
          }
        }
      }
      if (!reply.content) reply.content = '(no response)';
    } catch (e) {
      reply.content = 'Error: ' + (e.message || e);
    } finally {
      editorState.chatBusy = false;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send'; }
      renderChatLog();
      // An agent the brainstem just wrote/hot-loaded should show up in the tree.
      refreshTree();
    }
    return reply.content;
  }

  // Direct worker request — bypasses window.fetch (and therefore the desk-pair
  // tether). The Brain Surgeon builds agents in THIS vBrainstem's workspace, so
  // its /surgeon/complete, /chat tests and /agents calls must always hit the
  // local Pyodide brainstem even while /chat turns are tethered to a desk.
  function localRequest(method, path, bodyJson) {
    return workerCall({
      type: 'request', method: method, path: path,
      bodyJson: bodyJson != null ? bodyJson : null,
    }).then(function (msg) {
      if (msg.download) return { status: msg.status, download: msg.download };
      return { status: msg.status, json: msg.json == null ? {} : msg.json };
    });
  }

  window.__vbrainstem = {
    ready: ready,
    worker: worker,
    info: function () { return bootInfo; },
    fs: fsCall,
    local: localRequest,
    openEditor: openEditor,
    editorChat: function (text) { return openEditor().then(function () { return editorChatSend(text); }); },
  };

  // Expose the editor's Copilot-Chat surface on rapp so the brain surgeon can
  // drive it in the user's place, mirroring rapp.ui.send for the main chat.
  window.rapp.editor = function () { return openEditor(); };
  window.rapp.editor.open = function () { return openEditor(); };
  window.rapp.editor.send = function (text) {
    return openEditor().then(function () { return editorChatSend(text); });
  };
})();
