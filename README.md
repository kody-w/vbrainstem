# vBrainstem

Browser-native runtime for [RAPP](https://github.com/kody-w/RAR) agents. Open the
page and run any single-file RAPP agent **in your browser** — real CPython via
[Pyodide](https://pyodide.org), no install, no server.

**Live:** https://kody-w.github.io/vbrainstem/

**Doorman guide:** https://kody-w.github.io/vbrainstem/guide.html — set up Claude as the sealed
**doorman** to any machine's brainstem (WebRTC + kite tethers, kited twins, end-to-end AES-256-GCM).

This is a standalone host for the RAPP Brainstem, kept **outside** the
[RAR](https://github.com/kody-w/RAR) registry repo so it can be linked and embedded
independently (e.g. from Grail trading-card QR codes). The agent **registry stays in
RAR** — this app reads it live, so RAR remains the single source of truth.

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

## UI

`index.html` opens as a landing page styled to mirror
[kody-w/rapp-installer](https://kody-w.github.io/rapp-installer/): a 🧠 hero, a
terminal widget that shows the **real** in-browser boot (LisPy VM → registry →
Pyodide), three explainer cards, and a **Launch** button that drops into the chat
runtime. Arriving with an `?agent=` deep-link skips the landing and opens chat
directly.

## Files

| File | Role |
|------|------|
| `index.html` | The app — landing → Launch → chat. Accepts `?agent=@publisher/slug` deep-links (QR / Grail), which bypass the landing. |
| `virtual-brainstem-summon.html` | Identical to `index.html` (canonical named path). |
| `virtual-brainstem.html` | **Classic UI** — same engine, straight to chat, no landing. Linked from the landing footer. |

## Deep links

```
https://kody-w.github.io/vbrainstem/?agent=@kody/registry_client_agent
```

Opens the brainstem with that agent summoned and ready to run (landing skipped).

## Where the agents come from

The app fetches the live registry and agent source straight from RAR:

- Registry — `https://raw.githubusercontent.com/kody-w/RAR/main/registry.json`
- Agent source — `https://raw.githubusercontent.com/kody-w/RAR/main/agents/…`

## Engine vs. UI (syncing)

The **engine** (the big `<script>`: LisPy interpreter, Python→JS transpiler, VFS,
Pyodide execution, chat, GitHub auth, summon) is mirrored from RAR's
`virtual-brainstem*.html`. The **landing UI** (`#landingView` markup + the `lp-*`
CSS + the boot wiring in `init()`) and the absolute "Back to RAPP" link are
**specific to this repo** and do **not** exist in RAR.

> ⚠️ Do **not** blindly re-copy `index.html` from RAR — that would wipe the landing.
> When the engine changes in RAR, port the `<script>` changes in by hand and keep the
> landing markup + `lp-*` styles. (`virtual-brainstem.html` is the closest to RAR's.)

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

## License

MIT © Kody Wildfeuer. Engine mirrored from [kody-w/RAR](https://github.com/kody-w/RAR).
