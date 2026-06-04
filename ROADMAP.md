# vBrainstem roadmap

## Browser use (tiered) — "browser use from the webpage itself"

Give the vBrainstem real **browser-use** for agents that need to read live, JS-rendered
pages — without a native Chromium (the vBrainstem runs in a browser tab via Pyodide, so
it can't launch Playwright).

**Key idea:** the vBrainstem is *already inside a real browser*, so don't *simulate* a JS
engine (QuickJS-wasm has no DOM and can't touch Web APIs). Use the **host browser's own
engine**. Ship as a drop-in `browser_use_agent.py` with the **same metadata/interface** as
the native Playwright `headless_browser_agent.py`, auto-detecting its host backend (mirrors
the existing `utils.azure_file_storage` local-vs-Azure shim pattern).

**Tiers (try in order):**
1. **Static fetch + `DOMParser`** — `js.fetch` through a CORS proxy, parse the HTML for
   text/links. In-page, free, no JS execution. Good for SSR/content pages.
2. **Host-browser render via a sandboxed iframe** — inject the fetched HTML into a hidden
   `<iframe sandbox="allow-scripts allow-same-origin" srcdoc=…>`; the real engine runs the
   page's JS; read back the rendered DOM. Handles most JS-rendered pages. No QuickJS/DOM shim.
3. **Remote render endpoint** — for heavy SPAs (whose own `fetch`/XHR re-hit CORS): call out
   to Cloudflare Browser Rendering, a self-hosted Playwright endpoint (the native
   `headless_browser_agent.py` exposed over HTTP), or browserless. Thin client, full fidelity.

**Native counterpart (already built):** `headless_browser_agent.py` (Playwright + headless
Chromium, subprocess-isolated, modes text/html/links/screenshot) ships in
[`rapp-brainstem-beta`](https://github.com/kody-w/rapp-brainstem-beta). The vBrainstem agent
should keep the same shape so the brainstem has consistent browser-use across native and
in-browser runtimes.

**Constraints / open questions:**
- CORS is the core limit in-browser — Tiers 1–2 need a proxy; Tier 3 sidesteps it.
- Tier-3 backend choice: Cloudflare Browser Rendering (no infra) vs self-hosted Playwright
  (no third party).
- CheerpX/WebVM (full Linux + browser in WASM, client-side) is a maximal-fidelity option but
  heavy (hundreds of MB, needs cross-origin isolation) — out of scope for v1.

_Status: proposed (not started)._
