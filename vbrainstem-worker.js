/*
 * vbrainstem-worker.js — Pyodide host for the RAPP Brainstem browser edition.
 *
 * Runs brainstem_web.py (the faithful port of rapp_brainstem/brainstem.py)
 * inside a Web Worker so the page thread stays responsive and Python's
 * synchronous `requests` calls (urllib3's Emscripten XHR transport) are legal.
 *
 * Message protocol (page -> worker):
 *   {type:'init', base, ghToken?, env?}         boot Pyodide + brainstem
 *   {type:'request', id, method, path, query?, bodyJson?, form?, files?, headers?}
 *   {type:'abort', id}                          cancel a streaming request
 *   {type:'rapp', id, fn, args}                 window.rapp console calls
 *   {type:'fs', id, op, path, content?}         editor file operations
 *
 * Worker -> page:
 *   {type:'boot-status', text}
 *   {type:'ready', info}
 *   {type:'boot-error', error}
 *   {type:'response', id, status, json?, redirect?, download:{name,mimetype,bytes}?}
 *   {type:'stream-start', id} / {type:'stream-chunk', id, text} /
 *   {type:'stream-end', id} / {type:'stream-error', id, error}
 *   {type:'rapp-result', id, result} / {type:'rapp-error', id, error}
 *   {type:'fs-result', id, result} / {type:'fs-error', id, error}
 *   {type:'auth-state', ghToken}                mirror token for page continuity
 */

'use strict';

const PYODIDE_VERSION = 'v0.26.4';
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;
const BRAINSTEM_ROOT = '/brainstem';

// Engine files are always refreshed from the repo on boot; workspace files are
// seeded only when absent so user edits (soul.md, agents) survive updates.
const ENGINE_FILES = ['brainstem_web.py', 'local_storage.py', 'VERSION', 'agents/basic_agent.py'];
const SEED_FILES = ['soul.md', 'agents/context_memory_agent.py', 'agents/manage_memory_agent.py'];

let pyodide = null;
let bootPromise = null;
let siteBase = './';
const abortedIds = new Set();
let syncTimer = null;

function post(msg, transfers) {
  try { self.postMessage(msg, transfers || []); } catch (e) { self.postMessage(msg); }
}

function status(text) { post({ type: 'boot-status', text }); }

async function fetchText(rel) {
  const resp = await fetch(siteBase + rel, { cache: 'no-cache' });
  if (!resp.ok) throw new Error(`fetch ${rel} -> HTTP ${resp.status}`);
  return await resp.text();
}

function fsWrite(path, content) {
  const dir = path.substring(0, path.lastIndexOf('/'));
  if (dir) pyodide.FS.mkdirTree(dir);
  pyodide.FS.writeFile(path, content, { encoding: 'utf8' });
}

function fsExists(path) {
  try { pyodide.FS.stat(path); return true; } catch (e) { return false; }
}

function syncFS(populate) {
  return new Promise((resolve) => {
    try {
      pyodide.FS.syncfs(populate, (err) => {
        if (err) console.warn('[vbrainstem] IDBFS sync failed (state may not persist):', err);
        resolve();
      });
    } catch (e) { resolve(); }
  });
}

function scheduleSync() {
  if (syncTimer) return;
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    await syncFS(false);
  }, 250);
}

