# vBrainstem

**The RAPP Brainstem, running 100% in your browser.** Same engine, same UI, same
guided tour ("The First Interview") as the on-device brainstem — real CPython via
[Pyodide](https://pyodide.org), zero install, no admin rights. This is the
zero-friction install: open the page and you are running a brainstem.

**Live:** https://kody-w.github.io/vbrainstem/

**Doorman guide:** https://kody-w.github.io/vbrainstem/guide.html — set up Claude as the sealed
**doorman** to any machine's brainstem (WebRTC + kite tethers, kited twins, end-to-end AES-256-GCM).

## How it works

`index.html` is the local brainstem UI (`rapp_brainstem/index.html`) copied
**verbatim**, plus one boot block injected after `<title>`. The boot block loads
`vbrainstem-boot.js`, which patches `window.fetch` so every same-origin brainstem
route (`/chat`, `/health`, `/agents`, `/login`, `/models`, ...) is dispatched to
`brainstem_web.py` — a faithful, route-for-route port of
`rapp_brainstem/brainstem.py` **v0.6.16** — running in Pyodide inside a Web
Worker. The disk is Pyodide MEMFS persisted to IndexedDB (IDBFS), so agents,
soul.md and memories survive reloads.

Auth: GitHub device-code sign-in goes through the CORS proxy worker
`https://rapp-auth.kwildfeuer.workers.dev` (github.com sends no CORS headers).
After that, the Copilot token exchange (`api.github.com/copilot_internal/v2/token`)
and chat completions (`api.individual.githubcopilot.com`) go **direct** to
GitHub — both endpoints send `Access-Control-Allow-Origin: *` (empirically
verified). Tokens live in `localStorage` (`vb_gh_token`) and the worker's MEMFS;
they never touch any third-party server. `brainstem_web.py` honors env overrides
(`GITHUB_TOKEN`, `COPILOT_TOKEN_URL`, `VB_AUTH_WORKER`) seeded from the
`localStorage` key `vb_env` (a JSON object).

| File | Role |
|------|------|
| `index.html` | The local brainstem UI, verbatim, + the vBrainstem boot block |
| `vbrainstem-boot.js` | Page-side bridge: fetch interception, SSE bridging, `window.rapp`, Brainstem Studio (VS Code shell + Copilot Chat), deep links |
| `vbrainstem-worker.js` | Pyodide host Web Worker: boots Python, runs the micropip pre-pass, dispatches requests |
| `brainstem_web.py` | The brainstem itself — faithful port of `rapp_brainstem/brainstem.py` v0.6.16 |
| `local_storage.py` | Same storage shim as the local brainstem (`.brainstem_data/` under MEMFS) |
| `agents/` | Starter agents (`basic_agent.py`, memory agents); user agents land here too |
| `soul.md` | System prompt — knows it is in a browser and when to offer the tether |
| `VERSION` | Parity version (matches the local brainstem release it ports) |
| `rapp-guide.html` | The 14-step RAPP production guide, wired to the in-browser chat |
| `tether.ps1` / `tether.sh` | One-command move to the on-device brainstem (see below) |
| `tools/autopilot/` | Browser-driving test harness (see below) |

## Exact parity

The route contract is identical to the local server:

| Route | Status |
|-------|--------|
| `POST /chat` | identical — agents, tool-calling loop, memory injection |
| `POST /chat/stream` | SSE, via the local server's own documented non-streaming fallback (whole-round deltas, `"streamed": false`) |
| `GET /health` | identical |
| `POST /login`, `/login/poll`, `GET /login/status`, `POST /login/switch`, `/login/retry` | identical shapes; device-code start/poll rides the rapp-auth worker |
| `GET /models`, `POST /models/set` | identical (including `auto` selection) |
| `GET /agents`, `POST /agents/import`, `GET /agents/export/<f>`, `DELETE /agents/<f>` | identical — drag-drop import, hot reload every request |
| `GET/POST /voice*` | identical |
| `GET /diagnostics`, `/diagnostics/book.json`, `POST /diagnostics/clear`, `/diagnostics/report`, `GET /version`, `GET /debug/auth` | identical |
| `GET /workspace/export` | browser-only addition — workspace zip for the tether |

Deliberate browser deltas, all minimal:

- **Streaming** — buffered XHR can't expose partial bodies without cross-origin
  isolation, so `/chat/stream` takes the same non-streaming fallback path the
  local server documents, marking frames `"streamed": false`. The UI's streaming
  renderer, agent-log events and abort handling work unchanged.
- **Device-code auth** — start/poll goes through the rapp-auth worker; everything
  after that is direct to GitHub.
- **No `gh` CLI link** in the auth chain (no subprocess in the sandbox).
- **pip auto-install** — served by an async micropip pre-pass in the worker
  before each dispatch, instead of `pip install` at agent import time.
- **No LAN mode** / Host checks (a browser tab has no LAN surface).

## Brain Surgeon — the GitHub Copilot agent loop, in the browser

**Live:** open the [vBrainstem](https://kody-w.github.io/vbrainstem/) and click the
**🩺 Brain Surgeon** tab on the right edge.

Not a shell — the **real GitHub Copilot agent loop** (the same think→edit→test loop
VS Code's Agent mode runs), side-by-side with the brainstem chat. Describe an agent
and Copilot writes the single-file `*_agent.py` into this vBrainstem's workspace,
**hot-loads it, and tests it live** against `/chat`, iterating until it works — no
VS Code, no install. It runs on your signed-in GitHub Copilot account.

- Completions: `POST /surgeon/complete` → `brainstem_web.call_copilot()` (real
  Copilot token, model, and fallbacks) returns the assistant message verbatim;
  the **page** drives the loop with tools (`list_agents`, `read_file`,
  `write_agent`, `delete_agent`, `test_brainstem`).
- Tools operate on the LOCAL vBrainstem via `__vbrainstem.local()` / `.fs()`, so
  the Surgeon always builds here even while `/chat` is tethered to a desk brainstem.
- Files: [`surgeon.js`](surgeon.js) (loop + side panel), `brainstem_web.py`
  (`/surgeon/complete`). This is how the Brain Surgeon builds agents without VS Code.

## Desk Pair — the vBrainstem as your desk's remote (Apple-style)

Ask your on-device brainstem to *"desk pair my phone"*
([`desk_pair_agent.py`](desk_pair_agent.py), drop-in) — a pairing page opens
with a QR. **Scanning it opens the vBrainstem itself** (`?deskpair=<peer>`):
the full UI runs the ceremony — the phone shows a **6-digit code**, and typing
that code **into the computer** is the human sign-off. The QR carries only a
peer-id; the code never crosses the network (salted hash, one attempt); the
session token is released sealed (`rapp-sealed/1.0`) under a code-derived key.

While paired, the vBrainstem is **tethered**: every `/chat` turn rides the
sealed `5a-tether` to the DESK brainstem — chat is the only wire (§3). When
the tether is lost (desk tab closed, network hop), turns **fall back to the
in-browser Pyodide brainstem** and a background loop keeps re-attaching by
sealed key possession (no new code) — heartbeat + ICE-state watch declare loss
within seconds, and in-flight turns fail over immediately
(`deskpair-tether.js`).

Also here: [`deskpair-host.html`](https://kody-w.github.io/vbrainstem/deskpair-host.html)
— a zero-install host that boots `brainstem_web.py` in-page (or fronts an
on-device brainstem via `?bs=…&secret=…`), and `deskpair.html`, a minimal
phone remote.

## The Brainstem Tether

When you outgrow the sandbox — agents that shell out, raw sockets, local files,
CORS-hostile APIs — you don't start over. Ask the in-browser brainstem to
**"download my workspace"** (or hit `GET /workspace/export`); it saves
`brainstem-workspace-YYYY-MM-DD.zip` — your `agents/*.py`, `soul.md` and
`.brainstem_data/` memories, **no tokens** — into Downloads. Then run one command:

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/kody-w/vbrainstem/main/tether.ps1 | iex
```

**Mac/Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/kody-w/vbrainstem/main/tether.sh | bash
```

It installs the on-device brainstem, imports the freshest workspace zip from
Downloads, and opens `localhost:7071` — every agent and memory carried over.
Credentials never leave the browser; you sign in fresh on the machine.

## Brainstem Studio — VS Code + Copilot Chat, in the browser

The header's **Open in VS Code** button opens **Brainstem Studio**: the VS Code
shell built around Monaco (the same editor engine VS Code ships), over the live
virtual workspace.

- **Activity bar + Explorer** — a file tree that reflects the on-device
  `rapp_brainstem` layout (`agents/` folder, `soul.md`, the engine files). Save
  an agent and it hot-loads on the next message — agents are re-discovered every
  request, no restart, exactly like editing `agents/` on disk.
- **Copilot Chat panel (right side)** — a chat docked next to the editor, wired
  to the brainstem's streaming `/chat`. The human talks to the brainstem here
  while editing; the **brain surgeon** drives that same panel in the user's
  place via `rapp.editor.send("…")` — the browser twin of VS Code + GitHub
  Copilot Chat. It shares the same memory and agents as the main chat, and an
  agent the brainstem writes shows up in the Explorer immediately.

Full VS Code in the browser (code-server / vscode.dev) can't reach the in-page
Pyodide brainstem, so the Studio wires the VS Code shell directly to it instead.

## The guide

`rapp-guide.html` is the 14-step RAPP production methodology — the same guide
the AIBAST library ships — with every interview-loop prompt wired directly to
the in-browser chat. Click a prompt in the guide and the brainstem runs it.

## Autopilot (the brain surgeon)

`tools/autopilot/` drives the page like a person: boots it in a real browser,
signs in, chats, imports agents, and asserts on what the UI shows.

- **Mock-LLM mode** (default, used in CI) — no token needed, deterministic.
- **`--real`** — run the same script against the live Copilot API with your own token.
- **`--base http://localhost:7071`** — point the identical assertions at an
  on-device brainstem, side by side. If autopilot passes against both, parity holds.

It also verifies the structural invariant that `index.html` is the local UI
verbatim plus the boot block after `<title>`.

## Updating `index.html` from the local brainstem

Do **not** hand-edit the UI here. When `rapp_brainstem/index.html` changes:

1. Re-copy `rapp_brainstem/index.html` over `index.html` verbatim.
2. Re-add the vBrainstem boot block (the `<template id="vb-kite-mark">` +
   `<script src="./vbrainstem-boot.js">` block, delimited by its banner
   comments) immediately after the `<title>` line.

That boot block is the **only** divergence from the local UI —
`tools/autopilot` verifies this property, and `brainstem-ui-reference.html`
holds the pristine local copy for diffing.

## Headless SDK — drive agents through a port (`vbrainstem_sdk.py`)

A browser tab can't open a port, but the same agent runtime can run headless. `vbrainstem_sdk.py`
is a single-file, stdlib-only server that loads the live RAR catalog and runs agents in **real
CPython** (full stdlib, real network + filesystem — so secret/network agents work), drivable like
`brainstem.py`:

```bash
python3 vbrainstem_sdk.py serve --port 7173      # HTTP API on a port
python3 vbrainstem_sdk.py run @aibast-agents-library/account_intelligence "360 for Acme"
python3 vbrainstem_sdk.py agents --grep fraud
python3 vbrainstem_sdk.py eval "import sys; print(sys.version)"
```

HTTP (CORS-enabled — drive it from `curl`, the `rapp-brainstem` skill, an agent, or the browser):

```
GET  /health                              → {status, agents, runtime}
GET  /agents[?grep=]                       → {agents:[…]}
POST /run    {"slug":"@pub/agent","request":"…","args":{}}  → {executed, output|error}
POST /eval   {"code":"…python…"}           → {output}
```

Secrets: `export OPENAI_API_KEY=…` before `serve` — agents read them via `os.environ`.

**Browser mirror (`window.rapp`).** The live tab exposes the **same shape** on the JS console — no server, no port. Open DevTools and call:

```js
rapp.health()                                  // = GET /health
rapp.agents('fraud')                           // = GET /agents
await rapp.run('@aibast-agents-library/account_intelligence', 'Acme Corp')   // = POST /run
await rapp.eval('import sys; print(sys.version)')                            // = POST /eval
// plus: rapp.summon(slug), rapp.secrets.list()/.unlock(pass)/.set(k,v), rapp.help()
```

So `vbrainstem_sdk.py` (headless CPython) and the browser tab (Pyodide) are **one API contract** — identical request/response shapes, two runtimes.

## Deep links and share links

```
https://kody-w.github.io/vbrainstem/?agent=@kody/registry_client_agent
```

Opens the brainstem with that agent summoned from the live
[RAR](https://github.com/kody-w/RAR) registry
(`https://raw.githubusercontent.com/kody-w/RAR/main/registry.json` — RAR stays
the single source of truth; the registry panel reads it live).

`share.html` renders an agent shared as a link — the full source rides inside
the URL after `#a=…`, nothing server-side. Drag it into a vBrainstem to
install, scan the QR, or open it directly. `#prompt=` prefills also work; every
previously shared URL keeps working.

## Classic pages

`virtual-brainstem.html` and `virtual-brainstem-summon.html` are the previous
generation (LisPy VM + transpiler engine) and remain available unchanged.
`kited-demo.html` and `brainstem_bridge.html` are likewise still served.

## Neighborhood, kited twins & the sealed channel

> **Canonical spec:** [kody-w/rapp-neighborhood-protocol](https://github.com/kody-w/rapp-neighborhood-protocol) (`rapp-neighborhood-protocol/1.0`) — owns the vocabulary
> (**vTwin · Kited · Tethered · the String · Kited Neighborhood · Neighbor · Scan-to-Join · Sealed · Doorman**) and the **kite mark**.
> Companions: [rapp-sealed](https://github.com/kody-w/rapp-sealed) (the `rapp-sealed/1.0` codec) · [kite-mark](https://github.com/kody-w/kite-mark) (the mark).
> This repo is the **reference implementation**; the inlined codec + mark are CI-checked against canonical (`neighborhood-canon`).
> Tools have their own repos too (working copies here are CI-synced via `canon-tools`): [rapp-doorman](https://github.com/kody-w/rapp-doorman) · [rapp-brainstem-sdk](https://github.com/kody-w/rapp-brainstem-sdk) · [rapp-kite](https://github.com/kody-w/rapp-kite). Full ecosystem map → [rapp-map](https://github.com/kody-w/rapp-map).

Two brainstems — a local `brainstem.py`, a vBrainstem tab, a person, or Claude — meet as
**uniform peers** speaking `rapp-twin-chat/1.0`; nobody can tell what's on the other end. A
*tether* is the live link between them. There are two §5a transports:

- **WebRTC tether** (`5a-tether`) — direct P2P between two browser peers. The PeerJS public
  broker is used for the handshake only (SDP/ICE); data flows DTLS-encrypted P2P and the
  broker never sees it. `index.html` exposes `rapp.neighborhood.host()/join()/ask()/operate()`.
- **Kite tether** (`5a-kite`) — an operator (Claude) holds the **string**: drives a browser
  tab's console over the Chrome DevTools Protocol and relays. No broker, no STUN, no CORS —
  the string-holder *is* the transport. For "thing-in-the-middle", or when P2P can't form.

A **kited twin** is a tab flown on a kite string. It is **tethered** when the string also
reaches the locally-running brainstem (`5a-kite+tether`) — its turns are answered by that
local brainstem; with no local brainstem it is **just kited** (answered by the tab's own
in-page brainstem). CDP is unauthenticated, so the kite/CDP hop must stay **on-device** —
across machines, ride the WebRTC tether instead.

### Sealed channel — end-to-end, as secure as on-device

Any envelope can be **sealed**: `rapp-sealed/1.0` = AES-256-GCM, key derived (PBKDF2-SHA256,
210k) from a secret that travels **only in the pairing link you copy out-of-band** — never to
the broker. The wire / broker / TURN see opaque ciphertext, can't forge or modify it (GCM auth
tag), and only the two secret-holders can read or speak. Layered over WebRTC's DTLS, the whole
network is **fully untrusted and still safe**. Secrets *at rest* use the same primitive (the
vault). A wrong-key peer can't even read the rejection. The same scheme/salt runs in the
browser, the bridge, the CLI, and Node — so every hop is one contract.

### Session / handshake

You open the tab → it `host()`s → mints a **peer-id + token** (the token doubles as the channel
secret). Share the **operator link** with yourself out-of-band (another browser, same account).
Closing the tab destroys the peer + secret → the session ends, exactly like stopping
`brainstem.py`. Plaintext chat (`say`) is open; **operating** the console (`run`/`eval`/`chat`/…)
goes over the sealed channel, where key-possession *is* the authorization.

### Tools

| Tool | Role |
|------|------|
| `index.html` → `window.rapp.neighborhood` | host / join / `ask(peer,text,secret)` / `operate(peer,method,args,secret)`; `_seal`/`_open` exposed |
| `brainstem_bridge.html` | front a local brainstem into the neighborhood (sealed) so a remote browser can drive **this** machine's brainstem |
| `vbridge.sh <peer> <token> <ask\|eval\|run\|chat\|agents\|health> …` | CLI peer — operate a hosted tab from a shell, sealed |
| `kited_twin.js --port <cdp> [--brainstem <url>] [--once]` | the kite string — fly a tab via CDP; `--brainstem` makes it **tethered** |
| `doorman.skill.md` | feed its **raw URL** to a fresh Claude on another machine → it sets up and guards a sealed door to *that* machine's brainstem (Claude as the "doorman") |
| `doorman_selftest.sh` | one command that **proves** a machine can be a sealed doorman (hosts the bridge, drives it from a separate sealed peer, asserts the real brainstem answered) |

### Canon-tools mirror (byte-identity, CI-enforced)

These working copies must stay byte-identical to their canonical repos — the
`canon-tools` workflow fails CI on any drift. Sync them from upstream; never
edit them here:

| Working copy | Canonical source |
|--------------|------------------|
| `doorman.skill.md` | `kody-w/rapp-doorman` |
| `doorman_selftest.sh` | `kody-w/rapp-doorman` |
| `vbrainstem_sdk.py` | `kody-w/rapp-brainstem-sdk` |
| `vbridge.sh` | `kody-w/rapp-kite` |
| `kited_twin.js` | `kody-w/rapp-kite` |
| `kite_vtwin.js` | `kody-w/rapp-kite` |
| `claude_bridge.js` | `kody-w/rapp-kite` |

## License

MIT © Kody Wildfeuer. Brainstem engine ported from [rapp_brainstem](https://github.com/kody-w/rapp-installer); agent registry from [kody-w/RAR](https://github.com/kody-w/RAR).
