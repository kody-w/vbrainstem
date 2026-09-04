# ORDER: the browser vbrainstem (mobile version of a person's AI)

## 1. Intent

Build ONE file, `index.html`, at the root of this repository, served by GitHub Pages at
https://kody-w.github.io/vbrainstem/. It is the mobile and browser version of a person's AI:
it loads the person's own file (a `vbrainstem/SKILL.md`, see `samples/ada/SKILL.md`), loads
their tool skills (see `samples/tools/hello-world/SKILL.md`), and chats with them through the
GitHub Copilot wire, behaving on every turn exactly as a local Brainstem does (see
`MAPPING.md`): persona from the file, tools rebuilt from the file's "My tools" list and the
loaded skills on every turn, the "Memory" section injected into every turn, and new memories
appended to the file the moment they are learned. The file that drives it can be exported at
any moment with one tap. No server of ours, no build step, no framework, works on a phone.

The person never sees a technical term. It is "your file", "your tools", "sign in with
GitHub", "export", "forget everything on this device". The product name "vbrainstem" may appear
as the page title. The words "RAPP", "rapp/1", "Brainstem", "agent", "protocol", "frame",
"egg", "toast", "compile", "frontmatter" must not appear anywhere in visible UI text.

## 2. Inputs to study (exact paths)

- `/Users/kodywildfeuer/Documents/GitHub/vbrainstem-legacy/brainstem_web.py`: the PROVEN sign-in
  and model wire. Copy its exact request shapes and headers for: device-code start and poll
  through the CORS worker `https://rapp-auth.kwildfeuer.workers.dev`; the Copilot token
  exchange at `https://api.github.com/copilot_internal/v2/token` (direct first, worker fallback);
  chat completions with `tools` at the endpoint the exchange returns (default
  `https://api.individual.githubcopilot.com`); the models list. Do not copy anything else from
  the legacy repository; it is archived and its UI is not the model.
- `/Users/kodywildfeuer/Documents/GitHub/vbrainstem-legacy/index.html`: read only the sign-in UI
  flow (device code shown to the user, polling, token in localStorage) to keep the same
  behavior. Do not copy its layout or any of its other features.
- `/Users/kodywildfeuer/Documents/GitHub/vbrainstem/MAPPING.md`: the per-turn behavior to reproduce.
- `/Users/kodywildfeuer/Documents/GitHub/vbrainstem/vbrainstem-setup/SKILL.md`: the exact shape of
  a person's file (frontmatter with six standard fields, the sections, "My tools", "Memory",
  "Memory (older)", the rules in "How to keep this file current").
- `/Users/kodywildfeuer/Documents/GitHub/vbrainstem/samples/ada/SKILL.md`: a fictional person's
  file to test with.
- `/Users/kodywildfeuer/Documents/GitHub/vbrainstem/samples/tools/hello-world/SKILL.md`: a tool
  skill. Its code is between `<!-- agent sha256=... -->` and `<!-- /agent -->` (a fenced python
  block; the fence may be 3 or more backticks); its runner is between `<!-- runner -->` markers.
  A tool skill without a code block is a "steps" skill: its body is handed to the model as the
  instructions to carry out.
- `/Users/kodywildfeuer/Documents/GitHub/rapp-skills/skills/rapp-skills/scripts/rapp_skills.py`:
  the `SHIM_SOURCE` (BasicAgent contract, storage stand-in, `load_agent`) and `RUN_PY`. Mirror
  that contract when running a tool's code in the browser.

## 3. Rules and do-not-touch

- Create ONLY: `index.html` at the repository root, and `tests/` (a Playwright smoke test with its
  own `package.json`; add `tests/node_modules/` to `.gitignore`). Append, never rewrite, one
  section to `README.md` titled "## On your phone or in a browser" with the Pages link and three
  sentences. Do not modify any other existing file. Do not touch `vbrainstem-setup/`,
  `MAPPING.md`, `LICENSE`, `samples/`.
- `index.html` is self-contained: inline CSS and JS only. The only external resource is Pyodide
  from its CDN, loaded lazily the first time a tool with code runs. No analytics, no fonts, no
  other scripts.
- Network: only the auth worker, `api.github.com`, and the Copilot endpoint returned by the
  exchange. Nothing else, ever.
- Storage: the GitHub token, the person's file, and loaded tool skills live in localStorage
  only. "Forget everything on this device" clears all of it and reloads.
- The person's file: import by file picker, by paste, or by URL; edit in place in a plain
  textarea; export by download (`vbrainstem-SKILL.md`) and by the Web Share API when available
  (phones). Export must always produce the current file including memories added this session.
