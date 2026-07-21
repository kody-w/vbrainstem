/*
 * autopilot.mjs — the "brain surgeon" harness. Drives the vbrainstem UI in a
 * real browser exactly like a person would: types into the chat box, presses
 * Enter, clicks buttons, drops files, reloads, and asserts what a human would
 * see. Zero dependencies beyond playwright.
 *
 * Modes:
 *   node autopilot.mjs --mock            (default) in-process mock Copilot API,
 *                                        self-served static repo, full steps a-k
 *   node autopilot.mjs --real            real auth worker + Copilot API; needs
 *                                        env VB_GH_TOKEN; loose steps a, c-e, i, j
 *   node autopilot.mjs --base <url>      drive an already-served page instead of
 *                                        self-serving the repo. When <url> answers
 *                                        GET /health like a real brainstem server
 *                                        (e.g. http://localhost:7071 with --real),
 *                                        ALL localStorage seeding is skipped and
 *                                        browser-only steps are marked SKIP.
 *   node autopilot.mjs --keep            run headed (visible browser window)
 *
 * On any FAIL a full-page screenshot is saved to tools/autopilot/artifacts/.
 * Exit code 1 if any step FAILs. Token values are NEVER printed.
 */

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { startMockCopilot, DEFAULT_PORT as MOCK_PORT } from './mock-copilot.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const STATIC_PORT = Number(process.env.AUTOPILOT_HTTP_PORT) || 8123;

// Pyodide boot can take 60s+ on CI — every gate is generous.
const BOOT_TIMEOUT = 180_000;
const CHAT_TIMEOUT = 150_000;
const UI_TIMEOUT = 60_000;

// ── helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function scrub(s) {
  // Belt-and-braces: never let a credential-shaped string reach stdout.
  return String(s == null ? '' : s)
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{6,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '***');
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function parseArgs(argv) {
  const flags = { mode: 'mock', base: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') flags.mode = 'mock';
    else if (a === '--real') flags.mode = 'real';
    else if (a === '--keep') flags.keep = true;
    else if (a === '--base') flags.base = argv[++i];
    else if (a.startsWith('--base=')) flags.base = a.slice('--base='.length);
    else {
      console.error(`Unknown argument: ${a}`);
      console.error('Usage: node autopilot.mjs [--mock|--real] [--base <url>] [--keep]');
      process.exit(2);
    }
  }
  return flags;
}

// ── tiny static file server over the repo root ───────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

function startStaticServer(root, port) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const full = path.normalize(path.join(root, pathname));
      if (!full.startsWith(path.normalize(root + path.sep)) && full !== path.normalize(root)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const data = await readFile(full);
      const type = MIME[path.extname(full).toLowerCase()] || 'text/plain; charset=utf-8';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      server,
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

// ── real-brainstem detection ────────────────────────────────────────────────

async function probeRealBrainstem(base) {
  // A real (on-device) brainstem answers GET /health with JSON at the server
  // level. A statically hosted vbrainstem page 404s: /health only exists
  // INSIDE the page, via the patched window.fetch.
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) return false;
    const j = await r.json();
    return !!(j && typeof j === 'object' && 'status' in j);
  } catch {
    return false;
  }
}

// ── browser ─────────────────────────────────────────────────────────────────

async function launchBrowser(headless) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('playwright is not installed. Run: npm install && npx playwright install chromium');
    process.exit(2);
  }
  try {
    return await chromium.launch({ headless });
  } catch (e1) {
    try {
      // Fallback: use an installed Microsoft Edge instead of the bundled build.
      return await chromium.launch({ headless, channel: 'msedge' });
    } catch (e2) {
      throw new Error(
        `Could not launch bundled chromium (${scrub(e1.message).split('\n')[0]}) ` +
        `nor msedge (${scrub(e2.message).split('\n')[0]}). Run: npx playwright install chromium`,
      );
    }
  }
}

// ── page interaction helpers ────────────────────────────────────────────────

async function waitConnected(page) {
  await page.waitForFunction(
    () => (document.getElementById('status-text')?.textContent || '').trim() === 'connected',
    null,
    { timeout: BOOT_TIMEOUT, polling: 500 },
  );
}

