# vBrainstem

Browser-native runtime for [RAPP](https://github.com/kody-w/RAR) agents. Open the
page and run any single-file RAPP agent **in your browser** — real CPython via
[Pyodide](https://pyodide.org), no install, no server.

**Live:** https://kody-w.github.io/vbrainstem/

This is a standalone host for the RAPP Brainstem, kept **outside** the
[RAR](https://github.com/kody-w/RAR) registry repo so it can be linked and embedded
independently (e.g. from Grail trading-card QR codes). The agent **registry stays in
RAR** — this app reads it live, so RAR remains the single source of truth.

## Files

| File | Role |
|------|------|
| `index.html` | The app (summon variant). Accepts `?agent=@publisher/slug` deep-links — scan a Grail card QR and the agent auto-loads into the dropdown. |
| `virtual-brainstem-summon.html` | Identical to `index.html` (canonical named path, kept for backward-compatible links). |
| `virtual-brainstem.html` | Plain runtime — same engine, no deep-link handling. |

## Deep links

```
https://kody-w.github.io/vbrainstem/?agent=@kody/registry_client_agent
```

Opens the brainstem with that agent summoned and ready to run.

## Where the agents come from

The app fetches the live registry and agent source straight from RAR:

- Registry — `https://raw.githubusercontent.com/kody-w/RAR/main/registry.json`
- Agent source — `https://raw.githubusercontent.com/kody-w/RAR/main/agents/…`

## Syncing

These files are mirrored from RAR's `virtual-brainstem*.html`. When the brainstem
changes in RAR, recopy the two HTML files here (the only local edit is the
"Back to RAPP" link, which points at `https://kody-w.github.io/RAR/`).

## License

MIT © Kody Wildfeuer. Mirrored from [kody-w/RAR](https://github.com/kody-w/RAR).