const PY_GLUE = `
import json, os, sys, traceback
import brainstem_web

def _vb_files_from_js(files_obj):
    # files_obj arrives via pyodide.toPy() as a plain Python dict whose 'bytes'
    # values are memoryviews of the transferred Uint8Arrays.
    files = {}
    if files_obj:
        for key, entry in files_obj.items():
            data = entry.get('bytes')
            files[key] = {
                'filename': entry.get('filename'),
                'bytes': bytes(data) if data is not None else b'',
            }
    return files

def vb_dispatch(spec_json, files_js=None):
    spec = json.loads(spec_json)
    files = _vb_files_from_js(files_js)
    result = brainstem_web.dispatch(
        spec.get('method'), spec.get('path'),
        query=spec.get('query'), body=spec.get('body'),
        form=spec.get('form'), files=files or None,
        headers=spec.get('headers'),
    )
    return result

def vb_result_to_json(result):
    out = {'status': result.get('status', 200)}
    if 'json' in result:
        out['json'] = result['json']
    if 'redirect' in result:
        out['redirect'] = result['redirect']
    return json.dumps(out)

def vb_scan_missing(extra_source=None):
    try:
        return json.dumps(brainstem_web.scan_missing_packages(extra_source))
    except Exception:
        return '[]'

def vb_note_install(package, ok):
    brainstem_web.note_install_result(package, bool(ok))

def vb_rapp(fn, args_json):
    args = json.loads(args_json or '[]')
    if fn == 'health':
        return json.dumps(brainstem_web.rapp_health())
    if fn == 'eval':
        return json.dumps(brainstem_web.rapp_eval(args[0] if args else ''))
    if fn == 'run':
        return json.dumps(brainstem_web.rapp_run(*args))
    if fn == 'boot':
        return json.dumps(brainstem_web.boot())
    raise ValueError(f'unknown rapp fn: {fn}')

def vb_fs(op, path, content=None):
    root = '${BRAINSTEM_ROOT}'
    full = os.path.normpath(os.path.join(root, path.lstrip('/')))
    if not full.startswith(root):
        raise ValueError('path escapes the brainstem workspace')
    if op == 'list':
        entries = []
        for base, dirs, names in os.walk(root):
            if '.brainstem_data' in base:
                continue
            for name in names:
                if name.startswith('.') and name != '.env':
                    continue
                rel = os.path.relpath(os.path.join(base, name), root).replace(os.sep, '/')
                if rel.startswith('.'):
                    continue
                entries.append(rel)
        return json.dumps(sorted(entries))
    if op == 'read':
        with open(full, encoding='utf-8') as f:
            return json.dumps({'path': path, 'content': f.read()})
    if op == 'write':
        directory = os.path.dirname(full)
        if directory:
            os.makedirs(directory, exist_ok=True)
        with open(full, 'w', encoding='utf-8') as f:
            f.write(content or '')
        return json.dumps({'ok': True})
    if op == 'delete':
        os.remove(full)
        return json.dumps({'ok': True})
    raise ValueError(f'unknown fs op: {op}')

def vb_read_token():
    try:
        path = os.path.join('${BRAINSTEM_ROOT}', '.copilot_token')
        if os.path.exists(path):
            with open(path, encoding='utf-8') as f:
                raw = f.read().strip()
            if raw.startswith('{'):
                return json.loads(raw).get('access_token') or ''
            return raw
    except Exception:
        pass
    return ''
`;

