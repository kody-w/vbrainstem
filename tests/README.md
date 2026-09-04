# Tests

- `smoke.spec.js`: the page, end to end, with the network mocked and real Pyodide. `cd tests && npm ci && npx playwright test`.
- `test_shim_parity.py`: the page's runner shim equals `tools/shim_source.py` (refresh with `python3 tools/sync_shim.py`).
- `live-probe.js`, `dial-live.js`: manual probes against the published page with a real sign-in on this machine; not run in CI.
