/*
 * surgeon.js — the Brain Surgeon: a REAL GitHub Copilot agent loop in the
 * vBrainstem, side-by-side with the brainstem chat.
 *
 * Not a shell wrapper, not a proxy to /chat — this is the same agentic loop
 * VS Code's Copilot Agent mode runs: the signed-in Copilot model is given
 * tools and iterates (think → act → observe → repeat). The difference is the
 * boundary: everything runs inside the vBrainstem's FULL Pyodide/CPython VM.
 * Within that sandbox the agent has VS-Code-shaped powers —
 *
 *   - run_python : execute arbitrary Python in the live CPython runtime
 *                  (the sandbox's shell/REPL; state persists across calls)
 *   - read_file / write_file / list_dir / delete_file : the whole workspace
 *   - test_brainstem : run a turn through the brainstem to verify agents fire
 *
 * — but it cannot reach the host machine's disk, shell, or anything the
 * browser sandbox doesn't allow. That IS the feature: the Copilot agent loop
 * without VS Code and without trusting it with your real machine.
 *
 * Wiring:
 *   completions : __vbrainstem.local('POST','/surgeon/complete',{messages,tools})
 *                 → brainstem_web.call_copilot() (real Copilot token + model)
 *   python      : window.rapp.eval(code)         (rapp_eval, full CPython VM)
 *   filesystem  : __vbrainstem.fs('list'|'read'|'write'|'delete', path, content)
 *   hot-test    : __vbrainstem.local('POST','/chat', {...})  (LOCAL vB, never
 *                 the desk tether — the Surgeon builds HERE)
 *
 * Loaded by index.html after vbrainstem-boot.js.
 */