async function boot(init) {
  siteBase = init.base || './';
  status('Loading Python runtime…');
  importScripts(PYODIDE_BASE + 'pyodide.js');
  pyodide = await loadPyodide({ indexURL: PYODIDE_BASE });

  status('Mounting persistent storage…');
  pyodide.FS.mkdirTree(BRAINSTEM_ROOT);
  try {
    pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, BRAINSTEM_ROOT);
    await syncFS(true);
  } catch (e) {
    console.warn('[vbrainstem] IDBFS unavailable; state will not persist:', e);
  }
  pyodide.FS.mkdirTree(BRAINSTEM_ROOT + '/agents');

  status('Installing the brainstem…');
  for (const rel of ENGINE_FILES) {
    const target = `${BRAINSTEM_ROOT}/${rel}`;
    try {
      fsWrite(target, await fetchText(rel));
    } catch (e) {
      // A flaky network must not brick a previously-working install: keep the
      // intact engine copy already persisted in IDBFS and boot from that.
      if (fsExists(target)) {
        console.warn('[vbrainstem] could not refresh', rel, '- booting from the persisted copy:', e);
      } else {
        throw e;
      }
    }
  }
  // Seed-ONCE semantics: a seed file is planted only the first time this
  // browser ever sees it. A user who deletes soul.md or a memory agent must
  // stay deleted across reloads — exactly like the on-device brainstem.
  const seedMarkerPath = `${BRAINSTEM_ROOT}/.vb_seeded`;
  let seeded = [];
  try { seeded = JSON.parse(pyodide.FS.readFile(seedMarkerPath, { encoding: 'utf8' })).seeded || []; }
  catch (e) { seeded = []; }
  let seededChanged = false;
  for (const rel of SEED_FILES) {
    const target = `${BRAINSTEM_ROOT}/${rel}`;
    if (seeded.includes(rel)) continue;
    if (!fsExists(target)) {
      try { fsWrite(target, await fetchText(rel)); } catch (e) { continue; }
    }
    seeded.push(rel);
    seededChanged = true;
  }
  if (seededChanged) fsWrite(seedMarkerPath, JSON.stringify({ seeded: seeded }));

  status('Waking the network layer…');
  await pyodide.loadPackage(['requests'], { messageCallback: () => {} });

  status('Starting the brainstem…');
  pyodide.runPython(`
import os, sys
os.chdir('${BRAINSTEM_ROOT}')
if '${BRAINSTEM_ROOT}' not in sys.path:
    sys.path.insert(0, '${BRAINSTEM_ROOT}')
`);

  // Seed auth + env before brainstem import so boot() sees them. The page's
  // stored vb_gh_token becomes the token FILE (not env) so /login/switch works.
  const env = init.env || {};
  const envPy = pyodide.toPy(env);
  pyodide.globals.set('_vb_env', envPy);
  pyodide.runPython(`
import os, json
os.environ.update({str(k): str(v) for k, v in _vb_env.items()})
`);
  envPy.destroy();

  pyodide.runPython(PY_GLUE);

  if (init.ghToken) {
    pyodide.globals.set('_vb_seed_token', init.ghToken);
    pyodide.runPython(`
import os, json, time
_p = os.path.join('${BRAINSTEM_ROOT}', '.copilot_token')
if not os.path.exists(_p) and _vb_seed_token:
    with open(_p, 'w', encoding='utf-8') as f:
        json.dump({'access_token': str(_vb_seed_token), 'saved_at': time.time()}, f)
del _vb_seed_token
`);
  }

  // Install persisted agents' pip deps BEFORE the first load_agents sweep —
  // micropip site-packages don't persist in IDBFS, so a reload must re-install
  // them or every dependency-using agent stays broken until a later pre-pass.
  await ensureDeps(null);

  const infoJson = pyodide.runPython(`vb_rapp('boot', '[]')`);
  await syncFS(false);
  mirrorToken();
  post({ type: 'ready', info: JSON.parse(infoJson) });
}

function mirrorToken() {
  try {
    const token = pyodide.runPython('vb_read_token()');
    post({ type: 'auth-state', ghToken: token || null });
  } catch (e) { /* non-fatal */ }
}

async function ensureDeps(extraSource) {
  let missing = [];
  try {
    if (extraSource != null) {
      pyodide.globals.set('_vb_extra_src', extraSource);
      missing = JSON.parse(pyodide.runPython('vb_scan_missing(_vb_extra_src)'));
      pyodide.runPython('del _vb_extra_src');
    } else {
      missing = JSON.parse(pyodide.runPython('vb_scan_missing()'));
    }
  } catch (e) { return; }
  if (!missing.length) return;
  let micropip = null;
  try {
    await pyodide.loadPackage(['micropip'], { messageCallback: () => {} });
    micropip = pyodide.pyimport('micropip');
    for (const pkg of missing) {
      try {
        await micropip.install(pkg);
        pyodide.runPython(`vb_note_install(${JSON.stringify(pkg)}, True)`);
        console.log('[vbrainstem] micropip installed', pkg);
      } catch (e) {
        pyodide.runPython(`vb_note_install(${JSON.stringify(pkg)}, False)`);
        console.warn('[vbrainstem] micropip could not install', pkg, e);
      }
    }
  } catch (e) {
    console.warn('[vbrainstem] micropip unavailable', e);
  } finally {
    if (micropip) { try { micropip.destroy(); } catch (e) {} }
  }
}