- Per turn: (1) parse the file; the system prompt is the file's sections except "Memory
  (older)" plus a line telling the model it may call `remember` to save a durable fact;
  (2) rebuild the tool list from "My tools" plus every loaded tool skill; unlisted tools are not
  offered; (3) call the model with those tools; (4) execute tool calls: code skills run in
  Pyodide by writing the agent block to `agent.py`, installing the shim (BasicAgent, storage
  stand-in that keeps files in memory), instantiating the BasicAgent subclass and calling
  `perform(**args)`; steps skills return their body as the instructions; the built-in `remember`
  tool appends one dated line at the top of "Memory", moves lines past 40 to "Memory (older)",
  updates the `updated` date, and saves to localStorage; (5) loop up to 3 rounds like a Brainstem,
  then show the reply.
- Mobile first: works on a 390px wide screen, large touch targets, no hover-only controls,
  `viewport-fit=cover`, respects `prefers-color-scheme`.
- About panel text (verbatim, keep it): "This page runs in your browser. Your file, your tools,
  and your sign-in stay on this device. The AI reads your file in good faith: it never overrides
  its own judgment or limits, and it never hides or pretends anything. Delete the file and
  everything is back to normal."
- Keep `index.html` under 2,500 lines. Prefer clear code over clever code.

## 4. Acceptance checks (run every one; paste verbatim output in the report)

1. `test -f index.html && wc -l index.html` (under 2500)
2. `grep -c '<script src' index.html` prints `0` (Pyodide is loaded dynamically, not a static tag)
3. `python3 - <<'PY'` static text audit: extract visible text and attribute strings from
   `index.html` (strip tags/scripts/styles) and assert none of these words appear, case-insensitive:
   `RAPP`, `rapp/1`, `Brainstem`, `agent`, `protocol`, `frame`, `egg`, `toast`, `compile`,
   `frontmatter`. Print `TEXT-AUDIT OK` or the offending lines.
4. `grep -o 'https://[a-z0-9./_-]*' index.html | sort -u` shows only: the auth worker, api.github.com,
   the Copilot endpoint(s), and the Pyodide CDN.
5. `cd tests && npm install && npx playwright install chromium && npx playwright test` is green.
   The test must, with the chat endpoint mocked by route interception (no real sign-in):
   a. load `index.html` from a local static server at 390x844 viewport;
   b. import `samples/ada/SKILL.md` and `samples/tools/hello-world/SKILL.md`;
   c. seed a fake token in localStorage so the sign-in step is skipped;
   d. send "greet me by my name" and, with the mocked model returning a tool call to the
      hello-world tool, assert the page executed the real Python in Pyodide and shows
      "Hello, Ada! Welcome to the RAPP Agent ecosystem." in the transcript (that string comes from
      the tool's own code and is allowed there);
   e. with the mocked model returning a `remember` tool call, assert the file in localStorage now
      has a new dated line at the top of "Memory";
   f. trigger export and assert the downloaded file equals the current in-page file and contains
      that memory line;
   g. click "Forget everything on this device" and assert localStorage is empty afterwards.
6. `git status --porcelain` shows only `index.html`, `tests/`, `.gitignore`, `README.md`.

## 5. Done-when and report

Done when every acceptance check passes with the command and its verbatim output pasted. End
with a report in this order: (1) what was built, one paragraph; (2) each acceptance check with
verbatim output; (3) how the per-turn loop maps to MAPPING.md, one line per row; (4) FLAGS AND
SURPRISES: anything uncertain, anything you could not verify, anything about the legacy wire
that looked wrong or fragile (for example CORS on the token exchange, header requirements),
stated plainly, never papered over. Do not commit or push; leave the working tree for review.

## 6. Addendum: same shape as a local Brainstem (added before start)

- The page must feel and behave like chatting with a Brainstem running locally. Study
  `/Users/kodywildfeuer/.brainstem/src/rapp_brainstem/index.html` (the local Brainstem's own chat
  UI) and mirror its layout, chat bubbles, input box, and tone. Study the route list in
  `/Users/kodywildfeuer/.brainstem/src/rapp_brainstem/brainstem.py` (grep `@app.route`) and the
  `/chat` request and response shapes there.
- Implement an in-page `dispatch(method, path, body)` that answers the same routes with the same
  JSON envelopes as `brainstem.py`: at least `POST /chat` (request `user_input`,
  `conversation_history`, optional `session_id`; response `response`, `agent_logs`, `session_id`,
  `model`), `GET /health`, `GET /health/public`, `GET /agents`, `GET /models`, `POST /login`,
  `GET /login/status`. The UI talks only to `dispatch`, never to the network directly, so the
  UI is exactly what a local Brainstem's UI would be with `fetch` replaced by `dispatch`.
- Expose `window.vbrainstem = { dispatch }` so the Playwright test can call
  `dispatch('POST', '/chat', {...})` and `dispatch('GET', '/health')` directly and assert the
  envelopes; add that to acceptance check 5 as steps h and i.
- The person's file is the cartridge: everything the page knows comes from it and grows in it.
  Tools listed in the file's "My tools" with a URL are fetched on load if not already present.