async function lastAssistantText(page) {
  return page.evaluate(() => {
    const els = document.querySelectorAll('.msg.assistant:not(.typing-indicator)');
    const last = els[els.length - 1];
    return last ? ((last.querySelector('.bubble') || last).textContent || '') : '';
  });
}

/* Types into #input, presses Enter, waits for a new non-empty assistant
 * bubble, lets streamed text settle, returns the final reply text. */
async function sendChat(page, text, timeoutMs = CHAT_TIMEOUT) {
  const before = await page.evaluate(
    () => document.querySelectorAll('.msg.assistant:not(.typing-indicator)').length,
  );
  await page.fill('#input', text);
  await page.press('#input', 'Enter');
  await page.waitForFunction(
    (n) => {
      const els = document.querySelectorAll('.msg.assistant:not(.typing-indicator)');
      if (els.length <= n) return false;
      const last = els[els.length - 1];
      const t = (last.querySelector('.bubble') || last).textContent || '';
      return t.trim().length > 0;
    },
    before,
    { timeout: timeoutMs, polling: 500 },
  );
  // Settle: wait until the (possibly streaming) text stops changing.
  let prev = '';
  for (let i = 0; i < 40; i++) {
    const cur = await lastAssistantText(page);
    if (cur === prev && cur.trim()) break;
    prev = cur;
    await sleep(400);
  }
  return prev.trim();
}

async function openAgentsPanel(page) {
  const alreadyOpen = await page.evaluate(
    () => document.getElementById('agents-panel')?.classList.contains('open') || false,
  );
  if (!alreadyOpen) await page.click('#agents-btn');
  await page.waitForSelector('#agents-panel.open', { timeout: UI_TIMEOUT });
  // Rows load async from /agents.
  await page.waitForFunction(
    () => document.querySelectorAll('#agent-list-ul li').length > 0,
    null,
    { timeout: UI_TIMEOUT, polling: 500 },
  );
}

async function agentRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#agent-list-ul li')].map((li) => ({
      text: li.textContent || '',
      hasExport: [...li.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Export'),
      hasDelete: [...li.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Delete'),
    })),
  );
}