let voiceDepsReady = null;
async function ensureVoiceDeps() {
  if (voiceDepsReady) return voiceDepsReady;
  voiceDepsReady = (async () => {
    try {
      // pycryptodome IS a Pyodide built-in package (pyzipper needs the
      // Cryptodome namespace; pycryptodome is the same code under Crypto).
      await pyodide.loadPackage(['pycryptodome', 'micropip'], { messageCallback: () => {} });
      // Alias Cryptodome->Crypto, then micropip-install pyzipper WITHOUT deps
      // (its only dep is pycryptodomex, which has no wheel — we just aliased it).
      // Done entirely in Python so micropip's `deps` kwarg binds correctly.
      await pyodide.runPythonAsync(`
import sys, importlib
try:
    import pyzipper  # already installed?
except ModuleNotFoundError:
    if 'Cryptodome' not in sys.modules:
        import Crypto  # pycryptodome
        sys.modules['Cryptodome'] = Crypto
        for _sub in ('Cipher', 'Util', 'Random', 'Hash', 'Protocol', 'IO'):
            try:
                sys.modules['Cryptodome.' + _sub] = importlib.import_module('Crypto.' + _sub)
            except Exception:
                pass
    import micropip
    await micropip.install('pyzipper', deps=False)
    importlib.invalidate_caches()
`);
    } catch (e) {
      console.warn('[vbrainstem] voice deps unavailable', e);
    }
  })();
  return voiceDepsReady;
}

