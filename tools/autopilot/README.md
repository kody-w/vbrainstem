# vbrainstem autopilot — the brain surgeon

A Playwright harness that drives the vbrainstem page in a **real browser exactly
like a person**: it types into the chat box, presses Enter, clicks the toolbar,
drops agent files onto the window, reloads the tab, and asserts what a human
would see. It is the side-by-side proof that the browser twin behaves like the
on-device RAPP Brainstem.

## Setup

```bash
cd tools/autopilot
npm install
npx playwright install chromium      # one-time browser download
```

(If the bundled Chromium cannot launch, the harness automatically falls back to
an installed Microsoft Edge via `channel: 'msedge'`.)

## Run — mock mode (default, no credentials, CI-safe)

```bash
node autopilot.mjs --mock
# or: npm run autopilot
```

Mock mode self-serves the repo root on `http://127.0.0.1:8123` and starts
`mock-copilot.mjs` in-process on `http://127.0.0.1:9797`. That server
impersonates **both** the rapp-auth worker and the Copilot API with a scripted,
deterministic brain. The page is seeded (before load) with
`localStorage.vb_env = {GITHUB_TOKEN, COPILOT_TOKEN_URL, VB_AUTH_WORKER}`
pointing at the mock, so no real network credential ever exists.

Note: Pyodide itself still loads from the jsdelivr CDN, so the machine needs
outbound internet even in mock mode.

## Run — real mode

```bash
VB_GH_TOKEN=<a GitHub token with Copilot access> node autopilot.mjs --real
```

Real mode seeds `localStorage.vb_gh_token` and lets the page talk to the real
auth worker and `api.individual.githubcopilot.com`. Because a live LLM is not
deterministic, it runs the loose flight plan (steps a, c–e, i, j) and only
asserts non-empty replies. **The token value is never printed.**

Add `--keep` to watch any run in a headed browser window.

## The steps and what each one proves

| Step | Action | Proves |
|------|--------|--------|
| a | goto `/index.html`, wait for `#status-text` = "connected" (up to 180 s) | Pyodide boots, `brainstem_web.py` imports, `/health` answers, auth chain works |
| b | poll `/health` until `model == claude-haiku-4-5`, check `#model-select` | `/models` fetch + auto-select-highest-Haiku logic (mock catalog makes Haiku the right answer) |
| c | type "hello autopilot", Enter, wait for the reply bubble | full `/chat/stream` loop; reply carries `MOCK_LLM_OK` **and names ManageMemory + ContextMemory**, proving per-agent tool schemas were offered to the LLM |
| d | send "Remember my favorite color is teal" | scripted tool_calls round: `ManageMemory.perform()` runs, agent-log disclosure ("agent called ManageMemory") renders |
| e | send "What do you remember?" | memory persisted through the `local_storage` shim and re-injected as a `<memory>` block into the system prompt (the mock quotes it back) |
| f | click `#agents-btn` | `/agents` listing: rows for both memory agents, each with Export and Delete |
| g | synthetic DataTransfer drop of `ping_agent.py` | drag-drop → confirm → `POST /agents/import` → "Installed agent:" alert → panel lists the new file |
| h | reload the page | IDBFS persistence: agent file **and** the teal memory survive a full page reload |
| i | `rapp.health()` / `rapp.eval('1+1')` | the `window.rapp` console contract (status ok, signed_in, working Python REPL) |
| j | `fetch('/workspace/export')` | the workspace zip route: HTTP 200, `application/zip`, > 100 bytes |
| k | click the tour invite pill | "The First Interview" guided tour: `#tour-card` appears and exits cleanly |

On any FAIL the harness saves a full-page screenshot to
`tools/autopilot/artifacts/`, prints the last page-console lines, and exits 1.
A summary table is always printed at the end.

## Side-by-side: drive the on-device brainstem with the same assertions

Run the LOCAL brainstem, then point the harness at it:

```bash
# terminal 1 — the real thing
cd ~/.brainstem/src/rapp_brainstem && python brainstem.py

# terminal 2 — the same flight plan against it
cd tools/autopilot
node autopilot.mjs --real --base http://localhost:7071
```

When `--base` answers `GET /health` at the *server* level (only a real
brainstem does — on a statically hosted vbrainstem page `/health` exists only
inside the tab), the harness detects it and:

- skips **all** `vb_env` / `localStorage` seeding (the local server owns its
  own auth chain — sign in with `gh auth login` or the `/login` flow first),
- runs the loose steps a, c–e against the identical selectors (`#status-text`,
  `#input`, `.msg.assistant`, `button.logs-label`), because the UI is verbatim
  the same file,
- marks the browser-only surfaces (`window.rapp`, `/workspace/export`, tour
  drag-drop persistence) as SKIP with a reason.

Green on both sides means the twin and the original are behaviorally
indistinguishable for the core interview loop.

## Flags

| Flag | Meaning |
|------|---------|
| `--mock` | (default) scripted Copilot + auth worker, full steps a–k |
| `--real` | real network; needs `VB_GH_TOKEN` unless `--base` is a real brainstem |
| `--base <url>` | drive an already-served page/server instead of self-serving the repo |
| `--keep` | headed browser (watch it fly) |

Environment: `AUTOPILOT_HTTP_PORT` (static server, default 8123),
`MOCK_COPILOT_PORT` (mock server, default 9797).