const PING_AGENT_SOURCE = `from agents.basic_agent import BasicAgent


class PingAgent(BasicAgent):
    def __init__(self):
        self.name = "Ping"
        self.metadata = {
            "name": self.name,
            "description": "Replies with a pong so the autopilot can verify drag-drop installs.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return "pong from the browser"
`;

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const isReal = flags.mode === 'real';
  await mkdir(ARTIFACTS_DIR, { recursive: true });

  let staticSrv = null;
  let mock = null;
  let base = flags.base ? flags.base.replace(/\/+$/, '') : null;
  let realBrainstem = false;

  if (!base) {
    staticSrv = await startStaticServer(REPO_ROOT, STATIC_PORT);
    base = staticSrv.url;
    console.log(`[autopilot] self-serving ${REPO_ROOT} at ${base}`);
  } else {
    console.log(`[autopilot] driving external base ${base}`);
  }

  if (isReal && flags.base) {
    realBrainstem = await probeRealBrainstem(base);
    if (realBrainstem) {
      console.log('[autopilot] --base answers /health at the server level: treating it as a REAL on-device brainstem (no localStorage seeding, browser-only steps skipped)');
    }
  }

  if (!isReal) {
    mock = await startMockCopilot({ port: Number(process.env.MOCK_COPILOT_PORT) || MOCK_PORT });
  } else if (!realBrainstem && !process.env.VB_GH_TOKEN) {
    console.error('[autopilot] --real requires env VB_GH_TOKEN (a GitHub token with Copilot access). It is seeded into the page and never printed.');
    process.exit(2);
  }

  const browser = await launchBrowser(!flags.keep);
  const context = await browser.newContext();

  if (!realBrainstem) {
    if (!isReal) {
      const env = {
        GITHUB_TOKEN: 'ghu_mockmockmock',
        COPILOT_TOKEN_URL: `${mock.url}/token`,
        VB_AUTH_WORKER: mock.url,
      };
      await context.addInitScript((envJson) => {
        try { localStorage.setItem('vb_env', envJson); } catch { /* ignore */ }
      }, JSON.stringify(env));
    } else {
      await context.addInitScript((tok) => {
        try { localStorage.setItem('vb_gh_token', tok); } catch { /* ignore */ }
      }, process.env.VB_GH_TOKEN);
    }
  }

  const page = await context.newPage();
  page.setDefaultTimeout(UI_TIMEOUT);

  const dialogs = [];
  page.on('dialog', async (d) => {
    dialogs.push({ type: d.type(), message: d.message() });
    try { await d.accept(); } catch { /* already handled */ }
  });

  const consoleTail = [];
  const tailPush = (line) => {
    consoleTail.push(scrub(line));
    if (consoleTail.length > 80) consoleTail.shift();
  };
  page.on('console', (m) => tailPush(`[console:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => tailPush(`[pageerror] ${e.message}`));

  async function waitForDialog(re, timeoutMs = UI_TIMEOUT) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const bad = dialogs.find((d) => /Failed to import|Error importing|Only \.py/.test(d.message));
      if (bad) throw new Error(`import failed: ${scrub(bad.message)}`);
      const hit = dialogs.find((d) => re.test(d.message));
      if (hit) return hit;
      await sleep(200);
    }
    throw new Error(`no dialog matching ${re} within ${timeoutMs}ms`);
  }

  // ── step runner ────────────────────────────────────────────────────────────
  const results = [];
  let anyFail = false;

  async function step(id, name, fn) {
    console.log(`\n[step ${id}] ${name}`);
    const t0 = Date.now();
    try {
      await fn();
      results.push({ id, name, status: 'PASS', ms: Date.now() - t0 });
      console.log(`[step ${id}] PASS (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      return true;
    } catch (err) {
      anyFail = true;
      const msg = scrub((err && err.message) || err);
      results.push({ id, name, status: 'FAIL', ms: Date.now() - t0, error: msg });
      console.error(`[step ${id}] FAIL: ${msg}`);
      try {
        const shot = path.join(ARTIFACTS_DIR, `step-${id}-fail.png`);
        await page.screenshot({ path: shot, fullPage: true });
        console.error(`[step ${id}] screenshot saved: ${shot}`);
      } catch { /* page may be gone */ }
      if (consoleTail.length) {
        console.error(`[step ${id}] last page console lines:`);
        for (const line of consoleTail.slice(-12)) console.error(`    ${line}`);
      }
      return false;
    }
  }

  function skip(id, name, reason) {
    results.push({ id, name, status: 'SKIP', reason });
    console.log(`\n[step ${id}] SKIP — ${reason}`);
  }

  // ── the flight plan ────────────────────────────────────────────────────────

  const indexUrl = realBrainstem ? `${base}/` : `${base}/index.html`;

  const bootOk = await step('a', `boot: goto ${indexUrl} and wait for status "connected"`, async () => {
    await page.goto(indexUrl, { waitUntil: 'domcontentloaded' });
    await waitConnected(page);
  });

  if (bootOk) {
    // b — model auto-select (mock only: the catalog is deterministic there)
    if (!isReal) {
      await step('b', 'model auto-select picked claude-haiku-4-5', async () => {
        await page.waitForFunction(
          async () => {
            try {
              const r = await fetch('/health');
              const j = await r.json();
              return j.model === 'claude-haiku-4-5';
            } catch { return false; }
          },
          null,
          { timeout: UI_TIMEOUT, polling: 1000 },
        );
        await page.waitForFunction(
          () => document.getElementById('model-select')?.value === 'claude-haiku-4-5',
          null,
          { timeout: UI_TIMEOUT, polling: 500 },
        );
      });
    } else {
      skip('b', 'model auto-select picked claude-haiku-4-5', 'real mode: live model catalog is not deterministic');
    }

    // c — plain chat round-trip
    await step('c', 'chat: "hello autopilot" gets a reply (tools offered)', async () => {
      const reply = await sendChat(page, 'hello autopilot');
      assert(reply.length > 0, 'assistant reply is empty');
      if (!isReal) {
        assert(reply.includes('MOCK_LLM_OK'), `reply lacks MOCK_LLM_OK marker: "${reply.slice(0, 200)}"`);
        assert(reply.includes('ManageMemory'), 'reply does not name ManageMemory among offered tools');
        assert(reply.includes('ContextMemory'), 'reply does not name ContextMemory among offered tools');
      }
    });

    // d — remember -> ManageMemory tool round
    await step('d', 'memory write: "Remember my favorite color is teal" triggers ManageMemory', async () => {
      const reply = await sendChat(page, 'Remember my favorite color is teal');
      assert(reply.length > 0, 'assistant reply is empty');
      if (!isReal) {
        await page.waitForFunction(
          () => [...document.querySelectorAll('button.logs-label')].some(
            (b) => b.textContent.includes('agent called') && b.textContent.includes('ManageMemory'),
          ),
          null,
          { timeout: UI_TIMEOUT, polling: 500 },
        );
      } else {
        const sawLog = await page.evaluate(
          () => [...document.querySelectorAll('button.logs-label')].some(
            (b) => b.textContent.includes('agent called'),
          ),
        );
        console.log(`[step d] loose mode: agent-log disclosure ${sawLog ? 'observed' : 'not observed (model may have answered without a tool call)'}`);
      }
    });

    // e — memory read-back
    await step('e', 'memory read: "What do you remember?" mentions teal', async () => {
      const reply = await sendChat(page, 'What do you remember?');
      assert(reply.length > 0, 'assistant reply is empty');
      if (!isReal) {
        assert(/teal/i.test(reply), `reply does not mention "teal": "${reply.slice(0, 300)}"`);
      } else if (/teal/i.test(reply)) {
        console.log('[step e] loose mode: reply mentions teal — memory round-trip observed');
      }
    });

    if (!isReal) {
      // f — agents panel lists the two memory agents with Export/Delete
      await step('f', 'agents panel lists memory agents with Export/Delete', async () => {
        await openAgentsPanel(page);
        const rows = await agentRows(page);
        for (const fname of ['context_memory_agent.py', 'manage_memory_agent.py']) {
          const row = rows.find((r) => r.text.includes(fname));
          assert(row, `agents panel has no row for ${fname} (rows: ${rows.map((r) => r.text.trim()).join(' | ')})`);
          assert(row.hasExport, `${fname} row has no Export button`);
          assert(row.hasDelete, `${fname} row has no Delete button`);
        }
      });

      // g — drag-drop install of a synthetic agent file
      await step('g', 'drag-drop installs ping_agent.py', async () => {
        dialogs.length = 0;
        await page.evaluate((src) => {
          const dt = new DataTransfer();
          dt.items.add(new File([src], 'ping_agent.py', { type: 'text/x-python' }));
          window.dispatchEvent(new DragEvent('drop', {
            bubbles: true, cancelable: true, dataTransfer: dt,
          }));
        }, PING_AGENT_SOURCE);
        const confirmDlg = await waitForDialog(/Install ping_agent\.py\?/, UI_TIMEOUT);
        assert(confirmDlg, 'no install confirm dialog appeared');
        const installed = await waitForDialog(/^Installed agent:/, UI_TIMEOUT);
        console.log(`[step g] ${installed.message}`);
        await openAgentsPanel(page);
        await page.waitForFunction(
          () => [...document.querySelectorAll('#agent-list-ul li')].some(
            (li) => (li.textContent || '').includes('ping_agent.py'),
          ),
          null,
          { timeout: UI_TIMEOUT, polling: 500 },
        );
      });

      // h — reload: IDBFS persistence of agents AND memories
      await step('h', 'reload persists ping_agent.py and the teal memory (IDBFS)', async () => {
        await sleep(1500); // let the worker's debounced FS.syncfs flush to IndexedDB
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitConnected(page);
        await openAgentsPanel(page);
        await page.waitForFunction(
          () => [...document.querySelectorAll('#agent-list-ul li')].some(
            (li) => (li.textContent || '').includes('ping_agent.py'),
          ),
          null,
          { timeout: UI_TIMEOUT, polling: 500 },
        );
        // Close the panel so it does not overlap the input.
        await page.click('#chat').catch(() => {});
        const reply = await sendChat(page, 'What do you remember?');
        assert(/teal/i.test(reply), `after reload the reply does not mention "teal": "${reply.slice(0, 300)}"`);
      });
    } else {
      skip('f', 'agents panel lists memory agents', 'real mode runs the loose flight plan (a, c-e, i, j)');
      skip('g', 'drag-drop installs ping_agent.py', 'real mode runs the loose flight plan (a, c-e, i, j)');
      skip('h', 'reload persistence (IDBFS)', 'real mode runs the loose flight plan (a, c-e, i, j)');
    }

    // i — window.rapp contract
    if (realBrainstem) {
      skip('i', 'window.rapp contract', 'on-device brainstem has no window.rapp console (browser-only surface)');
    } else {
      await step('i', 'window.rapp contract: health() ok+signed_in, eval("1+1") -> 2', async () => {
        const hasRapp = await page.evaluate(() => typeof window.rapp === 'object' && !!window.rapp);
        assert(hasRapp, 'window.rapp is not defined');
        const health = await page.evaluate(() => window.rapp.health());
        assert(health && health.status === 'ok', `rapp.health().status is ${health && health.status}, expected "ok"`);
        assert(health.signed_in === true, 'rapp.health().signed_in is not true');
        const ev = await page.evaluate(() => window.rapp.eval('1+1'));
        assert(ev && String(ev.output).includes('2'), `rapp.eval('1+1') output lacks "2": ${JSON.stringify(ev)}`);
      });
    }

    // j — workspace export
    if (realBrainstem) {
      skip('j', 'GET /workspace/export returns a zip', 'on-device brainstem has no /workspace/export route (browser-only surface)');
    } else {
      await step('j', 'GET /workspace/export returns a zip > 100 bytes', async () => {
        const out = await page.evaluate(async () => {
          const r = await fetch('/workspace/export');
          const b = await r.blob();
          return { status: r.status, type: r.headers.get('content-type') || '', size: b.size };
        });
        assert(out.status === 200, `HTTP ${out.status}`);
        assert(out.type.includes('application/zip'), `content-type is "${out.type}"`);
        assert(out.size > 100, `zip is only ${out.size} bytes`);
        console.log(`[step j] workspace zip: ${out.size} bytes`);
      });
    }

    // k — guided tour smoke (mock only)
    if (!isReal) {
      await step('k', 'guided tour: invite opens #tour-card, exit closes it', async () => {
        const hasTour = await page.evaluate(() => typeof window.startTour === 'function');
        assert(hasTour, 'window.startTour is not a function');
        const invite = page.locator('button.tour-invite:visible').first();
        if (await invite.count() > 0 && await invite.isVisible().catch(() => false)) {
          await invite.click();
        } else {
          await page.evaluate(() => window.startTour());
        }
        await page.waitForSelector('#tour-card', { timeout: 20_000 });
        await page.click('#tour-card .tc-head button');
        await page.waitForFunction(() => !document.getElementById('tour-card'), null, { timeout: 10_000 });
      });
    } else {
      skip('k', 'guided tour smoke', 'real mode runs the loose flight plan (a, c-e, i, j)');
    }
  } else {
    for (const [id, name] of [
      ['b', 'model auto-select'], ['c', 'plain chat'], ['d', 'memory write'],
      ['e', 'memory read'], ['f', 'agents panel'], ['g', 'drag-drop install'],
      ['h', 'reload persistence'], ['i', 'window.rapp contract'],
      ['j', 'workspace export'], ['k', 'guided tour smoke'],
    ]) skip(id, name, 'boot (step a) failed');
  }

  // ── summary ────────────────────────────────────────────────────────────────
  console.log('\n================ autopilot summary ================');
  console.log(`  mode: ${flags.mode}${realBrainstem ? ' (real on-device brainstem)' : ''}   base: ${base}`);
  for (const r of results) {
    const time = r.ms != null ? `${(r.ms / 1000).toFixed(1)}s` : '';
    const note = r.error ? ` — ${r.error}` : (r.reason ? ` — ${r.reason}` : '');
    console.log(`  ${String(r.id).padEnd(3)} ${r.status.padEnd(5)} ${time.padStart(7)}  ${r.name}${note}`);
  }
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failedN = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.log(`  ${passed} passed, ${failedN} failed, ${skipped} skipped`);
  console.log('===================================================\n');

  await browser.close().catch(() => {});
  if (mock) await mock.close().catch(() => {});
  if (staticSrv) await staticSrv.close().catch(() => {});

  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error('[autopilot] fatal:', scrub((err && err.stack) || err));
  process.exit(1);
});