(function () {
  'use strict';

  var MAX_ROUNDS = 24;
  var VB = function () { return window.__vbrainstem; };

  // GitHub Copilot mark (official monotone glyph) — this surface IS Copilot;
  // "Brain Surgeon" is only the brainstem wordplay, never the primary label.
  var COPILOT_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true" style="vertical-align:-2px">' +
    '<path d="M12 2c-2.3 0-3.6.9-4.3 2.1-.5-.1-1-.1-1.5-.1C3.4 4 2 5.6 2 8.2v.3C1 9 .5 9.9.5 11.2v2.1c0 2 1 3.4 2.8 4.2C5.1 18.9 8.2 20 12 20s6.9-1.1 8.7-2.5c1.8-.8 2.8-2.2 2.8-4.2v-2.1c0-1.3-.5-2.2-1.5-2.7v-.3C22 5.6 20.6 4 17.8 4c-.5 0-1 0-1.5.1C15.6 2.9 14.3 2 12 2Zm-1 6.9c1.6-.4 1.6-.4 2 0v4.8c-.6.5-1.4.8-2.3.8-1.9 0-3.2-1.2-3.2-3 0-.3 0-.6.1-.9.9.2 2.1.4 3.4-1.7Zm2 0c1.3 2.1 2.5 1.9 3.4 1.7.1.3.1.6.1.9 0 1.8-1.3 3-3.2 3-.9 0-1.7-.3-2.3-.8V8.9ZM9 12.5c-.4 0-.7.4-.7 1s.3 1 .7 1 .7-.4.7-1-.3-1-.7-1Zm6 0c-.4 0-.7.4-.7 1s.3 1 .7 1 .7-.4.7-1-.3-1-.7-1Z"/></svg>';

  var SYSTEM_PROMPT = [
    "You are the Brain Surgeon — an autonomous coding agent that works inside a",
    "running RAPP brainstem, in the user's place. You have a FULL Python (CPython via",
    "Pyodide) runtime and the brainstem's workspace. Think like a senior engineer:",
    "explore before you change, keep edits minimal, and PROVE your work by running it.",
    "",
    "Your powers (a real agent loop, sandboxed to this in-browser VM — you cannot",
    "touch the host machine's disk or shell, only this workspace and runtime):",
    "- run_python: execute arbitrary Python in the live runtime. This is your shell and",
    "  REPL — inspect state, compute, import stdlib, make network calls with `requests`,",
    "  os.listdir, etc. Print what you want to see; state persists between calls.",
    "- read_file / write_file / list_dir / delete_file: the whole workspace filesystem.",
    "- list_agents: the installed agents with their loaded class names.",
    "- test_brainstem: send a natural-language message to the brainstem and read the",
    "  reply + agent_logs — your end-to-end verification that an agent actually fires.",
    "",
    "RAPP agents: one Python file in agents/ named <snake>_agent.py, a class extending",
    "BasicAgent with a `metadata` dict (OpenAI function schema: name, description,",
    "parameters) and `perform(self, **kwargs) -> str`. They hot-load on the next request.",
    "Canonical shape:",
    "```python",
    "from agents.basic_agent import BasicAgent",
    "",
    "class ReverseStringAgent(BasicAgent):",
    "    def __init__(self):",
    "        self.name = 'ReverseString'",
    "        self.metadata = {",
    "            'name': self.name,",
    "            'description': 'Reverses the characters in a string.',",
    "            'parameters': {'type': 'object',",
    "                'properties': {'text': {'type': 'string', 'description': 'Text to reverse.'}},",
    "                'required': ['text']}",
    "        }",
    "        super().__init__(name=self.name, metadata=self.metadata)",
    "",
    "    def perform(self, **kwargs):",
    "        return kwargs.get('text', '')[::-1]",
    "```",
    "",
    "Workflow: explore (list_agents / list_dir / read_file / run_python) → write the",
    "file → ALWAYS test_brainstem with a message that should trigger it, and confirm from",
    "agent_logs that it ran and returned the right thing → fix and re-test if not. When it",
    "works, stop and give a one-paragraph summary with the proof (the tested message and",
    "result). Prefer the stdlib; avoid heavy third-party packages. Keep prose short",
    "between tool calls."
  ].join("\n");

  var TOOLS = [
    { type: "function", function: {
      name: "run_python",
      description: "Execute Python in the live CPython (Pyodide) runtime — your shell/REPL. Returns captured stdout/stderr and the repr of the last expression. State persists across calls (same process as the brainstem). Use `requests` for network.",
      parameters: { type: "object", properties: {
        code: { type: "string", description: "Python source to run." }
      }, required: ["code"] }
    }},
    { type: "function", function: {
      name: "list_dir",
      description: "List workspace files, optionally under a path prefix (e.g. 'agents').",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "Optional path prefix, e.g. 'agents'. Empty = whole workspace." }
      }, required: [] }
    }},
    { type: "function", function: {
      name: "read_file",
      description: "Read a workspace file (e.g. 'agents/foo_agent.py', 'soul.md').",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "Workspace-relative path." }
      }, required: ["path"] }
    }},
    { type: "function", function: {
      name: "write_file",
      description: "Create or overwrite a workspace file. RAPP agents go in agents/ as <snake>_agent.py and hot-load on the next request.",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "Workspace-relative path, e.g. agents/reverse_string_agent.py" },
        content: { type: "string", description: "Full file contents." }
      }, required: ["path", "content"] }
    }},
    { type: "function", function: {
      name: "delete_file",
      description: "Delete a workspace file.",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "Workspace-relative path." }
      }, required: ["path"] }
    }},
    { type: "function", function: {
      name: "list_agents",
      description: "List installed agents with their loaded class names.",
      parameters: { type: "object", properties: {}, required: [] }
    }},
    { type: "function", function: {
      name: "test_brainstem",
      description: "Send a natural-language message to THIS brainstem and return its reply plus agent_logs — verify a new agent actually fires and is correct.",
      parameters: { type: "object", properties: {
        message: { type: "string", description: "What a user would type to trigger the agent, e.g. 'reverse the word hello'." }
      }, required: ["message"] }
    }}
  ];

  // Only offered in Burrow mode (real desk machine reachable over the tether).
  var RUN_SHELL_TOOL = { type: "function", function: {
    name: "run_shell",
    description: "Run a shell command on the user's REAL computer (Burrow mode). Returns combined stdout/stderr and the exit code.",
    parameters: { type: "object", properties: {
      command: { type: "string", description: "The shell command to run." }
    }, required: ["command"] }
  }};

  // Burrow-only: the device is a TWIN with its own agents/ folder (same shape as
  // this brainstem). Copilot lists/installs/runs agents on it just like locally —
  // for on-device-only agents (subprocess to pac/az/gh CLIs, local files, native
  // libs) that can't run in the sandbox.
  var BURROW_TWIN_TOOLS = [
    { type: "function", function: {
      name: "burrow_list_agents",
      description: "List the agents installed on the burrowed device twin (same shape as list_agents here). Use it to see what the real machine can already run.",
      parameters: { type: "object", properties: {}, required: [] }
    }},
    { type: "function", function: {
      name: "burrow_install_agent",
      description: "Install a RAPP agent .py onto the burrowed device twin's agents/ folder so it can run on the real machine. Get the source with read_file (a workspace agent) or run_python (fetch from the RAR registry) first.",
      parameters: { type: "object", properties: {
        filename: { type: "string", description: "e.g. power_apps_code_app_agent.py (must end with _agent.py)." },
        source: { type: "string", description: "The complete Python source of the agent file." }
      }, required: ["filename", "source"] }
    }},
    { type: "function", function: {
      name: "burrow_run_agent",
      description: "Run an agent on the burrowed device twin — by `name` (an installed agent's filename) or ad-hoc `source` — with kwargs. Use for agents that need the native OS. Returns the agent's string result plus logs.",
      parameters: { type: "object", properties: {
        name: { type: "string", description: "Filename of an installed twin agent, e.g. power_apps_code_app_agent.py." },
        source: { type: "string", description: "Ad-hoc agent source to run (instead of name)." },
        kwargs: { type: "object", description: "Arguments to pass to the agent's perform(**kwargs). Defaults to {}." }
      }, required: [] }
    }}
  ];

  function bridge() { return window.__BURROW_BRIDGE__; }
  function canBurrow() { var b = bridge(); return !!(b && b.canBurrow && b.canBurrow()); }
  var burrow = false;

  function toolsFor() { return burrow ? TOOLS.concat([RUN_SHELL_TOOL]).concat(BURROW_TWIN_TOOLS) : TOOLS; }
  function systemFor() {
    if (!burrow) return SYSTEM_PROMPT;
    var os = (bridge().hostOs && bridge().hostOs()) || "";
    return SYSTEM_PROMPT + "\n\n=== BURROW MODE IS ON ===\nrun_python, run_shell, read_file, write_file, list_dir and " +
      "delete_file now execute on the user's REAL computer (" + (bridge().hostName ? bridge().hostName() : "the desk") +
      (os ? ", running " + os : "") + ") over a sealed channel — real shell, real disk, real network, the same power the brainstem has running locally. " +
      (os === "Windows"
        ? "This machine is WINDOWS: run_shell uses cmd.exe — use Windows commands (dir, type, echo, PowerShell via 'powershell -c \"...\"'), not Unix (ls/cat). Paths use backslashes. "
        : (os ? "This machine is " + os + ": run_shell uses a POSIX shell (ls, cat, grep, etc.). " : "")) +
      "The burrowed device is a TWIN with its OWN agents/ folder, same shape as this brainstem. To run an on-device-only agent (needs subprocess/pac/az/gh, local files): (1) check list_agents here, (2) check burrow_list_agents on the device twin, (3) if the agent is not on the twin, get its source (read_file here, or run_python to fetch from RAR) and burrow_install_agent it, (4) burrow_run_agent by name on the twin. Prefer running native-OS agents on the twin. " +
      "This is powerful and can be irreversible. Prefer read-only exploration first; state your plan in prose before any " +
      "destructive or system-changing command; never run something the user didn't ask for.";
  }

  function cleanPath(p) { return String(p || "").replace(/\\/g, "/").replace(/^\/+/, ""); }

  async function hostExec(req) {
    var res = await bridge().hostOp(req);
    if (res && res.error) throw new Error(res.error);
    return res || {};
  }

  async function execTool(name, args, sid) {
    var vb = VB();
    var testSid = sid || "surgeon-test";
    // BURROW: capability tools execute on the REAL desk machine.
    if (burrow && canBurrow()) {
      if (name === "run_python") return await hostExec({ op: "python", code: String(args.code || "") });
      if (name === "run_shell") return await hostExec({ op: "shell", command: String(args.command || "") });
      if (name === "burrow_list_agents") return await hostExec({ op: "list_agents" });
      if (name === "burrow_install_agent") return await hostExec({ op: "install_agent", filename: String(args.filename || ""), source: String(args.source || "") });
      if (name === "burrow_run_agent") return await hostExec({ op: "agent", name: String(args.name || ""), source: String(args.source || ""), kwargs: args.kwargs || {} });
      if (name === "read_file") { var rr = await hostExec({ op: "read", path: cleanPath(args.path) }); return { path: cleanPath(args.path), content: rr.content }; }
      if (name === "write_file") { await hostExec({ op: "write", path: cleanPath(args.path), content: String(args.content || "") }); return { ok: true, path: cleanPath(args.path), bytes: (args.content || "").length }; }
      if (name === "list_dir") return await hostExec({ op: "list", path: cleanPath(args.path) || "." });
      if (name === "delete_file") return await hostExec({ op: "shell", command: "rm -f " + JSON.stringify(cleanPath(args.path)) });
      if (name === "test_brainstem") {
        // Test against the DESK brainstem (window.fetch is tether-routed).
        var dr = await window.fetch("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_input: String(args.message || ""), conversation_history: [], session_id: testSid }) });
        var dj = await dr.json();
        return { response: dj.response, agent_logs: dj.agent_logs || "", error: dj.error };
      }
      // list_agents falls through to the local list below.
    }
    if (/^(run_shell|burrow_)/.test(name)) throw new Error(name + " needs Burrow enabled — pair to a device with host control.");
    if (name === "run_python") {
      var out = await window.rapp.eval(String(args.code || ""));
      return { output: (out && out.output) != null ? out.output : "" };
    }
    if (name === "list_dir") {
      var all = await vb.fs("list");   // vb_fs list walks the whole workspace
      var prefix = cleanPath(args.path);
      var files = Array.isArray(all) ? all : [];
      if (prefix) files = files.filter(function (f) { return f === prefix || f.indexOf(prefix + "/") === 0; });
      return { files: files };
    }
    if (name === "read_file") {
      var res = await vb.fs("read", cleanPath(args.path));
      return { path: cleanPath(args.path), content: res.content };
    }
    if (name === "write_file") {
      var p = cleanPath(args.path);
      if (!p) throw new Error("path required");
      if (typeof args.content !== "string") throw new Error("content required");
      await vb.fs("write", p, args.content);
      return { ok: true, path: p, bytes: args.content.length };
    }
    if (name === "delete_file") {
      var dp = cleanPath(args.path);
      await vb.fs("delete", dp);
      return { ok: true, deleted: dp };
    }
    if (name === "list_agents") {
      var r = await vb.local("GET", "/agents");
      return { files: (r.json && r.json.files) || [] };
    }
    if (name === "test_brainstem") {
      var chat = await vb.local("POST", "/chat", {
        user_input: String(args.message || ""), conversation_history: [], session_id: testSid
      });
      var j = chat.json || {};
      return { response: j.response, agent_logs: j.agent_logs || "", error: j.error };
    }
    throw new Error("unknown tool: " + name);
  }

  // ── sessions: independent Copilot chats over the same brainstem ──
  // Each session is its own agent-loop conversation with its own transcript;
  // all operate on the SAME shared vBrainstem workspace. Sessions run
  // concurrently — start one building while another runs.
  var sessions = [];
  var activeId = 0;
  var sseq = 0;
  var herd = false;   // grid view: chat with several Copilots at once
  var els = {};

  function activeSession() {
    for (var i = 0; i < sessions.length; i++) if (sessions[i].id === activeId) return sessions[i];
    return null;
  }

  // Persist Copilot chats across a page refresh — a refresh clears the brainstem
  // chat but must NOT lose in-progress brain surgeries. We store each session's
  // full message history; a loop that was mid-flight can't literally survive a
  // reload, but its transcript + context are restored so you continue seamlessly.
  var SESSIONS_KEY = "surgeon_sessions_v1";
  function saveSessions() {
    try {
      var data = sessions.map(function (s) { return { id: s.id, title: s.title, model: s.model, convo: s.convo }; });
      localStorage.setItem(SESSIONS_KEY, JSON.stringify({ active: activeId, sessions: data }));
    } catch (e) {
      // Over quota — drop the oldest sessions' detail and retry once.
      try {
        var trimmed = sessions.slice(-4).map(function (s) { return { id: s.id, title: s.title, model: s.model, convo: (s.convo || []).slice(-24) }; });
        localStorage.setItem(SESSIONS_KEY, JSON.stringify({ active: activeId, sessions: trimmed }));
      } catch (e2) { }
    }
  }
  function loadSessions() {
    try { var d = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "null"); return (d && Array.isArray(d.sessions) && d.sessions.length) ? d : null; }
    catch (e) { return null; }
  }
  function restoreSession(data) {
    var s = { id: data.id, defaultTitle: "New chat", title: data.title || "New chat", convo: data.convo || [], running: false, model: data.model || null, logEl: null, thinkEl: null, tileEl: null };
    var log = document.createElement("div"); log.className = "sess"; els.log.appendChild(log); s.logEl = log;
    sessions.push(s);
    if (sseq < s.id) sseq = s.id;
    replayConvo(s);
    return s;
  }
  function replayConvo(s) {
    s.logEl.innerHTML = "";
    var chips = {};
    (s.convo || []).forEach(function (m) {
      if (m.role === "user") addBubble(s, "user", m.content);
      else if (m.role === "assistant") {
        if (m.content) addBubble(s, "assistant", m.content);
        (m.tool_calls || []).forEach(function (tc) {
          var fn = tc.function && tc.function.name; var args = {};
          try { args = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (e) { }
          chips[tc.id] = addToolChip(s, fn, args);
        });
      } else if (m.role === "tool") {
        var chip = chips[m.tool_call_id];
        if (chip) { var res = {}; try { res = JSON.parse(m.content); } catch (e) { res = { output: m.content }; } chip.done(res); }
      }
    });
    if (!(s.convo && s.convo.length)) renderEmptyInto(s);
  }

  async function complete(messages) {
    var r = await VB().local("POST", "/surgeon/complete", { messages: messages, tools: toolsFor() });
    if (r.status === 401 || r.status === 403) throw new Error((r.json && r.json.error) || "not signed in");
    if (r.status >= 400) throw new Error((r.json && r.json.error) || ("surgeon " + r.status));
    return r.json;
  }

  async function runTask(session, task) {
    if (session.running) return;
    session.running = true;
    var emptyEl = session.logEl.querySelector(".empty");
    if (emptyEl) emptyEl.remove();
    if (session.title === session.defaultTitle) { session.title = task.slice(0, 40); }
    refresh(session);
    if (!session.convo.length) session.convo.push({ role: "system", content: systemFor() });
    else session.convo[0] = { role: "system", content: systemFor() };
    session.convo.push({ role: "user", content: task });
    addBubble(session, "user", task);
    var think = addThinking(session);

    try {
      for (var round = 0; round < MAX_ROUNDS; round++) {
        var out = await complete(session.convo);
        var msg = out.message || {};
        session.model = out.model;
        if (session.id === activeId) setModel(out.model);
        var assistant = { role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls || [] };
        if (!assistant.tool_calls.length) delete assistant.tool_calls;
        session.convo.push(assistant);

        if (msg.content) addBubble(session, "assistant", msg.content);
        if (!msg.tool_calls || !msg.tool_calls.length) {
          if (!msg.content) addBubble(session, "assistant", "(done)");
          break;
        }
        for (var i = 0; i < msg.tool_calls.length; i++) {
          var tc = msg.tool_calls[i];
          var fname = tc.function && tc.function.name;
          var args = {};
          try { args = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (e) { args = {}; }
          var chip = addToolChip(session, fname, args);
          var result;
          try { result = await execTool(fname, args, "surgeon-" + session.id); chip.done(result); }
          catch (e) { result = { error: (e && e.message) || String(e) }; chip.fail(result.error); }
          session.convo.push({ role: "tool", tool_call_id: tc.id, name: fname, content: JSON.stringify(result).slice(0, 12000) });
        }
        if (round === MAX_ROUNDS - 1) addBubble(session, "system", "Reached the step limit — ask me to continue if it isn't finished.");
        saveSessions();   // persist each round so a refresh loses nothing
      }
      try { if (typeof window.loadAgentsList === "function") window.loadAgentsList(); } catch (e) {}
    } catch (e) {
      addBubble(session, "error", (e && e.message) || String(e));
    } finally {
      think.remove();
      session.running = false;
      refresh(session);
    }
  }

  // ── UI ──
  var STARTERS = [
    "Build an agent that reverses a string",
    "Build a weather agent for a city (use a free API)",
    "What agents do I have, and what does each do?",
    "Run python: print the workspace files and versions"
  ];
  function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function mdInline(s) {
    return esc(s)
      .replace(/```([\s\S]*?)```/g, function (m, c) { return '<pre>' + c.replace(/^\n/, "") + '</pre>'; })
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
      .replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
  }

  var CSS =
    ":root{--surg-w:min(460px,100vw);--herd-w:min(1060px,72vw)}" +
    // True side-by-side: shrink the brainstem's flex-column body so the Copilot
    // lane takes the freed right strip — both stay fully usable. Herd mode just
    // makes that lane wider; it never covers the brainstem. Narrow screens
    // overlay full-width (no room to split).
    "@media(min-width:820px){html.surg-open body{width:calc(100vw - var(--surg-w));" +
    "transition:width .28s cubic-bezier(.22,.9,.3,1)}" +
    "html.surg-herd-open body{width:calc(100vw - var(--herd-w))}}" +
    "@media(max-width:819px){#surg-herd{width:100vw}}" +
    "#surg-btn{position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:9987;" +
    "background:#1c1e22;color:#e7e8ea;border:1px solid #2f3238;border-right:none;border-radius:12px 0 0 12px;" +
    "padding:14px 9px;cursor:pointer;font:600 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
    "writing-mode:vertical-rl;letter-spacing:.06em;box-shadow:-4px 0 20px rgba(0,0,0,.45);transition:padding .15s,background .15s;display:flex;align-items:center;gap:7px}" +
    "#surg-btn:hover{padding-right:13px;background:#23262c}#surg-btn svg{transform:rotate(90deg)}" +
    "#surg{position:fixed;top:0;right:0;width:var(--surg-w);height:100dvh;z-index:9988;" +
    "background:#141518;border-left:1px solid #2a2c31;display:flex;flex-direction:column;" +
    "transform:translateX(100%);transition:transform .28s cubic-bezier(.22,.9,.3,1);" +
    "box-shadow:-24px 0 60px rgba(0,0,0,.5);" +
    "font:13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e7e8ea}" +
    "#surg.open{transform:translateX(0)}" +
    "#surg *{box-sizing:border-box}" +
    "#surg header{display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:1px solid #26282d;" +
    "background:linear-gradient(180deg,#1c1e22,#17181b)}" +
    "#surg header .badge{width:30px;height:30px;border-radius:8px;background:#22252b;display:flex;align-items:center;" +
    "justify-content:center;border:1px solid #2f3238;color:#e7e8ea;flex:none}" +
    "#surg header .ttl{display:flex;flex-direction:column;line-height:1.15}" +
    "#surg header .t{font-weight:650;font-size:14px;letter-spacing:-.01em}" +
    "#surg header .sub{font-size:10.5px;color:#8b8f98;letter-spacing:.01em}" +
    "#surg header .m{margin-left:auto;font-size:11px;color:#9aa0a9;background:#1e2025;border:1px solid #2c2f35;" +
    "border-radius:20px;padding:3px 10px;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,Menlo,monospace}" +
    "#surg header .herd{background:#1e2025;border:1px solid #2c2f35;color:#9aa0a9;border-radius:8px;width:28px;height:26px;font-size:14px;cursor:pointer;line-height:1;flex:none}" +
    "#surg header .herd:hover,#surg header .herd.on{border-color:#3d7cf0;color:#e7e8ea}" +
    "#surg header .x{background:none;border:none;color:#8b8f98;font-size:20px;cursor:pointer;padding:0 2px;line-height:1}" +
    "#surg header .x:hover{color:#fff}" +
    // Herd view — a grid of independent Copilot chats, all on one brainstem.
    "#surg-herd{position:fixed;top:0;right:0;bottom:0;left:auto;width:var(--herd-w);z-index:9990;" +
    "background:#0f1013;border-left:1px solid #2a2c31;box-shadow:-24px 0 60px rgba(0,0,0,.5);" +
    "display:none;flex-direction:column;font:13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e7e8ea}" +
    "#surg-herd.open{display:flex}#surg-herd *{box-sizing:border-box}" +
    "#surg-herd .hbar{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #26282d;background:linear-gradient(180deg,#1c1e22,#17181b)}" +
    "#surg-herd .hbar .badge{width:28px;height:28px;border-radius:8px;background:#22252b;display:flex;align-items:center;justify-content:center;border:1px solid #2f3238}" +
    "#surg-herd .hbar .t{font-weight:650;font-size:14px}#surg-herd .hbar .sub{font-size:11px;color:#8b8f98}" +
    "#surg-herd .hbar .hnew{margin-left:auto;background:#1a1c21;border:1px solid #2a2d33;color:#d7dae0;border-radius:8px;padding:6px 12px;font-size:12.5px;cursor:pointer}" +
    "#surg-herd .hbar .hnew:hover{border-color:#3d7cf0}" +
    "#surg-herd .hbar .hclose{background:linear-gradient(180deg,#3d7cf0,#2f66d8);border:none;color:#fff;border-radius:8px;padding:6px 12px;font-size:12.5px;cursor:pointer}" +
    "#surg-herd .grid{flex:1;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;padding:14px;align-content:start}" +
    "#surg-herd .htile{display:flex;flex-direction:column;background:#141518;border:1px solid #2a2c31;border-radius:12px;overflow:hidden;height:min(78vh,640px)}" +
    "#surg-herd .htile .hh{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid #26282d;background:#181a1e;font-size:12.5px}" +
    "#surg-herd .htile .hh .tt{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    "#surg-herd .htile .hh .hsp{width:11px;height:11px;flex:none}" +
    "#surg-herd .htile .hh .hsp.on{border:2px solid #33363c;border-top-color:#3d7cf0;border-radius:50%;animation:surg-spin .8s linear infinite}" +
    "#surg-herd .htile .hh .hst{font-size:10px;text-transform:uppercase;letter-spacing:.08em;padding:2px 7px;border-radius:20px;border:1px solid #2a2d33;color:#8b8f98}" +
    "#surg-herd .htile .hh .hst.working{color:#8fc4ff;border-color:#284a73}#surg-herd .htile .hh .hst.done{color:#5cc271;border-color:#2c5a38}" +
    "#surg-herd .htile .hh .cl{margin-left:auto;color:#6c7079;font-size:16px;cursor:pointer;line-height:1}#surg-herd .htile .hh .cl:hover{color:#fff}" +
    "#surg-herd .htile .hh .tt{flex:1}" +
    "#surg-herd .htile .htrans{flex:1;overflow:auto;scrollbar-width:thin;scrollbar-color:#33363c transparent}" +
    "#surg-herd .htile .htrans .sess{min-height:100%}" +
    "#surg-herd .htile .hcomp{display:flex;gap:7px;padding:9px;border-top:1px solid #26282d;background:#17181b}" +
    "#surg-herd .htile .hcomp textarea{flex:1;resize:none;background:#1c1e23;border:1px solid #2c2f35;border-radius:9px;color:#e7e8ea;padding:8px 10px;font:13px inherit;max-height:90px}" +
    "#surg-herd .htile .hcomp textarea:focus{outline:none;border-color:#3d7cf0}" +
    "#surg-herd .htile .hcomp button{flex:none;background:linear-gradient(180deg,#3d7cf0,#2f66d8);border:none;color:#fff;border-radius:9px;width:40px;font-size:15px;cursor:pointer}" +
    "#surg-herd .htile .hcomp button:disabled{opacity:.5;cursor:default}" +
    // Tab strip — one tab per independent Copilot chat over the same brainstem.
    "#surg-tabs{display:flex;align-items:center;gap:4px;padding:6px 8px;border-bottom:1px solid #26282d;background:#181a1e;overflow-x:auto;scrollbar-width:none}" +
    "#surg-tabs::-webkit-scrollbar{display:none}" +
    "#surg-tabs .tab{display:flex;align-items:center;gap:7px;padding:5px 9px;border-radius:8px;font-size:12px;color:#9aa0a9;cursor:pointer;white-space:nowrap;border:1px solid transparent;flex:none}" +
    "#surg-tabs .tab:hover{background:#1e2126}" +
    "#surg-tabs .tab.active{background:#22252b;border-color:#2f3238;color:#e7e8ea}" +
    "#surg-tabs .tab .tt{overflow:hidden;text-overflow:ellipsis;max-width:120px}" +
    "#surg-tabs .tab .cl{color:#6c7079;font-size:14px;line-height:1;padding:0 1px}#surg-tabs .tab .cl:hover{color:#fff}" +
    "#surg-tabs .tab .sp{width:10px;height:10px;border:2px solid #33363c;border-top-color:#3d7cf0;border-radius:50%;animation:surg-spin .8s linear infinite;flex:none}" +
    "#surg-tabs .new{flex:none;background:#1a1c21;border:1px solid #2a2d33;color:#9aa0a9;border-radius:8px;width:26px;height:26px;font-size:16px;cursor:pointer;line-height:1}" +
    "#surg-tabs .new:hover{border-color:#3d7cf0;color:#e7e8ea}" +
    "#surg-log{flex:1;overflow-y:auto;position:relative;scrollbar-width:thin;scrollbar-color:#33363c transparent}" +
    "#surg-log::-webkit-scrollbar{width:9px}#surg-log::-webkit-scrollbar-thumb{background:#2f3238;border-radius:9px;border:2px solid #141518}" +
    // Transcript content is scoped to .sess (not #surg) so it renders identically
    // whether the session lives in the docked panel or a herd tile.
    ".sess{display:flex;flex-direction:column;gap:11px;padding:16px 15px}" +
    "#surg-log .sess{min-height:100%}" +
    ".sess .empty{margin:auto 0;text-align:center;color:#9a9ea7;font-size:13px;line-height:1.75;padding:8px 6px}" +
    ".sess .empty .hero{font-size:34px;margin-bottom:10px}" +
    ".sess .empty h3{color:#e7e8ea;font-size:16px;font-weight:650;margin:0 0 6px}" +
    ".sess .empty .caps{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:16px 0 6px}" +
    ".sess .empty .caps span{font-size:11px;color:#aeb2ba;background:#1b1d22;border:1px solid #2a2d33;border-radius:20px;padding:3px 10px}" +
    ".sess .empty .st{display:flex;flex-direction:column;gap:7px;margin-top:16px}" +
    ".sess .empty .st button{background:#1a1c21;border:1px solid #2a2d33;color:#d7dae0;border-radius:10px;" +
    "padding:9px 13px;font-size:12.5px;cursor:pointer;text-align:left;transition:border-color .12s,background .12s}" +
    ".sess .empty .st button:hover{border-color:#3d7cf0;background:#1e2128}" +
    ".sess .b{max-width:92%;padding:10px 13px;border-radius:12px;font-size:13px;word-break:break-word}" +
    ".sess .b.user{align-self:flex-end;background:linear-gradient(180deg,#3d7cf0,#356fe0);color:#fff;border-bottom-right-radius:5px}" +
    ".sess .b.assistant{align-self:flex-start;background:#1c1e23;border:1px solid #2a2d33;border-left:2px solid #3d7cf0;border-bottom-left-radius:5px}" +
    ".sess .b.system{align-self:center;background:none;color:#8b8f98;font-size:12px;text-align:center;max-width:96%}" +
    ".sess .b.error{align-self:flex-start;background:#2a1618;border:1px solid #5a2626;color:#ff9a9a}" +
    ".sess .b pre{background:#0f1013;border:1px solid #2a2d33;border-radius:7px;padding:9px 10px;overflow-x:auto;" +
    "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:7px 0;color:#d7dae0}" +
    ".sess .b code{background:#0f1013;border:1px solid #23262b;border-radius:4px;padding:1px 5px;font:12px ui-monospace,Menlo,monospace}" +
    ".sess .b.assistant strong{color:#fff}" +
    ".sess .tool{align-self:flex-start;max-width:92%;width:auto;background:#16181c;border:1px solid #282b31;border-radius:10px;overflow:hidden}" +
    ".sess .tool .h{display:flex;align-items:center;gap:9px;padding:8px 11px;cursor:pointer;font-size:12.5px}" +
    ".sess .tool .h:hover{background:#1a1d22}" +
    ".sess .tool .ic{width:22px;height:22px;border-radius:6px;background:#20242b;display:flex;align-items:center;justify-content:center;font-size:12px;flex:none}" +
    ".sess .tool .nm{font-weight:600;font-family:ui-monospace,Menlo,monospace;font-size:12px}" +
    ".sess .tool .ar{color:#8b8f98;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;font-size:11.5px}" +
    ".sess .tool .st{margin-left:auto;font-size:12px;flex:none}" +
    ".sess .tool .spin{width:12px;height:12px;border:2px solid #33363c;border-top-color:#3d7cf0;border-radius:50%;animation:surg-spin .8s linear infinite}" +
    ".sess .tool .body{display:none;border-top:1px solid #282b31;padding:9px 11px;white-space:pre-wrap;" +
    "font:11.5px/1.5 ui-monospace,Menlo,monospace;color:#c3c7ce;max-height:260px;overflow:auto}" +
    ".sess .tool.open .body{display:block}" +
    ".sess .think{align-self:flex-start;display:flex;align-items:center;gap:9px;color:#8b8f98;font-size:12.5px;padding:2px 2px}" +
    ".sess .think .dots span{display:inline-block;width:5px;height:5px;margin:0 1.5px;border-radius:50%;background:#3d7cf0;animation:surg-bounce 1.2s infinite}" +
    ".sess .think .dots span:nth-child(2){animation-delay:.18s}.sess .think .dots span:nth-child(3){animation-delay:.36s}" +
    "@keyframes surg-bounce{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}" +
    "@keyframes surg-spin{to{transform:rotate(360deg)}}" +
    "#surg .comp{border-top:1px solid #26282d;padding:12px 13px calc(12px + env(safe-area-inset-bottom));background:#17181b}" +
    "#surg .comp .box{background:#1c1e23;border:1px solid #2c2f35;border-radius:14px;padding:4px;transition:border-color .12s}" +
    "#surg .comp .box:focus-within{border-color:#3d7cf0}" +
    "#surg .comp textarea{width:100%;resize:none;background:none;border:none;color:#e7e8ea;padding:9px 11px 4px;" +
    "font:13.5px/1.5 inherit;max-height:150px}#surg .comp textarea:focus{outline:none}" +
    "#surg .comp textarea::placeholder{color:#6c7079}" +
    "#surg .comp .bar{display:flex;align-items:center;gap:8px;padding:2px 6px 4px}" +
    "#surg .comp .mode{font-size:11px;color:#8b8f98;display:flex;align-items:center;gap:5px}" +
    "#surg .comp .mode b{color:#c3c7ce;font-weight:600}" +
    "#surg .comp .send{margin-left:auto;background:linear-gradient(180deg,#3d7cf0,#2f66d8);border:none;color:#fff;" +
    "border-radius:9px;padding:8px 18px;font-weight:600;font-size:13px;cursor:pointer;transition:filter .12s}" +
    "#surg .comp .send:hover:not(:disabled){filter:brightness(1.1)}#surg .comp .send:disabled{opacity:.55;cursor:default}" +
    "#surg .comp .burrow{background:#201d17;border:1px solid #4a3a1e;color:#e8b96a;border-radius:9px;padding:7px 11px;font-size:12px;cursor:pointer;white-space:nowrap}" +
    "#surg .comp .burrow:hover{border-color:#d29922}#surg .comp .burrow.on{background:#3a2a10;border-color:#d29922;color:#ffce7a}" +
    "#surg.burrowed{border-left-color:#d29922}#surg.burrowed header{background:linear-gradient(180deg,#241f16,#1a1712)}" +
    "#surg .comp .hint{font-size:10.5px;color:#5f636b;margin-top:7px;text-align:center}";

  function build() {
    if (els.panel) return;
    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    // In the browser there's no VS Code to open (that's a local-brainstem
    // thing) — repurpose the header's VS Code button as the Copilot launcher.
    // boot.js routes clicks on the header's (repurposed) VS Code button to
    // window.__openSurgeon — the header button TOGGLES the panel (open ↔ hide);
    // hiding keeps every chat's DOM/state intact, so re-showing loses nothing.
    window.__openSurgeon = function () { toggle(); };
    // Open-only variant for the refresh auto-reopen (never closes).
    window.__showSurgeon = function () { if (!els.panel.classList.contains("open")) toggle(); };
    var vscodeLink = document.getElementById("vscode-link");
    if (vscodeLink) {
      vscodeLink.title = "GitHub Copilot — build agents (agent mode)";
      vscodeLink.style.cursor = "pointer";
      vscodeLink.innerHTML = '<span class="icon">' + COPILOT_SVG.replace('width="15" height="15"', 'width="16" height="16"') + "</span>";
    } else {
      // Fallback: a pull-out tab on the right edge.
      var btn = document.createElement("button");
      btn.id = "surg-btn";
      btn.innerHTML = COPILOT_SVG + " GitHub Copilot";
      btn.title = "GitHub Copilot agent loop, in your brainstem — full Python VM";
      btn.onclick = toggle;
      document.body.appendChild(btn);
    }

    var panel = document.createElement("div");
    panel.id = "surg";
    panel.innerHTML =
      '<header><span class="badge">' + COPILOT_SVG + '</span>' +
      '<span class="ttl"><span class="t">GitHub Copilot</span>' +
      '<span class="sub">Brain Surgeon · agent mode</span></span>' +
      '<span class="m" id="surg-model">Agent</span>' +
      '<button class="herd" id="surg-herd-btn" title="Herd view — chat with several Copilots at once">⊞</button>' +
      '<button class="x" title="Close panel">×</button></header>' +
      '<div id="surg-tabs"></div>' +
      '<div id="surg-log"></div>' +
      '<div class="comp"><div class="box">' +
      '<textarea id="surg-in" rows="2" placeholder="Describe what to build, or ask Copilot to run something…"></textarea>' +
      '<div class="bar"><span class="mode" id="surg-mode">' + COPILOT_SVG + ' <b>Agent</b> · full Python VM, sandboxed</span>' +
      '<button class="burrow" id="surg-burrow" title="EXPERIMENTAL: run on the real desk computer over the sealed Desk Pair channel" style="display:none">🕳️ Burrow</button>' +
      '<button class="send" id="surg-send">Build</button></div>' +
      '</div><div class="hint">runs on your GitHub Copilot account · ⌘↵ to send</div></div>';
    document.body.appendChild(panel);
    els.panel = panel;
    els.log = panel.querySelector("#surg-log");
    els.tabs = panel.querySelector("#surg-tabs");
    els.input = panel.querySelector("#surg-in");
    els.send = panel.querySelector("#surg-send");
    els.model = panel.querySelector("#surg-model");
    els.mode = panel.querySelector("#surg-mode");
    els.burrow = panel.querySelector("#surg-burrow");
    els.burrow.onclick = toggleBurrow;
    els.herdBtn = panel.querySelector("#surg-herd-btn");
    els.herdBtn.onclick = toggleHerd;
    panel.querySelector(".x").onclick = toggle;
    els.send.onclick = submit;
    els.input.addEventListener("input", function () {
      els.input.style.height = "auto";
      els.input.style.height = Math.min(els.input.scrollHeight, 150) + "px";
    });
    els.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    });
    var saved = loadSessions();
    if (saved) {
      saved.sessions.forEach(restoreSession);
      var act = (saved.active && sessions.some(function (s) { return s.id === saved.active; })) ? saved.active : sessions[0].id;
      setActive(act);
    } else {
      newSession();   // first chat
    }
  }

  // ── session management ──
  function newSession() {
    var s = { id: ++sseq, defaultTitle: "New chat", title: "New chat", convo: [], running: false, model: null, logEl: null, thinkEl: null, tileEl: null };
    var log = document.createElement("div");
    log.className = "sess";
    els.log.appendChild(log);
    s.logEl = log;
    sessions.push(s);
    renderEmptyInto(s);
    if (herd) { addTile(s); renderTabs(); }
    else { setActive(s.id); if (els.input) els.input.focus(); }
    saveSessions();
    return s;
  }
  function setActive(id) {
    activeId = id;
    for (var i = 0; i < sessions.length; i++) {
      sessions[i].logEl.style.display = (sessions[i].id === id) ? "" : "none";
    }
    var s = activeSession();
    if (s) { setModel(s.model); s.logEl.scrollTop = s.logEl.scrollHeight; }
    renderTabs();
    syncComposer();
  }
  function closeSession(id) {
    var i = -1;
    for (var k = 0; k < sessions.length; k++) if (sessions[k].id === id) { i = k; break; }
    if (i < 0) return;
    if (sessions[i].tileEl) sessions[i].tileEl.remove();
    sessions[i].logEl.remove();
    sessions.splice(i, 1);
    if (!sessions.length) { newSession(); return; }
    if (herd) { renderTabs(); if (activeId === id) activeId = sessions[Math.max(0, i - 1)].id; }
    else if (activeId === id) setActive(sessions[Math.max(0, i - 1)].id);
    else renderTabs();
    saveSessions();
  }
  function renderTabs() {
    if (!els.tabs) return;
    els.tabs.innerHTML = "";
    sessions.forEach(function (s) {
      var tab = document.createElement("div");
      tab.className = "tab" + (s.id === activeId ? " active" : "");
      var title = s.title.length > 22 ? s.title.slice(0, 22) + "…" : s.title;
      tab.innerHTML = (s.running ? '<span class="sp"></span>' : "") +
        '<span class="tt">' + esc(title) + "</span>" +
        (sessions.length > 1 ? '<span class="cl" title="Close chat">×</span>' : "");
      tab.onclick = function (e) {
        if (e.target && e.target.classList.contains("cl")) { e.stopPropagation(); closeSession(s.id); }
        else setActive(s.id);
      };
      els.tabs.appendChild(tab);
    });
    var add = document.createElement("button");
    add.className = "new";
    add.textContent = "+";
    add.title = "New Copilot chat (same brainstem)";
    add.onclick = function () { newSession(); };
    els.tabs.appendChild(add);
  }

  // Reflect a session's running/title state wherever it's shown.
  function refresh(session) {
    renderTabs();
    updateTile(session);
    if (session.id === activeId) syncComposer();
    saveSessions();
  }

  // ── Herd view: every session as a live tile in a grid ──
  function ensureHerdDom() {
    if (els.herd) return;
    var h = document.createElement("div");
    h.id = "surg-herd";
    h.innerHTML =
      '<div class="hbar"><span class="badge">' + COPILOT_SVG + '</span>' +
      '<span class="t">GitHub Copilot · Herd</span>' +
      '<span class="sub">multiple agents, one brainstem</span>' +
      '<button class="hnew">+ New chat</button>' +
      '<button class="hclose">Dock ▸</button></div>' +
      '<div class="grid" id="surg-grid"></div>';
    document.body.appendChild(h);
    els.herd = h;
    els.grid = h.querySelector("#surg-grid");
    h.querySelector(".hnew").onclick = function () { newSession(); };   // newSession adds the tile when herd is open
    h.querySelector(".hclose").onclick = exitHerd;
  }
  function tileFor(s) {
    var tile = document.createElement("div");
    tile.className = "htile";
    tile.innerHTML =
      '<div class="hh"><span class="hsp"></span><span class="tt"></span>' +
      '<span class="hst">ready</span><span class="cl" title="Close chat">×</span></div>' +
      '<div class="htrans"></div>' +
      '<div class="hcomp"><textarea rows="1" placeholder="Message this Copilot…"></textarea><button class="hsend">➤</button></div>';
    tile.querySelector(".htrans").appendChild(s.logEl);
    s.logEl.style.display = "";
    // Scope the selectors: the moved-in transcript also contains buttons, so
    // querySelector('button') would grab a starter button, not this composer's.
    var ta = tile.querySelector(".hcomp textarea"), btn = tile.querySelector(".hcomp button");
    function send() { var t = (ta.value || "").trim(); if (!t || s.running) return; ta.value = ""; ta.style.height = "auto"; runTask(s, t); }
    btn.onclick = send;
    ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
    ta.addEventListener("input", function () { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 90) + "px"; });
    tile.querySelector(".cl").onclick = function () { closeSession(s.id); };
    s.tileEl = tile;
    updateTile(s);
    return tile;
  }
  function updateTile(s) {
    if (!s.tileEl) return;
    s.tileEl.querySelector(".tt").textContent = s.title;
    s.tileEl.querySelector(".hsp").className = "hsp" + (s.running ? " on" : "");
    var st = s.tileEl.querySelector(".hst");
    if (st) {
      var state = s.running ? "working" : (s.convo.length ? "done" : "ready");
      st.textContent = state;
      st.className = "hst " + state;
    }
    var b = s.tileEl.querySelector(".hcomp button");
    if (b) b.disabled = s.running;
  }
  function addTile(s) { ensureHerdDom(); els.grid.appendChild(tileFor(s)); }
  function enterHerd() {
    ensureHerdDom();
    els.grid.innerHTML = "";
    sessions.forEach(function (s) { s.tileEl = null; els.grid.appendChild(tileFor(s)); });
    els.herd.classList.add("open");
    document.documentElement.classList.add("surg-herd-open");   // widen the lane, keep the brainstem
    herd = true;
    if (els.herdBtn) els.herdBtn.classList.add("on");
  }
  function exitHerd() {
    herd = false;
    if (els.herd) els.herd.classList.remove("open");
    document.documentElement.classList.remove("surg-herd-open");
    if (els.herdBtn) els.herdBtn.classList.remove("on");
    sessions.forEach(function (s) { s.tileEl = null; els.log.appendChild(s.logEl); });
    setActive(activeId);
  }
  function toggleHerd() { if (herd) exitHerd(); else enterHerd(); }

  function renderEmptyInto(session) {
    var wrap = document.createElement("div");
    wrap.className = "empty";
    wrap.innerHTML =
      '<div class="hero">' + COPILOT_SVG.replace('width="15" height="15"', 'width="38" height="38"') + '</div>' +
      '<h3>GitHub Copilot, in your brainstem</h3>' +
      'The real Copilot agent loop — describe an agent and it writes the file into your ' +
      'workspace, <b>hot-loads it, and tests it live</b>. Open more tabs with <b>+</b> to build ' +
      'several agents at once on the same brainstem.' +
      '<div class="caps"><span>▶ run python</span><span>📄 read/write files</span><span>🧠 test the brainstem</span></div>' +
      '<div class="st"></div>';
    var st = wrap.querySelector(".st");
    STARTERS.forEach(function (str) {
      var b = document.createElement("button");
      b.textContent = str;
      b.onclick = function () {
        if (herd) { runTask(session, str); }
        else { setActive(session.id); els.input.value = str; submit(); }
      };
      st.appendChild(b);
    });
    session.logEl.appendChild(wrap);
  }

  function toggle() {
    build();
    var open = els.panel.classList.toggle("open");
    document.documentElement.classList.toggle("surg-open", open);   // side-by-side
    if (!open && herd) exitHerd();
    if (open) {
      checkAuth();
      refreshBurrow();
      if (els._burrowTimer) clearInterval(els._burrowTimer);
      els._burrowTimer = setInterval(refreshBurrow, 2500);
      setTimeout(function () { els.input.focus(); }, 300);
    } else if (els._burrowTimer) { clearInterval(els._burrowTimer); els._burrowTimer = null; }
  }

  // The Burrow toggle appears only when a REAL desk machine is reachable with
  // host control enabled (Desk Paired + allow_host_control on that computer).
  function refreshBurrow() {
    if (!els.burrow) return;
    var avail = canBurrow();
    els.burrow.style.display = avail ? "" : "none";
    if (!avail && burrow) { burrow = false; applyBurrowUi(); }
  }
  function toggleBurrow() {
    if (!canBurrow()) return;
    if (!burrow) {
      var host = bridge().hostName ? bridge().hostName() : "the desk computer";
      if (!window.confirm("Burrow out of the sandbox?\n\nGitHub Copilot will run Python, shell commands, and file operations on " + host + " — your real computer — over the sealed Desk Pair channel. This is experimental and can be irreversible.\n\nEnable host control?")) return;
    }
    burrow = !burrow;
    applyBurrowUi();
  }
  function applyBurrowUi() {
    if (!els.burrow) return;
    els.burrow.classList.toggle("on", burrow);
    els.burrow.textContent = burrow ? "🕳️ Burrowed" : "🕳️ Burrow";
    els.panel.classList.toggle("burrowed", burrow);
    if (els.mode) {
      els.mode.innerHTML = burrow
        ? '🕳️ <b>Burrow</b> · running on ' + esc(bridge().hostName ? bridge().hostName() : "the desk computer")
        : COPILOT_SVG + ' <b>Agent</b> · full Python VM, sandboxed';
    }
  }

  function submit() {
    var t = (els.input.value || "").trim();
    if (!t) return;
    var s = activeSession() || newSession();
    if (s.running) return;   // this chat is busy — open a new tab (+) to run in parallel
    els.input.value = "";
    els.input.style.height = "auto";
    runTask(s, t);
  }

  function syncComposer() {
    var s = activeSession();
    var busy = !!(s && s.running);
    if (els.send) { els.send.disabled = busy; els.send.textContent = busy ? "Working…" : "Build"; }
  }
  function setModel(m) { if (els.model) els.model.textContent = m ? ("Agent · " + m) : "Agent"; }

  // Insert new content just ABOVE the session's "working…" indicator so it
  // stays pinned at the bottom — no MutationObserver (that caused a re-append
  // loop that froze the page).
  function place(session, node) {
    if (session.thinkEl && session.thinkEl.parentNode === session.logEl) session.logEl.insertBefore(node, session.thinkEl);
    else session.logEl.appendChild(node);
    if (session.id === activeId) session.logEl.scrollTop = session.logEl.scrollHeight;
  }

  function addBubble(session, role, text) {
    var d = document.createElement("div");
    d.className = "b " + role;
    d.innerHTML = (role === "user") ? esc(text) : mdInline(text);
    place(session, d);
    return d;
  }

  function addThinking(session) {
    var d = document.createElement("div");
    d.className = "think";
    d.innerHTML = '<span class="dots"><span></span><span></span><span></span></span> Copilot is working…';
    session.logEl.appendChild(d);
    session.thinkEl = d;
    if (session.id === activeId) session.logEl.scrollTop = session.logEl.scrollHeight;
    return { remove: function () { if (session.thinkEl === d) session.thinkEl = null; d.remove(); } };
  }

  var TOOL_ICON = { run_python: "▶", run_shell: "🕳️", burrow_run_agent: "🧩", burrow_install_agent: "📥", burrow_list_agents: "📋", list_dir: "📁", read_file: "📄", write_file: "✏️", delete_file: "🗑️", list_agents: "📋", test_brainstem: "🧠" };
  function argLabel(name, args) {
    if (name === "run_python") return (args.code || "").replace(/\s+/g, " ").slice(0, 70);
    if (name === "run_shell") return (args.command || "").slice(0, 70);
    if (name === "burrow_run_agent") return args.name || ("agent (" + (args.source || "").length + " bytes)");
    if (name === "burrow_install_agent") return args.filename || "";
    if (name === "test_brainstem") return JSON.stringify(args.message || "");
    if (name === "list_dir") return args.path || "workspace";
    return args.path || args.filename || "";
  }
  function addToolChip(session, name, args) {
    var wrap = document.createElement("div");
    wrap.className = "tool";
    wrap.innerHTML =
      '<div class="h"><span class="ic">' + (TOOL_ICON[name] || "🔧") + '</span>' +
      '<span class="nm">' + esc(name) + '</span>' +
      '<span class="ar">' + esc(argLabel(name, args)) + '</span>' +
      '<span class="st"><span class="spin"></span></span></div>' +
      '<div class="body"></div>';
    wrap.querySelector(".h").onclick = function () { wrap.classList.toggle("open"); };
    place(session, wrap);
    function setStatus(sym, color) { var st = wrap.querySelector(".st"); st.innerHTML = ""; st.textContent = sym; st.style.color = color; }
    return {
      done: function (result) {
        setStatus("✓", "#5cc271");
        var body = wrap.querySelector(".body");
        if (name === "run_python" || name === "run_shell") body.textContent = (result.output != null ? result.output : "") || "(no output)";
        else if (name === "burrow_run_agent") body.textContent = (result.result != null ? ("result: " + result.result) : ("error: " + (result.error || "?"))) + (result.logs ? "\n\nlogs:\n" + result.logs : "") + (result.traceback ? "\n\n" + result.traceback : "");
        else if (name === "test_brainstem") body.textContent = "reply: " + (result.response || result.error || "(none)") + (result.agent_logs ? "\n\nagent_logs:\n" + result.agent_logs : "");
        else if (name === "read_file") body.textContent = (result.content || "").slice(0, 6000);
        else if (name === "list_dir") body.textContent = (result.files || []).join("\n");
        else if (name === "burrow_list_agents") body.textContent = (result.files || []).map(function (f) { return f.filename + (f.agents && f.agents.length ? "  (" + f.agents.join(", ") + ")" : ""); }).join("\n") || "(no agents on the device twin yet)";
        else if (name === "list_agents") body.textContent = (result.files || []).map(function (f) { return f.filename + (f.agents && f.agents.length ? "  (" + f.agents.join(", ") + ")" : ""); }).join("\n");
        else body.textContent = JSON.stringify(result, null, 2).slice(0, 3000);
      },
      fail: function (err) {
        setStatus("✗", "#ff7b72");
        wrap.classList.add("open");
        wrap.querySelector(".body").textContent = err;
      }
    };
  }

  async function checkAuth() {
    try {
      var r = await VB().local("GET", "/health");
      var h = r.json || {};
      if (h.status !== "ok") { var s = activeSession(); if (s) addBubble(s, "system", "Sign in with GitHub (top-right of the brainstem) to use GitHub Copilot — it runs on your Copilot account."); }
    } catch (e) {}
  }

  function init() {
    var vb = VB();
    if (!vb || !vb.ready) { setTimeout(init, 400); return; }
    vb.ready.then(function () {
      build();
      // A refresh clears the brainstem chat but keeps the Copilot chats. If any
      // restored surgery has real history, reopen the panel so it isn't lost.
      if (sessions.some(function (s) { return s.convo && s.convo.length > 1; }) &&
          typeof window.__showSurgeon === "function") window.__showSurgeon();
    }).catch(build);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
