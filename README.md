# vBrainstem

Browser-native runtime for [RAPP](https://github.com/kody-w/RAR) agents. Open the
page and run any single-file RAPP agent **in your browser** — real CPython via
[Pyodide](https://pyodide.org), no install, no server.

**Live:** https://kody-w.github.io/vbrainstem/

This is a standalone host for the RAPP Brainstem, kept **outside** the
[RAR](https://github.com/kody-w/RAR) registry repo so it can be linked and embedded
independently (e.g. from Grail trading-card QR codes). The agent **registry stays in
RAR** — this app reads it live, so RAR remains the single source of truth.

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

## License

MIT © Kody Wildfeuer. Engine mirrored from [kody-w/RAR](https://github.com/kody-w/RAR).
