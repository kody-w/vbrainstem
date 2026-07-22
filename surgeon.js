/*
 * surgeon.js — the Brain Surgeon: a REAL GitHub Copilot agent loop in the
 * vBrainstem, side-by-side with the brainstem chat.
 *
 * Not a shell, not a proxy to /chat — this is the same agentic loop VS Code's
 * Copilot Agent mode runs: the signed-in GitHub Copilot model is given tools
 * and iterates (think → call tool → observe → repeat), building single-file
 * RAPP agents directly in THIS vBrainstem's workspace and testing them live.
 * No VS Code needed.
 *
 * Wiring:
 *   - completions:  __vbrainstem.local('POST','/surgeon/complete',{messages,tools})
 *                   → brainstem_web.call_copilot() (real Copilot token + model)
 *   - filesystem:   __vbrainstem.fs('list'|'read'|'write'|'delete', path, content)
 *   - hot-test:     __vbrainstem.local('POST','/chat',{user_input})  (LOCAL vB,
 *                   never the desk tether — the surgeon builds agents HERE)
 *
 * Loaded by index.html after vbrainstem-boot.js.
 */
(function () {
  'use strict';

  var MAX_ROUNDS = 18;
  var VB = function () { return window.__vbrainstem; };

  // ── RAPP agent contract, taught to the model ──
  var SYSTEM_PROMPT = [
    "You are the Brain Surgeon — an autonomous coding agent that builds and repairs",
    "RAPP agents inside a running brainstem, in the user's place. You operate its live",
    "workspace with tools and you VERIFY your work by running it. Think like a senior",
    "engineer: read before you write, keep changes minimal, and prove it works.",
    "",
    "A RAPP agent is ONE Python file in agents/ named <snake>_agent.py. It defines a",
    "class extending BasicAgent with a `metadata` dict (an OpenAI function-calling",
    "schema: name, description, parameters) and a `perform(self, **kwargs)` method that",
    "returns a STRING. Agents hot-load on the next request — no restart. The class must",
    "set self.name and call super().__init__(name=..., metadata=...). Canonical shape:",
    "",
    "```python",
    "from agents.basic_agent import BasicAgent",
    "",
    "class ReverseStringAgent(BasicAgent):",
    "    def __init__(self):",
    "        self.name = 'ReverseString'",
    "        self.metadata = {",
    "            'name': self.name,",
    "            'description': 'Reverses the characters in a string.',",
    "            'parameters': {",
    "                'type': 'object',",
    "                'properties': {'text': {'type': 'string', 'description': 'The text to reverse.'}},",
    "                'required': ['text']",
    "            }",
    "        }",
    "        super().__init__(name=self.name, metadata=self.metadata)",
    "",
    "    def perform(self, **kwargs):",
    "        return kwargs.get('text', '')[::-1]",
    "```",
    "",
    "Rules:",
    "- The Python standard library is available (Pyodide). Prefer stdlib; avoid heavy",
    "  third-party packages. Network calls use `requests` (already available).",
    "- Every parameter the agent needs must be in `metadata.parameters` with a clear",
    "  description — nothing hardcoded that the caller should supply.",
    "- perform() must return a human-readable string, never raise on normal input.",
    "",
    "Workflow, every task:",
    "1. If editing an existing agent, read_file it first. Call list_agents to see what",
    "   already exists (avoid duplicates; one agent per concern).",
    "2. write_agent the file.",
    "3. ALWAYS test_brainstem with a natural-language message that should trigger the new",
    "   agent, and confirm from the returned agent_logs that it actually ran and produced",
    "   the right output. If it didn't fire or errored, fix and re-test.",
    "4. When it works, stop and give the user a one-paragraph summary: what you built and",
    "   the proof (the tested message and result). Do not keep calling tools after success.",
    "Keep prose short between tool calls."
  ].join("\n");

  var TOOLS = [
    { type: "function", function: {
      name: "list_agents",
      description: "List the agent files currently installed in the workspace, with their loaded class names.",
      parameters: { type: "object", properties: {}, required: [] }
    }},
    { type: "function", function: {
      name: "read_file",
      description: "Read a workspace file (e.g. 'agents/foo_agent.py' or 'soul.md').",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "Workspace-relative path, e.g. agents/foo_agent.py" }
      }, required: ["path"] }
    }},
    { type: "function", function: {
      name: "write_agent",
      description: "Create or overwrite an agent file in agents/. Filename must be <snake>_agent.py. It hot-loads on the next brainstem request.",
      parameters: { type: "object", properties: {
        filename: { type: "string", description: "e.g. reverse_string_agent.py (no path, must end with _agent.py)" },
        content: { type: "string", description: "The full Python source of the agent file." }
      }, required: ["filename", "content"] }
    }},
    { type: "function", function: {
      name: "delete_agent",
      description: "Delete an agent file from agents/.",
      parameters: { type: "object", properties: {
        filename: { type: "string", description: "e.g. reverse_string_agent.py" }
      }, required: ["filename"] }
    }},
    { type: "function", function: {
      name: "test_brainstem",
      description: "Send a natural-language message to THIS brainstem and return its reply plus agent_logs — use it to verify a new agent actually fires and produces the right output.",
      parameters: { type: "object", properties: {
        message: { type: "string", description: "What a user would type to trigger the agent, e.g. 'reverse the word hello'." }
      }, required: ["message"] }
    }}
  ];

  function safeName(fn) {
    fn = String(fn || "").replace(/\\/g, "/").split("/").pop();
    if (!/^[a-zA-Z0-9_]+_agent\.py$/.test(fn)) throw new Error("filename must be <snake>_agent.py");
    return fn;
  }

  // ── tool execution against the LOCAL vBrainstem ──
  async function execTool(name, args) {
    var vb = VB();
    if (name === "list_agents") {
      var r = await vb.local("GET", "/agents");
      return { files: (r.json && r.json.files) || [] };
    }
    if (name === "read_file") {
      var p = String(args.path || "").replace(/^\/+/, "");
      var res = await vb.fs("read", p);
      return { path: p, content: res.content };
    }
    if (name === "write_agent") {
      var fn = safeName(args.filename);
      if (!args.content || typeof args.content !== "string") throw new Error("content required");
      await vb.fs("write", "agents/" + fn, args.content);
      return { ok: true, path: "agents/" + fn, bytes: args.content.length };
    }
    if (name === "delete_agent") {
      var df = safeName(args.filename);
      await vb.fs("delete", "agents/" + df);
      return { ok: true, deleted: "agents/" + df };
    }
    if (name === "test_brainstem") {
      var chat = await vb.local("POST", "/chat", {
        user_input: String(args.message || ""),
        conversation_history: [],
        session_id: "surgeon-test"
      });
      var j = chat.json || {};
      return { response: j.response, agent_logs: j.agent_logs || "", error: j.error };
    }
    throw new Error("unknown tool: " + name);
  }

  // ── the agent loop ──
  var running = false;
  var convo = [];   // full message history for the model

  async function complete(messages) {
    var r = await VB().local("POST", "/surgeon/complete", { messages: messages, tools: TOOLS });
    if (r.status === 401 || r.status === 403) throw new Error((r.json && r.json.error) || "not signed in");
    if (r.status >= 400) throw new Error((r.json && r.json.error) || ("surgeon " + r.status));
    return r.json;
  }

  async function runTask(task) {
    if (running) return;
    running = true;
    setBusy(true);
    if (!convo.length) convo.push({ role: "system", content: SYSTEM_PROMPT });
    convo.push({ role: "user", content: task });
    addBubble("user", task);

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
          try {
            result = await execTool(fname, args);
            chip.done(result);
          } catch (e) {
            result = { error: (e && e.message) || String(e) };
            chip.fail(result.error);
          }
          convo.push({ role: "tool", tool_call_id: tc.id, name: fname, content: JSON.stringify(result).slice(0, 12000) });
        }
        if (round === MAX_ROUNDS - 1) addBubble("system", "Reached the step limit — ask me to continue if it isn't finished.");
      }
      // A freshly written/hot-loaded agent should appear in the ⊕ panel.
      try { if (typeof window.loadAgentsList === "function") window.loadAgentsList(); } catch (e) {}
    } catch (e) {
      addBubble("error", (e && e.message) || String(e));
    } finally {
      running = false;
      setBusy(false);
    }
  }

  // ── UI ──
  var els = {};
  function esc(s) { var d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function mdInline(s) {
    return esc(s)
      .replace(/```([\s\S]*?)```/g, function (m, c) { return '<pre>' + c.replace(/^\n/, "") + '</pre>'; })
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
  }

  function build() {
    if (els.panel) return;
    var style = document.createElement("style");
    style.textContent =
      "#surg-btn{position:fixed;top:50%;right:0;transform:translateY(-50%);z-index:9987;" +
      "background:#0e639c;color:#fff;border:none;border-radius:10px 0 0 10px;padding:12px 8px;" +
      "cursor:pointer;font:600 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
      "writing-mode:vertical-rl;letter-spacing:.08em;box-shadow:-3px 0 14px rgba(0,0,0,.4)}" +
      "#surg-btn:hover{background:#1177bb}" +
      "#surg{position:fixed;top:0;right:0;width:min(480px,100vw);height:100vh;z-index:9988;" +
      "background:#1e1e1e;border-left:1px solid #333;display:flex;flex-direction:column;" +
      "transform:translateX(100%);transition:transform .25s ease;" +
      "font:13px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e6e6e6}" +
      "#surg.open{transform:translateX(0)}" +
      "#surg header{display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid #333;background:#252526}" +
      "#surg header .t{font-weight:650;font-size:13px}#surg header .m{margin-left:auto;font-size:11px;color:#8a8a8a}" +
      "#surg header .x{background:none;border:none;color:#8a8a8a;font-size:18px;cursor:pointer;padding:0 4px}" +
      "#surg header .x:hover{color:#fff}" +
      "#surg-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}" +
      "#surg .empty{color:#8a8a8a;font-size:12.5px;line-height:1.7}" +
      "#surg .b{max-width:94%;padding:9px 12px;border-radius:9px;font-size:13px;white-space:normal;word-break:break-word}" +
      "#surg .b.user{align-self:flex-end;background:#0e639c;color:#fff}" +
      "#surg .b.assistant{align-self:flex-start;background:#2d2d2d}" +
      "#surg .b.system{align-self:center;background:none;color:#8a8a8a;font-size:12px}" +
      "#surg .b.error{align-self:flex-start;background:#5a1d1d;color:#ffb4b4}" +
      "#surg .b pre{background:#161616;border:1px solid #333;border-radius:6px;padding:8px;overflow-x:auto;font:12px ui-monospace,Menlo,monospace;margin:6px 0}" +
      "#surg .b code{background:#161616;border-radius:4px;padding:1px 4px;font:12px ui-monospace,Menlo,monospace}" +
      "#surg .tool{align-self:flex-start;max-width:94%;background:#161b22;border:1px solid #30363d;border-radius:8px;font-size:12px;overflow:hidden}" +
      "#surg .tool .h{display:flex;align-items:center;gap:7px;padding:7px 10px;cursor:pointer}" +
      "#surg .tool .ic{width:15px;text-align:center}#surg .tool .nm{font-weight:600}#surg .tool .ar{color:#8a8a8a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      "#surg .tool .st{margin-left:auto;font-size:11px}" +
      "#surg .tool .body{display:none;border-top:1px solid #30363d;padding:8px 10px;white-space:pre-wrap;font:11.5px ui-monospace,Menlo,monospace;color:#c9d1d9;max-height:240px;overflow:auto}" +
      "#surg .tool.open .body{display:block}" +
      "#surg .comp{border-top:1px solid #333;padding:10px 12px;background:#252526;display:flex;flex-direction:column;gap:8px}" +
      "#surg .comp textarea{width:100%;resize:none;background:#3c3c3c;border:1px solid #3c3c3c;border-radius:8px;color:#e6e6e6;padding:9px 11px;font:13px inherit;max-height:120px}" +
      "#surg .comp textarea:focus{outline:none;border-color:#0e639c}" +
      "#surg .comp .row{display:flex;align-items:center;gap:8px}" +
      "#surg .comp .agent-pill{font-size:11px;color:#8a8a8a;border:1px solid #3c3c3c;border-radius:20px;padding:2px 9px}" +
      "#surg .comp button{margin-left:auto;background:#0e639c;border:none;color:#fff;border-radius:7px;padding:8px 16px;font-weight:600;cursor:pointer}" +
      "#surg .comp button:disabled{opacity:.5;cursor:default}" +
      "#surg .starters{display:flex;flex-wrap:wrap;gap:6px}" +
      "#surg .starters button{background:#2d2d2d;border:1px solid #3c3c3c;color:#cbd5e1;border-radius:14px;padding:4px 10px;font-size:11.5px;cursor:pointer}" +
      "#surg .starters button:hover{border-color:#0e639c}";
    document.head.appendChild(style);

    var btn = document.createElement("button");
    btn.id = "surg-btn";
    btn.textContent = "🩺 Brain Surgeon";
    btn.title = "Build agents with the GitHub Copilot agent loop — no VS Code needed";
    btn.onclick = toggle;
    document.body.appendChild(btn);

    var panel = document.createElement("div");
    panel.id = "surg";
    panel.innerHTML =
      '<header><span>🩺</span><span class="t">Brain Surgeon</span>' +
      '<span class="m" id="surg-model">GitHub Copilot · Agent</span>' +
      '<button class="x" title="Close">×</button></header>' +
      '<div id="surg-log"></div>' +
      '<div class="comp">' +
      '<div class="starters" id="surg-starters"></div>' +
      '<textarea id="surg-in" rows="2" placeholder="Describe what to build — e.g. an agent that fetches the weather for a city"></textarea>' +
      '<div class="row"><span class="agent-pill">Agent · builds &amp; tests in this vBrainstem</span>' +
      '<button id="surg-send">Build</button></div>' +
      '</div>';
    document.body.appendChild(panel);
    els.panel = panel;
    els.log = panel.querySelector("#surg-log");
    els.input = panel.querySelector("#surg-in");
    els.send = panel.querySelector("#surg-send");
    els.model = panel.querySelector("#surg-model");
    panel.querySelector(".x").onclick = toggle;
    els.send.onclick = submit;
    els.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    });
    renderEmpty();
    var starters = [
      "An agent that reverses a string",
      "An agent that tells me a random inspirational quote",
      "What agents do I have?"
    ];
    var sc = panel.querySelector("#surg-starters");
    starters.forEach(function (s) {
      var b = document.createElement("button");
      b.textContent = s;
      b.onclick = function () { els.input.value = s; submit(); };
      sc.appendChild(b);
    });
  }

  function renderEmpty() {
    els.log.innerHTML =
      '<div class="empty">This is the <b>real GitHub Copilot agent loop</b>, side-by-side with your brainstem — ' +
      'the same think→edit→test loop VS Code runs, but here.<br><br>' +
      'Describe an agent and I\'ll write the file into your workspace, <b>hot-load it, and test it live</b> ' +
      'against your brainstem — then it\'s ready in the chat on the left and the ⊕ panel.<br><br>' +
      'Signed in with your GitHub Copilot account.</div>';
  }

  function toggle() {
    build();
    var open = els.panel.classList.toggle("open");
    if (open) { checkAuth(); setTimeout(function () { els.input.focus(); }, 260); }
  }

  function submit() {
    var t = (els.input.value || "").trim();
    if (!t || running) return;
    els.input.value = "";
    els.input.style.height = "auto";
    if (els.log.querySelector(".empty")) els.log.innerHTML = "";
    runTask(t);
  }

  function setBusy(b) {
    if (els.send) { els.send.disabled = b; els.send.textContent = b ? "Working…" : "Build"; }
  }
  function setModel(m) { if (m && els.model) els.model.textContent = "GitHub Copilot · " + m; }

  function addBubble(role, text) {
    var d = document.createElement("div");
    d.className = "b " + role;
    d.innerHTML = (role === "user") ? esc(text) : mdInline(text);
    els.log.appendChild(d);
    els.log.scrollTop = els.log.scrollHeight;
    return d;
  }

  var TOOL_ICON = { list_agents: "📋", read_file: "📄", write_agent: "✏️", delete_agent: "🗑️", test_brainstem: "▶" };
  function addToolChip(name, args) {
    var wrap = document.createElement("div");
    wrap.className = "tool";
    var argStr = name === "write_agent" ? (args.filename || "")
      : name === "read_file" ? (args.path || "")
      : name === "delete_agent" ? (args.filename || "")
      : name === "test_brainstem" ? JSON.stringify(args.message || "")
      : "";
    wrap.innerHTML =
      '<div class="h"><span class="ic">' + (TOOL_ICON[name] || "🔧") + '</span>' +
      '<span class="nm">' + esc(name) + '</span>' +
      '<span class="ar">' + esc(argStr) + '</span>' +
      '<span class="st">…</span></div>' +
      '<div class="body"></div>';
    var head = wrap.querySelector(".h");
    head.onclick = function () { wrap.classList.toggle("open"); };
    els.log.appendChild(wrap);
    els.log.scrollTop = els.log.scrollHeight;
    return {
      done: function (result) {
        wrap.querySelector(".st").textContent = "✓";
        wrap.querySelector(".st").style.color = "#7ee787";
        var body = wrap.querySelector(".body");
        if (name === "test_brainstem") {
          body.textContent = "reply: " + (result.response || result.error || "(none)") +
            (result.agent_logs ? "\n\nagent_logs:\n" + result.agent_logs : "");
        } else if (name === "read_file") {
          body.textContent = (result.content || "").slice(0, 4000);
        } else if (name === "list_agents") {
          body.textContent = (result.files || []).map(function (f) {
            return f.filename + (f.agents && f.agents.length ? "  (" + f.agents.join(", ") + ")" : "");
          }).join("\n");
        } else {
          body.textContent = JSON.stringify(result, null, 2).slice(0, 3000);
        }
      },
      fail: function (err) {
        wrap.querySelector(".st").textContent = "✗";
        wrap.querySelector(".st").style.color = "#ff7b72";
        wrap.classList.add("open");
        wrap.querySelector(".body").textContent = err;
      }
    };
  }

  async function checkAuth() {
    try {
      var r = await VB().local("GET", "/health");
      var h = r.json || {};
      if (h.status !== "ok") {
        addBubble("system", "Sign in with GitHub (top-right of the brainstem) to use the Brain Surgeon — it runs on your Copilot account.");
      }
    } catch (e) {}
  }

  // Boot once the vBrainstem worker is up so tools have a workspace to touch.
  function init() {
    var vb = VB();
    if (!vb || !vb.ready) { setTimeout(init, 400); return; }
    vb.ready.then(build).catch(build);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else { init(); }
})();