async function handleRequest(msg) {
  const { id, method, path } = msg;
  const spec = {
    method,
    path,
    query: msg.query || null,
    body: msg.bodyJson != null ? msg.bodyJson : null,
    form: msg.form || null,
    headers: msg.headers || null,
  };

  // micropip pre-pass: an imported agent's installable deps must exist before
  // the sync loader execs it (sync Python cannot await micropip itself).
  let extraSource = null;
  if (msg.files && msg.files.file && /\.py$/i.test(msg.files.file.filename || '')) {
    try { extraSource = new TextDecoder().decode(msg.files.file.bytes); } catch (e) {}
  }
  if ((method === 'POST' && (path === '/chat' || path === '/chat/stream' || path === '/agents/import'))
      || (method === 'GET' && (path === '/health' || path === '/agents'))) {
    await ensureDeps(extraSource);
  }
  // Voice.zip is AES-encrypted via pyzipper. pyzipper needs the `Cryptodome`
  // namespace (pycryptodomex), which has no Pyodide wheel — but Pyodide ships
  // `pycryptodome` (same code, `Crypto` namespace). Load that, alias
  // Cryptodome->Crypto, then micropip-install pyzipper WITHOUT its deps. Covers
  // GET /voice/config too (the UI auto-restores saved settings on page load).
  if (path.startsWith('/voice') && path !== '/voice/toggle' && path !== '/voice') {
    await ensureVoiceDeps();
  }

  let filesPy = null;
  if (msg.files) {
    const filesObj = {};
    for (const [field, entry] of Object.entries(msg.files)) {
      filesObj[field] = { filename: entry.filename, bytes: new Uint8Array(entry.bytes) };
    }
    filesPy = pyodide.toPy(filesObj);
  }

  pyodide.globals.set('_vb_spec', JSON.stringify(spec));
  if (filesPy) pyodide.globals.set('_vb_files', filesPy);

  let resultProxy;
  try {
    resultProxy = pyodide.runPython(
      filesPy ? 'vb_dispatch(_vb_spec, _vb_files)' : 'vb_dispatch(_vb_spec)');
  } catch (e) {
    post({ type: 'response', id, status: 500, json: { error: String(e).slice(0, 500) } });
    if (filesPy) filesPy.destroy();
    return;
  }
  if (filesPy) filesPy.destroy();

  const gen = resultProxy.get ? resultProxy.get('stream') : undefined;
  const isStream = gen !== undefined && gen !== null;

  if (isStream) {
    post({ type: 'stream-start', id });
    try {
      // PyProxy generators speak the JS iterator protocol: next() -> {done, value}.
      while (true) {
        if (abortedIds.has(id)) break;
        const step = gen.next();
        if (step.done) break;
        post({ type: 'stream-chunk', id, text: String(step.value) });
        // Yield to the event loop so abort messages can land between rounds.
        await new Promise((r) => setTimeout(r, 0));
      }
      // A chat stream may have written memories — persist before signaling done
      // so a tab closed right after the reply cannot lose them.
      await syncFS(false);
      post({ type: 'stream-end', id });
    } catch (e) {
      post({ type: 'stream-error', id, error: String(e).slice(0, 500) });
    } finally {
      abortedIds.delete(id);
      try { gen.destroy(); } catch (e) {}
      try { resultProxy.destroy(); } catch (e) {}
    }
  } else {
    // Mutations must be durably persisted BEFORE the response the UI treats as
    // confirmation ("Installed agent", editor save, sign-in) — a 250ms debounce
    // window would let a quick tab close silently discard confirmed state.
    if (method !== 'GET') await syncFS(false);
    let download = null;
    try {
      download = resultProxy.get('download');
      if (download) {
        const bytesProxy = download.get('bytes');
        const bytes = bytesProxy.toJs();
        const payload = {
          type: 'response',
          id,
          status: resultProxy.get('status'),
          download: {
            name: download.get('download_name'),
            mimetype: download.get('mimetype'),
            bytes: bytes.buffer,
          },
        };
        bytesProxy.destroy();
        post(payload, [bytes.buffer]);
      } else {
        pyodide.globals.set('_vb_result', resultProxy);
        const outJson = pyodide.runPython('vb_result_to_json(_vb_result)');
        const out = JSON.parse(outJson);
        post({ type: 'response', id, status: out.status, json: out.json, redirect: out.redirect });
      }
    } catch (e) {
      post({ type: 'response', id, status: 500, json: { error: String(e).slice(0, 500) } });
    } finally {
      if (download) { try { download.destroy(); } catch (e) {} }
      try { resultProxy.destroy(); } catch (e) {}
    }
  }

  // Auth-affecting routes may have rewritten the token file — mirror it so the
  // page keeps localStorage continuity with the classic vbrainstem pages.
  if (path.startsWith('/login') || path === '/chat' || path === '/chat/stream') mirrorToken();
  scheduleSync();
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'init') {
      if (!bootPromise) {
        bootPromise = boot(msg).catch((e) => {
          console.error('[vbrainstem] boot failed', e);
          post({ type: 'boot-error', error: String(e).slice(0, 700) });
        });
      }
      return;
    }
    if (bootPromise) await bootPromise;
    if (!pyodide) return;

    if (msg.type === 'abort') {
      abortedIds.add(msg.id);
      return;
    }
    if (msg.type === 'request') {
      await handleRequest(msg);
      return;
    }
    if (msg.type === 'rapp') {
      try {
        // rapp.run carries the agent SOURCE as args[0] — scan it so registry
        // agents with pip deps install before the exec, like /agents/import.
        const runSource = (msg.fn === 'run' && Array.isArray(msg.args)
          && typeof msg.args[0] === 'string') ? msg.args[0] : null;
        await ensureDeps(runSource);
        pyodide.globals.set('_vb_rapp_args', JSON.stringify(msg.args || []));
        const out = pyodide.runPython(`vb_rapp(${JSON.stringify(msg.fn)}, _vb_rapp_args)`);
        post({ type: 'rapp-result', id: msg.id, result: JSON.parse(out) });
        scheduleSync();
      } catch (e) {
        post({ type: 'rapp-error', id: msg.id, error: String(e).slice(0, 500) });
      }
      return;
    }
    if (msg.type === 'fs') {
      try {
        pyodide.globals.set('_vb_fs_content', msg.content == null ? null : msg.content);
        const out = pyodide.runPython(
          `vb_fs(${JSON.stringify(msg.op)}, ${JSON.stringify(msg.path || '')}, _vb_fs_content)`);
        // The editor clears its dirty marker on this reply — the write must
        // already be durable in IndexedDB by then.
        if (msg.op === 'write' || msg.op === 'delete') await syncFS(false);
        post({ type: 'fs-result', id: msg.id, result: JSON.parse(out) });
      } catch (e) {
        post({ type: 'fs-error', id: msg.id, error: String(e).slice(0, 500) });
      }
      return;
    }
  } catch (e) {
    console.error('[vbrainstem] worker error', e);
    if (msg && msg.id) {
      post({ type: 'response', id: msg.id, status: 500, json: { error: String(e).slice(0, 500) } });
    }
  }
};
