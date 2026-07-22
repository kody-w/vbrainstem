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

  function bridge() { return window.__DESKPAIR_BRIDGE__; }
  function canBurrow() { var b = bridge(); return !!(b && b.canBurrow && b.canBurrow()); }
  var burrow = false;

  function toolsFor() { return burrow ? TOOLS.concat([RUN_SHELL_TOOL]) : TOOLS; }
  function systemFor() {
    if (!burrow) return SYSTEM_PROMPT;
    return SYSTEM_PROMPT + "\n\n=== BURROW MODE IS ON ===\nrun_python, run_shell, read_file, write_file, list_dir and " +
      "delete_file now execute on the user's REAL computer (" + (bridge().hostName ? bridge().hostName() : "the desk") +
      ") over a sealed channel — real shell, real disk, real network, the same power the brainstem has running locally. " +
      "This is powerful and can be irreversible. Prefer read-only exploration first; state your plan in prose before any " +
      "destructive or system-changing command; never run something the user didn't ask for.";
  }

  function cleanPath(p) { return String(p || "").replace(/\\/g, "/").replace(/^\/+/, ""); }

  async function hostExec(req) {
    var res = await bridge().hostOp(req);
    if (res && res.error) throw new Error(res.error);
    return res || {};
  }

  async function execTool(name, args) {
    var vb = VB();
    // BURROW: capability tools execute on the REAL desk machine.
    if (burrow && canBurrow()) {
      if (name === "run_python") return await hostExec({ op: "python", code: String(args.code || "") });
      if (name === "run_shell") return await hostExec({ op: "shell", command: String(args.command || "") });
      if (name === "read_file") { var rr = await hostExec({ op: "read", path: cleanPath(args.path) }); return { path: cleanPath(args.path), content: rr.content }; }
      if (name === "write_file") { await hostExec({ op: "write", path: cleanPath(args.path), content: String(args.content || "") }); return { ok: true, path: cleanPath(args.path), bytes: (args.content || "").length }; }
      if (name === "list_dir") return await hostExec({ op: "list", path: cleanPath(args.path) || "." });
      if (name === "delete_file") return await hostExec({ op: "shell", command: "rm -f " + JSON.stringify(cleanPath(args.path)) });
      if (name === "test_brainstem") {
        // Test against the DESK brainstem (window.fetch is tether-routed).
        var dr = await window.fetch("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_input: String(args.message || ""), conversation_history: [] }) });
        var dj = await dr.json();
        return { response: dj.response, agent_logs: dj.agent_logs || "", error: dj.error };
      }
      // list_agents falls through to the local list below.
    }
    if (name === "run_shell") throw new Error("run_shell needs Burrow enabled — pair to a desk computer with host control.");
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
        user_input: String(args.message || ""), conversation_history: [], session_id: "surgeon-test"
      });
      var j = chat.json || {};
      return { response: j.response, agent_logs: j.agent_logs || "", error: j.error };
    }
    throw new Error("unknown tool: " + name);
  }

  // ── the agent loop ──
  var running = false;
  var convo = [];

  async function complete(messages) {
    var r = await VB().local("POST", "/surgeon/complete", { messages: messages, tools: toolsFor() });
    if (r.status === 401 || r.status === 403) throw new Error((r.json && r.json.error) || "not signed in");
    if (r.status >= 400) throw new Error((r.json && r.json.error) || ("surgeon " + r.status));
    return r.json;
  }

  async function runTask(task) {
    if (running) return;
    running = true;
    setBusy(true);
    if (!convo.length) convo.push({ role: "system", content: systemFor() });
    else convo[0] = { role: "system", content: systemFor() };  // reflect burrow state
    convo.push({ role: "user", content: task });
    addBubble("user", task);
    var think = addThinking();

    try {
      for (var round = 0; round < MAX_ROUNDS; round++) {
        var out = await complete(convo);
        var msg = out.message || {};
        setModel(out.model);
        var assistant = { role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls || [] };
        if (!assistant.tool_calls.length) delete assistant.tool_calls;
        convo.push(assistant);

        if (msg.content) addBubble("assistant", msg.content);
        if (!msg.tool_calls || !msg.tool_calls.length) {
          if (!msg.content) addBubble("assistant", "(done)");
          break;
        }
        for (var i = 0; i < msg.tool_calls.length; i++) {
          var tc = msg.tool_calls[i];
          var fname = tc.function && tc.function.name;
          var args = {};
          try { args = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (e) { args = {}; }
          var chip = addToolChip(fname, args);
          var result;
          try { result = await execTool(fname, args); chip.done(result); }
          catch (e) { result = { error: (e && e.message) || String(e) }; chip.fail(result.error); }
          convo.push({ role: "tool", tool_call_id: tc.id, name: fname, content: JSON.stringify(result).slice(0, 12000) });
        }
        if (round === MAX_ROUNDS - 1) addBubble("system", "Reached the step limit — ask me to continue if it isn't finished.");
      }
      try { if (typeof window.loadAgentsList === "function") window.loadAgentsList(); } catch (e) {}
    } catch (e) {
      addBubble("error", (e && e.message) || String(e));
    } finally {
      think.remove();
      running = false;
      setBusy(false);
    }
  }

  // ── UI ──
  var els = {};
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
    ":root{--surg-w:min(500px,100vw)}" +
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
    "#surg header .x{background:none;border:none;color:#8b8f98;font-size:20px;cursor:pointer;padding:0 2px;line-height:1}" +
    "#surg header .x:hover{color:#fff}" +
    "#surg-log{flex:1;overflow-y:auto;padding:16px 15px;display:flex;flex-direction:column;gap:11px;scrollbar-width:thin;scrollbar-color:#33363c transparent}" +
    "#surg-log::-webkit-scrollbar{width:9px}#surg-log::-webkit-scrollbar-thumb{background:#2f3238;border-radius:9px;border:2px solid #141518}" +
    "#surg .empty{margin:auto 0;text-align:center;color:#9a9ea7;font-size:13px;line-height:1.75;padding:8px 6px}" +
    "#surg .empty .hero{font-size:34px;margin-bottom:10px}" +
    "#surg .empty h3{color:#e7e8ea;font-size:16px;font-weight:650;margin:0 0 6px}" +
    "#surg .empty .caps{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin:16px 0 6px}" +
    "#surg .empty .caps span{font-size:11px;color:#aeb2ba;background:#1b1d22;border:1px solid #2a2d33;border-radius:20px;padding:3px 10px}" +
    "#surg .empty .st{display:flex;flex-direction:column;gap:7px;margin-top:16px}" +
    "#surg .empty .st button{background:#1a1c21;border:1px solid #2a2d33;color:#d7dae0;border-radius:10px;" +
    "padding:9px 13px;font-size:12.5px;cursor:pointer;text-align:left;transition:border-color .12s,background .12s}" +
    "#surg .empty .st button:hover{border-color:#3d7cf0;background:#1e2128}" +
    "#surg .b{max-width:92%;padding:10px 13px;border-radius:12px;font-size:13px;word-break:break-word}" +
    "#surg .b.user{align-self:flex-end;background:linear-gradient(180deg,#3d7cf0,#356fe0);color:#fff;border-bottom-right-radius:5px}" +
    "#surg .b.assistant{align-self:flex-start;background:#1c1e23;border:1px solid #2a2d33;border-left:2px solid #3d7cf0;border-bottom-left-radius:5px}" +
    "#surg .b.system{align-self:center;background:none;color:#8b8f98;font-size:12px;text-align:center;max-width:96%}" +
    "#surg .b.error{align-self:flex-start;background:#2a1618;border:1px solid #5a2626;color:#ff9a9a}" +
    "#surg .b pre{background:#0f1013;border:1px solid #2a2d33;border-radius:7px;padding:9px 10px;overflow-x:auto;" +
    "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:7px 0;color:#d7dae0}" +
    "#surg .b code{background:#0f1013;border:1px solid #23262b;border-radius:4px;padding:1px 5px;font:12px ui-monospace,Menlo,monospace}" +
    "#surg .b.assistant strong{color:#fff}" +
    "#surg .tool{align-self:flex-start;max-width:92%;width:auto;background:#16181c;border:1px solid #282b31;border-radius:10px;overflow:hidden}" +
    "#surg .tool .h{display:flex;align-items:center;gap:9px;padding:8px 11px;cursor:pointer;font-size:12.5px}" +
    "#surg .tool .h:hover{background:#1a1d22}" +
    "#surg .tool .ic{width:22px;height:22px;border-radius:6px;background:#20242b;display:flex;align-items:center;justify-content:center;font-size:12px;flex:none}" +
    "#surg .tool .nm{font-weight:600;font-family:ui-monospace,Menlo,monospace;font-size:12px}" +
    "#surg .tool .ar{color:#8b8f98;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;font-size:11.5px}" +
    "#surg .tool .st{margin-left:auto;font-size:12px;flex:none}" +
    "#surg .tool .spin{width:12px;height:12px;border:2px solid #33363c;border-top-color:#3d7cf0;border-radius:50%;animation:surg-spin .8s linear infinite}" +
    "#surg .tool .body{display:none;border-top:1px solid #282b31;padding:9px 11px;white-space:pre-wrap;" +
    "font:11.5px/1.5 ui-monospace,Menlo,monospace;color:#c3c7ce;max-height:260px;overflow:auto}" +
    "#surg .tool.open .body{display:block}" +
    "#surg .think{align-self:flex-start;display:flex;align-items:center;gap:9px;color:#8b8f98;font-size:12.5px;padding:2px 2px}" +
    "#surg .think .dots span{display:inline-block;width:5px;height:5px;margin:0 1.5px;border-radius:50%;background:#3d7cf0;animation:surg-bounce 1.2s infinite}" +
    "#surg .think .dots span:nth-child(2){animation-delay:.18s}#surg .think .dots span:nth-child(3){animation-delay:.36s}" +
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

    var btn = document.createElement("button");
    btn.id = "surg-btn";
    btn.innerHTML = COPILOT_SVG + " GitHub Copilot";
    btn.title = "GitHub Copilot agent loop, in your brainstem — full Python VM, no VS Code";
    btn.onclick = toggle;
    document.body.appendChild(btn);

    var panel = document.createElement("div");
    panel.id = "surg";
    panel.innerHTML =
      '<header><span class="badge">' + COPILOT_SVG + '</span>' +
      '<span class="ttl"><span class="t">GitHub Copilot</span>' +
      '<span class="sub">Brain Surgeon · agent mode</span></span>' +
      '<span class="m" id="surg-model">Agent</span>' +
      '<button class="x" title="Close">×</button></header>' +
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
    els.input = panel.querySelector("#surg-in");
    els.send = panel.querySelector("#surg-send");
    els.model = panel.querySelector("#surg-model");
    els.mode = panel.querySelector("#surg-mode");
    els.burrow = panel.querySelector("#surg-burrow");
    els.burrow.onclick = toggleBurrow;
    panel.querySelector(".x").onclick = toggle;
    els.send.onclick = submit;
    els.input.addEventListener("input", function () {
      els.input.style.height = "auto";
      els.input.style.height = Math.min(els.input.scrollHeight, 150) + "px";
    });
    els.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    });
    renderEmpty();
  }

  function renderEmpty() {
    var wrap = document.createElement("div");
    wrap.className = "empty";
    wrap.innerHTML =
      '<div class="hero">' + COPILOT_SVG.replace('width="15" height="15"', 'width="38" height="38"') + '</div>' +
      '<h3>GitHub Copilot, in your brainstem</h3>' +
      'The real Copilot agent loop — describe an agent and it writes the file into your ' +
      'workspace, <b>hot-loads it, and tests it live</b>. Same think→edit→test loop as VS Code, ' +
      'in a full Python VM, no install.' +
      '<div class="caps"><span>▶ run python</span><span>📄 read/write files</span><span>🧠 test the brainstem</span></div>' +
      '<div class="st"></div>';
    var st = wrap.querySelector(".st");
    STARTERS.forEach(function (s) {
      var b = document.createElement("button");
      b.textContent = s;
      b.onclick = function () { els.input.value = s; submit(); };
      st.appendChild(b);
    });
    els.log.innerHTML = "";
    els.log.appendChild(wrap);
  }

  function toggle() {
    build();
    var open = els.panel.classList.toggle("open");
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
    if (!t || running) return;
    els.input.value = "";
    els.input.style.height = "auto";
    var empty = els.log.querySelector(".empty");
    if (empty) empty.remove();
    runTask(t);
  }

  function setBusy(b) {
    if (els.send) { els.send.disabled = b; els.send.textContent = b ? "Working…" : "Build"; }
  }
  function setModel(m) { if (m && els.model) els.model.textContent = "Agent · " + m; }

  function addBubble(role, text) {
    var d = document.createElement("div");
    d.className = "b " + role;
    d.innerHTML = (role === "user") ? esc(text) : mdInline(text);
    els.log.appendChild(d);
    els.log.scrollTop = els.log.scrollHeight;
    return d;
  }

  function addThinking() {
    var d = document.createElement("div");
    d.className = "think";
    d.innerHTML = '<span class="dots"><span></span><span></span><span></span></span> Copilot is working…';
    els.log.appendChild(d);
    els.log.scrollTop = els.log.scrollHeight;
    // Keep it pinned at the bottom as new bubbles arrive.
    var mo = new MutationObserver(function () { if (d.parentNode) els.log.appendChild(d); });
    mo.observe(els.log, { childList: true });
    return { remove: function () { mo.disconnect(); d.remove(); } };
  }

  var TOOL_ICON = { run_python: "▶", run_shell: "🕳️", list_dir: "📁", read_file: "📄", write_file: "✏️", delete_file: "🗑️", list_agents: "📋", test_brainstem: "🧠" };
  function argLabel(name, args) {
    if (name === "run_python") return (args.code || "").replace(/\s+/g, " ").slice(0, 70);
    if (name === "run_shell") return (args.command || "").slice(0, 70);
    if (name === "test_brainstem") return JSON.stringify(args.message || "");
    if (name === "list_dir") return args.path || "workspace";
    return args.path || args.filename || "";
  }
  function addToolChip(name, args) {
    var wrap = document.createElement("div");
    wrap.className = "tool";
    wrap.innerHTML =
      '<div class="h"><span class="ic">' + (TOOL_ICON[name] || "🔧") + '</span>' +
      '<span class="nm">' + esc(name) + '</span>' +
      '<span class="ar">' + esc(argLabel(name, args)) + '</span>' +
      '<span class="st"><span class="spin"></span></span></div>' +
      '<div class="body"></div>';
    wrap.querySelector(".h").onclick = function () { wrap.classList.toggle("open"); };
    els.log.appendChild(wrap);
    els.log.scrollTop = els.log.scrollHeight;
    function setStatus(sym, color) { var st = wrap.querySelector(".st"); st.innerHTML = ""; st.textContent = sym; st.style.color = color; }
    return {
      done: function (result) {
        setStatus("✓", "#5cc271");
        var body = wrap.querySelector(".body");
        if (name === "run_python" || name === "run_shell") body.textContent = (result.output != null ? result.output : "") || "(no output)";
        else if (name === "test_brainstem") body.textContent = "reply: " + (result.response || result.error || "(none)") + (result.agent_logs ? "\n\nagent_logs:\n" + result.agent_logs : "");
        else if (name === "read_file") body.textContent = (result.content || "").slice(0, 6000);
        else if (name === "list_dir") body.textContent = (result.files || []).join("\n");
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
      if (h.status !== "ok") addBubble("system", "Sign in with GitHub (top-right of the brainstem) to use the Brain Surgeon — it runs on your Copilot account.");
    } catch (e) {}
  }

  function init() {
    var vb = VB();
    if (!vb || !vb.ready) { setTimeout(init, 400); return; }
    vb.ready.then(build).catch(build);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
