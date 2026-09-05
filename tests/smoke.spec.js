const { test, expect } = require("@playwright/test");
const path = require("path");

const root = path.resolve(__dirname, "..");
const personFile = path.join(root, "samples", "ada", "SKILL.md");
const toolFile = path.join(root, "samples", "tools", "hello-world", "SKILL.md");
const greeting = "Hello, Ada! Welcome to the RAPP Agent ecosystem.";
const memoryFact = "Ada wants her name used in greetings.";

function answer(message, finishReason = "stop") {
  return {
    choices: [{
      message,
      finish_reason: finishReason
    }]
  };
}

test("mobile file, tools, chat, memory, export, routes, and reset", async ({ page }) => {
  const calls = new Map();
  let blockedRequestEscaped = false;
  let privateAccess = false;
  await page.route("https://api.github.com/repos/someone/their-ai-private/contents/vbrainstem/SKILL.md**", async (route) => {
    if (!privateAccess) { await route.fulfill({ status: 404, body: "Not Found" }); return; }
    await route.fulfill({ status: 200, contentType: "text/plain", body: [
      "---", 'name: "vbrainstem"', 'description: "Who Someone is, mainline."', 'license: "MIT"', 'compatibility: "Any."', "metadata:",
      '  id: "rappid:@someone/vbrainstem:' + "b".repeat(64) + '"', '  owner: "Someone"', '  created: "2026-09-04"', '  updated: "2026-09-04"', "---", "",
      "# Someone's vbrainstem", "", "## Who I am", "", "The real Someone, privately.", "", "## My tools", "", "- (none)", "", "## Memory", "", "- 2026-09-04 A private memory.", "", "## Memory (older)", "", "- (nothing yet)", ""].join("\n") });
  });
  const rawInner = ["---", 'name: "sealed-steps"', 'description: "A sealed steps tool."', "---", "", "# Sealed steps", "", "## What it needs", "", "```json", '{"type":"object","properties":{"topic":{"type":"string"}},"required":[]}', "```", "", "## Steps", "", "1. Say the topic back."].join("\n") + "\n";
  const rawHash = require("crypto").createHash("sha256").update(rawInner, "utf8").digest("hex");
  const sealed = ["---", "name: sealed-steps", "description: A sealed steps tool.", "schema: rapp/1-skill", "skill_hash: " + rawHash, "note: |", "  a folded", "  note", "---", "<!-- RAW-SKILL-BEGIN sha256=" + rawHash + " -->", rawInner.replace(/\n$/, ""), "<!-- RAW-SKILL-END -->", ""].join("\n");
  await page.route("https://api.github.com/repos/someone/sealed/contents/sealed_skill.md**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/plain", body: sealed });
  });
  await page.route("https://api.github.com/repos/someone/sealed/contents/broken_skill.md**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/plain", body: sealed.replace("Say the topic back", "Say something else") });
  });
  await page.route("https://api.github.com/user", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ login: "someone" }) });
  });
  await page.route("https://api.github.com/repos/someone/their-ai/contents/their-ai/SKILL.md**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/plain", body: [
      "---", 'name: "their-ai"', 'description: "Their AI, the public face of Someone."', 'license: "MIT"',
      'compatibility: "Any AI that reads skills."', "metadata:", '  id: "rappid:@someone/their-ai-public:' + "a".repeat(64) + '"',
      '  private-repo: "someone/their-ai-private"', '  private-path: "vbrainstem/SKILL.md"',
      '  owner: "Someone"', '  face: "public"', '  created: "2026-09-04"', '  updated: "2026-09-04"', "---", "",
      "# Their AI, public face", "", "## Who Someone is, in public", "", "Someone builds things.", "",
      "## My tools", "", "- (none)", "", "## Memory", "", "- 2026-09-04 Public memory.", "", "## Memory (older)", "", "- (nothing yet)", ""].join("\n") });
  });
  await page.route("https://example.invalid/**", async (route) => {
    blockedRequestEscaped = true;
    await route.abort();
  });

  await page.route("https://api.github.com/copilot_internal/v2/token", async (route) => {
    await route.fulfill({ status: 403, body: "direct exchange unavailable" });
  });

  await page.route("https://rapp-auth.kwildfeuer.workers.dev/api/copilot/token", async (route) => {
    const headers = route.request().headers();
    expect(headers.authorization).toBe("Bearer fake-github-token");
    expect(headers["copilot-integration-id"]).toBeUndefined();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        token: "fake-copilot-token",
        endpoints: { api: "https://api.individual.githubcopilot.com" },
        expires_at: Math.floor(Date.now() / 1000) + 600
      })
    });
  });

  await page.route(
    "https://api.github.com/repos/kody-w/rapp-brainstem/contents/skills/rapp-brainstem/SKILL.md",
    async (route) => {
      await route.fulfill({
        contentType: "text/plain",
        body: "mapped through api.github.com"
      });
    }
  );

  await page.route("https://api.individual.githubcopilot.com/chat/completions", async (route) => {
    const body = route.request().postDataJSON();
    const user = [...body.messages].reverse().find((item) => item.role === "user")?.content || "";
    const count = calls.get(user) || 0;
    calls.set(user, count + 1);

    if (user === "greet me by my name" && count === 0) {
      expect(body.messages[0].content).toContain("I run a small bakery");
      expect(body.tools.map((item) => item.function.name)).toContain("HelloWorldAgent");
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(answer({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "hello-1",
            type: "function",
            function: {
              name: "HelloWorldAgent",
              arguments: JSON.stringify({ name: "Ada" })
            }
          }]
        }, "tool_calls"))
      });
      return;
    }

    if (user === "greet me by my name") {
      const result = body.messages.find((item) =>
        item.role === "tool" && item.name === "HelloWorldAgent");
      expect(result.content).toBe(greeting);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(answer({ role: "assistant", content: result.content }))
      });
      return;
    }

    if (user === "remember that I like personal greetings" && count === 0) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(answer({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "memory-1",
            type: "function",
            function: {
              name: "remember",
              arguments: JSON.stringify({ fact: memoryFact })
            }
          }]
        }, "tool_calls"))
      });
      return;
    }

    if (user === "remember that I like personal greetings") {
      const result = body.messages.find((item) =>
        item.role === "tool" && item.name === "remember");
      expect(result.content).toContain(memoryFact);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(answer({
          role: "assistant",
          content: "I saved that in your file."
        }))
      });
      return;
    }

    if (user === "history envelope") {
      expect(body.messages).toContainEqual({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "past-1",
          type: "function",
          function: { name: "HelloWorldAgent", arguments: "{\"name\":\"Ada\"}" }
        }]
      });
      expect(body.messages).toContainEqual({
        role: "tool",
        content: greeting,
        name: "HelloWorldAgent",
        tool_call_id: "past-1"
      });
    }

    if (user === "use too many tools") {
      if (body.tools) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(answer({
            role: "assistant",
            content: null,
            tool_calls: [{
              id: `exhaust-${count}`,
              type: "function",
              function: { name: "missing_tool", arguments: "{}" }
            }]
          }, "tool_calls"))
        });
      } else {
        await route.fulfill({ status: 500, body: "final answer unavailable" });
      }
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(answer({
        role: "assistant",
        content: "Direct dispatch works."
      }))
    });
  });

  await page.goto("/index.html");
  await page.evaluate(() => localStorage.setItem("github_token", "fake-github-token"));
  await page.reload();
  await expect(page.locator("body")).toHaveCSS("width", "390px");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByText("Signed in (switch account)", { exact: true })).toBeVisible();
  const blocked = await page.evaluate(async () => {
    const fetchBlocked = await fetch("https://example.invalid/private").then(
      () => false,
      () => true
    );
    const imageBlocked = await new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(false);
      image.onerror = () => resolve(true);
      image.src = "https://example.invalid/private.png";
    });
    return fetchBlocked && imageBlocked;
  });
  expect(blocked).toBe(true);
  expect(blockedRequestEscaped).toBe(false);
  const mapped = await page.evaluate(async () => {
    return window.vbrainstem.dispatch(
      "POST",
      "/file/load",
      { url: "https://kody-w.github.io/rapp-brainstem/skills/rapp-brainstem/SKILL.md" }
    );
  });
  expect(mapped).toEqual({
    status: 200,
    json: { content: "mapped through api.github.com" }
  });

  await page.getByRole("button", { name: "Open your file" }).click();
  const dialed = await page.evaluate(() => window.vbrainstem.dispatch("POST", "/file/dial", { url: "their-ai" }));
  expect(dialed.status).toBe(200);
  expect(dialed.json.content).toContain('name: "vbrainstem"');
  expect(dialed.json.content).toContain('grown_from: "rappid:@someone/their-ai-public:');
  expect(dialed.json.content).toMatch(/- \d{4}-\d{2}-\d{2} Assembled from my public AI at https:\/\/raw\.githubusercontent\.com\/someone\/their-ai\/main\/their-ai\/SKILL\.md/);
  expect(dialed.json.content).toMatch(/^## Memory \(older\)/m);
  expect(dialed.json.face).toBe("public");
  privateAccess = true;
  const dialedPrivate = await page.evaluate(() => window.vbrainstem.dispatch("POST", "/file/dial", { url: "their-ai" }));
  expect(dialedPrivate.json.face, "reason: " + dialedPrivate.json.private_reason).toBe("private");
  expect(dialedPrivate.json.content).toContain("The real Someone, privately.");
  expect(dialedPrivate.json.content).not.toContain("grown_from");
  privateAccess = false;

  {
    const mk = (id, updated, who, mem) => ["---", 'name: "vbrainstem"', 'description: "d"', 'license: "MIT"', 'compatibility: "Any."', "metadata:", '  id: "' + id + '"', '  owner: "Ada"', '  created: "2026-09-01"', '  updated: "' + updated + '"', "---", "", "# Ada", "", "## Who I am", "", who, "", "## Memory", "", "Newest first.", "", ...mem, "", "## Memory (older)", "", "- (nothing yet)", ""].join("\n");
    const A = mk("vb-aaaa", "2026-09-03", "Ada, baker.", ["- 2026-09-03 Likes rye.", "- 2026-09-02 Opened at 6."]);
    const B = mk("vb-aaaa", "2026-09-04", "Ada, baker and bookkeeper.", ["- 2026-09-04 Spring menu drafted.", "- 2026-09-02 Opened at 6."]);
    const m1 = await page.evaluate(([a, b]) => window.vbrainstem.dispatch("POST", "/file/merge", { a, b, today: "2026-09-05" }), [A, B]);
    const m2 = await page.evaluate(([a, b]) => window.vbrainstem.dispatch("POST", "/file/merge", { a: b, b: a, today: "2026-09-05" }), [A, B]);
    expect(m1.json.added).toBe(1);
    expect(m1.json.text).toContain("Ada, baker and bookkeeper.");
    expect(m1.json.text).toContain('updated: "2026-09-05"');
    const mem = m1.json.text.split("## Memory\n")[1].split("## Memory (older)")[0].split("\n").filter((l) => l.startsWith("- "));
    expect(mem).toEqual(["- 2026-09-05 Reunited two copies of me: 2 memory line(s) were in only one of them; 1 section(s) differed and the other copy's version is kept under \"Set aside from another copy\".", "- 2026-09-04 Spring menu drafted.", "- 2026-09-03 Likes rye.", "- 2026-09-02 Opened at 6."]);
    expect(m1.json.text).toContain("## Set aside from another copy");
    expect(m1.json.text).toContain("Ada, baker.");
    const memLines = (t) => t.split("## Memory\n")[1].split("## Memory (older)")[0].split("\n").filter((l) => l.startsWith("- ") && !l.includes("Reunited"));
    expect(memLines(m2.json.text)).toEqual(memLines(m1.json.text));
  }

  await page.setInputFiles("#person-file", personFile);
  await expect(page.getByText("Your file is ready.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close your file" }).click();

  await page.getByRole("button", { name: "Open your tools" }).click();
  await page.setInputFiles("#tool-file", toolFile);
  const sealedOk = await page.evaluate(async () => {
    const loaded = await window.vbrainstem.dispatch("POST", "/tools/load", { url: "https://raw.githubusercontent.com/someone/sealed/main/sealed_skill.md" });
    return loaded.status;
  });
  expect(sealedOk).toBe(200);
  await page.locator("#tool-url").fill("https://raw.githubusercontent.com/someone/sealed/main/sealed_skill.md");
  await page.locator("#load-tool-url").click();
  await expect.poll(async () => (await page.evaluate(() => window.vbrainstem.dispatch("GET", "/health"))).json.agents).toContain("sealed_steps");
  await page.locator("#tool-url").fill("https://raw.githubusercontent.com/someone/sealed/main/broken_skill.md");
  await page.locator("#load-tool-url").click();
  await expect(page.locator("#tool-message")).toContainText("seal does not match");
  await expect(page.locator("#tool-list")).toContainText("hello-world");
  await page.getByRole("button", { name: "Close your tools" }).click();

  await page.locator("#message").fill("greet me by my name");
  await page.locator("#composer").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#transcript")).toContainText(greeting, { timeout: 90000 });

  await page.locator("#message").fill("remember that I like personal greetings");
  await page.locator("#composer").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#transcript")).toContainText("I saved that in your file.");

  const datedMemory = await page.evaluate((fact) => {
    const file = localStorage.getItem("vbrainstem.file");
    const now = new Date();
    const date = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0")
    ].join("-");
    const line = `- ${date} ${fact}`;
    const memory = file.match(/^## Memory\s*\n([\s\S]*?)(?=^## )/m)?.[1] || "";
    return {
      file,
      line,
      firstLine: memory.split("\n").find((value) => value.startsWith("- "))
    };
  }, memoryFact);
  expect(datedMemory.firstLine).toBe(datedMemory.line);

  await page.getByRole("button", { name: "Open your file" }).click();
  const editorText = await page.locator("#file-editor").inputValue();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("vbrainstem-SKILL.md");
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const exported = Buffer.concat(chunks).toString("utf8");
  expect(exported).toBe(editorText);
  expect(exported).toContain(datedMemory.line);
  await page.getByRole("button", { name: "Close your file" }).click();

  const routeChecks = await page.evaluate(async () => {
    const health = await window.vbrainstem.dispatch("GET", "/health");
    const chat = await window.vbrainstem.dispatch("POST", "/chat", {
      user_input: "direct envelope",
      conversation_history: [],
      session_id: "direct-session"
    });
    const publicHealth = await window.vbrainstem.dispatch("GET", "/health/public");
    const agents = await window.vbrainstem.dispatch("GET", "/agents");
    const history = await window.vbrainstem.dispatch("POST", "/chat", {
      user_input: "history envelope",
      conversation_history: [{
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "past-1",
          type: "function",
          function: { name: "HelloWorldAgent", arguments: "{\"name\":\"Ada\"}" }
        }]
      }, {
        role: "tool",
        content: "Hello, Ada! Welcome to the RAPP Agent ecosystem.",
        name: "HelloWorldAgent",
        tool_call_id: "past-1"
      }]
    });
    const exhausted = await window.vbrainstem.dispatch("POST", "/chat", {
      user_input: "use too many tools",
      conversation_history: []
    });
    return { health, chat, publicHealth, agents, history, exhausted };
  });
  expect(routeChecks.health).toMatchObject({
    status: 200,
    json: {
      status: "ok",
      soul: "loaded"
    }
  });
  expect(routeChecks.chat).toMatchObject({
    status: 200,
    json: {
      response: "Direct dispatch works.",
      agent_logs: "",
      session_id: "direct-session",
      voice_mode: false,
      model: "gpt-4o",
      requested_model: "gpt-4o"
    }
  });
  // exactly the kernel's six keys, no more and no fewer
  expect(Object.keys(routeChecks.chat.json).sort()).toEqual(["agent_logs", "model", "requested_model", "response", "session_id", "voice_mode"]);
  expect(routeChecks.publicHealth).toMatchObject({
    status: 200,
    json: { status: "ok" }
  });
  expect(routeChecks.agents.status).toBe(200);
  expect(routeChecks.agents.json.files[0].agents).toContain("HelloWorldAgent");
  expect(routeChecks.history.json.response).toBe("Direct dispatch works.");
  expect(routeChecks.exhausted.json.response).toBe(
    "I could not finish that in the available steps. Try breaking it into a smaller request."
  );

  await page.getByRole("button", { name: "Open about" }).click();
  await page.getByRole("button", { name: "Forget everything on this device" }).click();
  await page.waitForLoadState("domcontentloaded");
  await expect.poll(() => page.evaluate(() => localStorage.length)).toBe(0);
});


test("review fixes: multi-line tools, rejected token, visible dial outcomes, forget on a front-door link", async ({ page }) => {
  // review-fixes
  const tool = (name) => ["---", 'name: "' + name + '"', 'description: "Tool ' + name + '."', "---", "", "# " + name, "", "## What it needs", "", "```json", '{"type":"object","properties":{},"required":[]}', "```", "", "## Steps", "", "1. Say hello."].join("\n") + "\n";
  const hits = { t1: 0, t2: 0, face: 0 };
  await page.route("https://raw.githubusercontent.com/someone/tools/main/t1/SKILL.md", async (route) => { hits.t1++; await route.fulfill({ status: 200, contentType: "text/plain", body: tool("tool-one") }); });
  await page.route("https://raw.githubusercontent.com/someone/tools/main/t2/SKILL.md", async (route) => { hits.t2++; await route.fulfill({ status: 200, contentType: "text/plain", body: tool("tool-two") }); });
  const face = ["---", 'name: "their-ai"', 'description: "Their AI, the public face of Someone."', 'license: "MIT"', 'compatibility: "Any."', "metadata:", '  id: "rappid:@someone/their-ai-public:' + "c".repeat(64) + '"', '  owner: "Someone"', '  face: "public"', '  created: "2026-09-04"', '  updated: "2026-09-04"', "---", "",
    "# Their AI, public face", "", "## My tools", "", "Callable tools, by link. Load what is listed; offer nothing that is not.", "", "- The first: https://raw.githubusercontent.com/someone/tools/main/t1/SKILL.md", "- The second: https://raw.githubusercontent.com/someone/tools/main/t2/SKILL.md", "- A broken one: https://raw.githubusercontent.com/someone/tools/main/missing/SKILL.md", "",
    "## My sources", "", "Not tools. https://raw.githubusercontent.com/someone/tools/main/never/SKILL.md", "", "## Memory", "", "- 2026-09-04 Public memory.", "", "## Memory (older)", "", "- (nothing yet)", ""].join("\n");
  await page.route("https://raw.githubusercontent.com/someone/their-ai/main/their-ai/SKILL.md", async (route) => { hits.face++; await route.fulfill({ status: 200, contentType: "text/plain", body: face }); });
  await page.route("https://raw.githubusercontent.com/someone/tools/main/missing/SKILL.md", (route) => route.fulfill({ status: 404, body: "no" }));
  await page.route("https://raw.githubusercontent.com/someone/tools/main/never/SKILL.md", (route) => route.fulfill({ status: 200, body: tool("never") }));
  // A stored token GitHub rejects must not lock the page.
  await page.route("https://api.github.com/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Bad credentials" }) }));
  await page.route("https://rapp-auth.kwildfeuer.workers.dev/**", (route) => route.fulfill({ status: 401, body: "no" }));

  await page.goto("/index.html");
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("github_token", "rejected-token"); });
  await page.goto("/index.html?dial=someone/their-ai");
  await expect.poll(() => page.evaluate(() => (localStorage.getItem("vbrainstem.file") || "").length), { timeout: 15000 }).toBeGreaterThan(0);
  await expect.poll(() => hits.t1 + hits.t2, { timeout: 15000 }).toBe(2);
  expect((await page.evaluate(() => window.vbrainstem.dispatch("GET", "/agents"))).json.files.map((f) => f.agents).flat().sort()).toEqual(["tool_one", "tool_two"]);
  // the dial outcome is visible on the main surface, and the failed tool is reported, not hidden
  await expect(page.locator("#file-message")).toContainText("could not be loaded");
  await expect(page.locator("body")).toContainText("Your AI is here");
  // opening the front-door link again with the same AI present reunites instead of asking to forget
  await page.goto("/index.html?dial=someone/their-ai");
  await expect(page.locator("main, .transcript, #transcript").first()).toContainText("Reunited with the copy on this device");
  await expect(page.locator("#file-sheet")).toBeHidden();
  // forget on the front-door link must not re-dial
  const before = hits.face;
  await page.locator('[data-open="about"]').first().click();
  await page.locator("#forget").click();
  await page.waitForURL((u) => !u.search.includes("dial"), { timeout: 10000 });
  await page.waitForTimeout(1500);
  expect(hits.face).toBe(before);
  expect(await page.evaluate(() => localStorage.getItem("vbrainstem.file"))).toBeNull();
});


test("round-two fixes: tool selection by name, reunion keeps identity and differences, dial shows the reunion", async ({ page }) => {
  // round-two fixes
  const twoClasses = [
    "from agents.basic_agent import BasicAgent", "",
    "class FirstAgent(BasicAgent):", "    def __init__(self):", "        self.name = 'FirstAgent'",
    "        self.metadata = {'name': self.name, 'description': 'first', 'parameters': {'type': 'object', 'properties': {}, 'required': []}}",
    "        super().__init__(self.name, self.metadata)", "    def perform(self, **kwargs):", "        return 'RESULT-FROM-FIRST'", "",
    "class SecondAgent(BasicAgent):", "    def __init__(self):", "        self.name = 'SecondAgent'",
    "        self.metadata = {'name': self.name, 'description': 'second', 'parameters': {'type': 'object', 'properties': {}, 'required': []}}",
    "        super().__init__(self.name, self.metadata)", "    def perform(self, **kwargs):", "        return 'RESULT-FROM-SECOND'", ""].join("\n");
  const sha = require("crypto").createHash("sha256").update(twoClasses, "utf8").digest("hex");
  const skillFor = (toolName) => ["---", 'name: "' + toolName.toLowerCase().replace("agent", "") + '"', 'description: "Two classes in one file."', "metadata:", '  tool-name: "' + toolName + '"', '  agent-sha256: "' + sha + '"', "---", "",
    "# Pair", "", "## What it needs", "", "```json", '{"type":"object","properties":{},"required":[]}', "```", "", "## The code", "",
    "<!-- agent sha256=" + sha + " -->", "```python", twoClasses.replace(/\n$/, ""), "```", "<!-- /agent -->", ""].join("\n");
  await page.route("https://raw.githubusercontent.com/someone/pair/main/first/SKILL.md", (r) => r.fulfill({ status: 200, body: skillFor("FirstAgent") }));
  await page.route("https://raw.githubusercontent.com/someone/pair/main/nosuch/SKILL.md", (r) => r.fulfill({ status: 200, body: skillFor("NoSuchAgent") }));
  await page.route("https://rapp-auth.kwildfeuer.workers.dev/api/copilot/token", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "fake-copilot-token", expires_at: Math.floor(Date.now() / 1000) + 3600, endpoints: { api: "https://api.individual.githubcopilot.com" } }) }));
  await page.route("https://api.github.com/copilot_internal/v2/token", (r) => r.fulfill({ status: 403, body: "no" }));
  await page.route("https://api.individual.githubcopilot.com/models", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [{ id: "gpt-4o", model_picker_enabled: true, capabilities: { type: "chat" } }] }) }));
  let turn = 0; let wanted = "FirstAgent"; const toolMessages = [];
  await page.route("https://api.individual.githubcopilot.com/chat/completions", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    const tm = body.messages.filter((m) => m.role === "tool"); toolMessages.push(...tm);
    turn += 1;
    if (tm.length === 0) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: wanted, arguments: "{}" } }] } }] }) });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done: " + tm[tm.length - 1].content } }] }) });
    }
  });
  const person = ["---", 'name: "vbrainstem"', 'description: "d"', 'license: "MIT"', 'compatibility: "Any."', "metadata:", '  id: "vb-pair"', '  owner: "Ada"', '  created: "2026-09-04"', '  updated: "2026-09-04"', "---", "", "# Ada", "", "## My tools", "", "- (none)", "", "## Memory", "", "- 2026-09-04 x", "", "## Memory (older)", "", "- (nothing yet)", ""].join("\n");
  await page.goto("/index.html");
  await page.evaluate((p) => { localStorage.clear(); localStorage.setItem("github_token", "fake-github-token"); localStorage.setItem("vbrainstem.file", p); }, person);
  await page.reload();
  expect((await page.evaluate(() => window.vbrainstem.dispatch("POST", "/tools/load", { url: "https://raw.githubusercontent.com/someone/pair/main/first/SKILL.md" }))).status).toBe(200);
  await page.locator('[data-open="tools"]').first().click();
  await page.locator("#tool-url").fill("https://raw.githubusercontent.com/someone/pair/main/first/SKILL.md");
  await page.locator("#load-tool-url").click();
  await expect(page.locator("#tool-message")).toContainText("ready");
  await page.locator("#tools-sheet [data-close]").click();
  const chat = await page.evaluate(() => window.vbrainstem.dispatch("POST", "/chat", { user_input: "run first", conversation_history: [] }));
  expect(chat.json.agent_logs).toBe("[FirstAgent] RESULT-FROM-FIRST");
  // a tool name that matches no class in the file is an error, never a silent pick
  wanted = "NoSuchAgent";
  await page.locator('[data-open="tools"]').first().click();
  await page.locator("#tool-url").fill("https://raw.githubusercontent.com/someone/pair/main/nosuch/SKILL.md");
  await page.locator("#load-tool-url").click();
  await expect(page.locator("#tool-message")).toContainText("ready");
  await page.locator("#tools-sheet [data-close]").click();
  const chat2 = await page.evaluate(() => window.vbrainstem.dispatch("POST", "/chat", { user_input: "run nosuch", conversation_history: [] }));
  expect(chat2.json.agent_logs).toMatch(/^\[NoSuchAgent\] ERROR:/);
  expect(chat2.json.agent_logs).not.toContain("RESULT-FROM");

  // reunion: same-date copies decide by content, not argument order; differing sections are set aside, not dropped
  const mk = (id, extra, who, mem) => ["---", 'name: "vbrainstem"', 'description: "d"', 'license: "MIT"', 'compatibility: "Any."', "metadata:", '  id: "' + id + '"', ...extra, '  owner: "Ada"', '  created: "2026-09-01"', '  updated: "2026-09-04"', "---", "", "# Ada", "", "## Who I am", "", who, "", "## Memory", "", ...mem, "", "## Memory (older)", "", "- (nothing yet)", ""].join("\n");
  const main = mk("vb-main", [], "Ada, baker.", ["- 2026-09-04 Main memory."]);
  const dim = mk("vb-dim", ['  grown_from: "pub-1"', '  mainline-id: "vb-main"'], "Ada, baker and bookkeeper.", ["- 2026-09-04 Phone memory."]);
  const m1 = await page.evaluate(([a, b]) => window.vbrainstem.dispatch("POST", "/file/merge", { a, b, today: "2026-09-05" }), [main, dim]);
  const m2 = await page.evaluate(([a, b]) => window.vbrainstem.dispatch("POST", "/file/merge", { a, b, today: "2026-09-05" }), [dim, main]);
  expect(m1.json.text).toBe(m2.json.text);
  expect(m1.json.text).toContain("Ada, baker.");
  expect(m1.json.text).toContain("## Set aside from another copy");
  expect(m1.json.text).toContain("Ada, baker and bookkeeper.");
  expect(m1.json.text).toContain("- 2026-09-04 Phone memory.");
  expect(m1.json.text).toContain("- 2026-09-04 Main memory.");
  expect(m1.json.text).toMatch(/\n## Memory \(older\)\n/);

  // an assembled public dimension carries the mainline id, so a later private dial reunites instead of replacing
  const publicFace = ["---", 'name: "their-ai"', 'description: "Public face."', 'license: "MIT"', 'compatibility: "Any."', "metadata:", '  id: "pub-2"', '  owner: "Ada"', '  mainline-id: "vb-main2"', '  private-repo: "someone/their-ai-private"', '  private-path: "vbrainstem/SKILL.md"', '  created: "2026-09-04"', '  updated: "2026-09-04"', "---", "", "# Their AI", "", "## Who I am", "", "Ada, in public.", "", "## My tools", "", "- (none)", "", "## Memory", "", "- 2026-09-04 Public memory.", "", "## Memory (older)", "", "- (nothing yet)", ""].join("\n");
  const privateFile = mk("vb-main2", [], "Ada, privately.", ["- 2026-09-04 Private memory."]);
  await page.route("https://raw.githubusercontent.com/someone/their-ai2/main/their-ai2/SKILL.md", (r) => r.fulfill({ status: 200, body: publicFace }));
  await page.route("https://api.github.com/repos/someone/their-ai-private/contents/vbrainstem/SKILL.md**", (r) => r.fulfill({ status: 200, contentType: "text/plain", body: privateFile }));
  await page.evaluate(() => { localStorage.removeItem("vbrainstem.file"); });
  await page.reload();
  await page.locator('[data-open="file"]').first().click();
  await page.locator('#dial-face input[value="public"]').check();
  await page.locator("#dial-url").fill("https://github.com/someone/their-ai2");
  await page.locator("#dial-public").click();
  await expect(page.locator("#file-message")).toContainText("new copy on this device");
  expect(await page.evaluate(() => localStorage.getItem("vbrainstem.file"))).toContain('mainline-id: "vb-main2"');
  // the phone learns something
  await page.evaluate(() => { const f = localStorage.getItem("vbrainstem.file"); localStorage.setItem("vbrainstem.file", f.replace("## Memory\n", "## Memory\n\n- 2026-09-05 Learned on the phone.\n")); });
  await page.locator('#dial-face input[value="private"]').check();
  await page.locator("#dial-url").fill("https://github.com/someone/their-ai2");
  await page.locator("#dial-public").click();
  await expect(page.locator("#file-message")).toContainText("Reunited with the copy on this device");
  const after = await page.evaluate(() => localStorage.getItem("vbrainstem.file"));
  expect(after).toContain("- 2026-09-05 Learned on the phone.");
  expect(after).toContain("- 2026-09-04 Private memory.");
  expect(after).toContain("Ada, privately.");
});


test("round-three fixes: reunion authority by identity, idempotent set-aside, wrapped memory, runtime retry, sign-in recovers, a file of your own", async ({ page }) => {
  // round-three fixes
  await page.goto("/index.html");
  await page.evaluate(() => localStorage.clear());
  const mk = (id, extra, updated, who, mem) => ["---", 'name: "vbrainstem"', 'description: "d"', 'license: "MIT"', 'compatibility: "Any."', "metadata:", '  id: "' + id + '"', ...extra, '  owner: "Ada"', '  created: "2026-08-01"', '  updated: "' + updated + '"', "---", "", "# Ada", "", "## Who I am", "", who, "", "## Memory", "", ...mem, "", "## Memory (older)", "", "- (nothing yet)", ""].join("\n");
  const merge = (a, b) => page.evaluate(([x, y]) => window.vbrainstem.dispatch("POST", "/file/merge", { a: x, b: y, today: "2026-09-06" }), [a, b]);

  // 1. the mainline keeps its identity and its sections even when the dimension was written more recently
  const mainline = mk("vb-main", [], "2026-09-01", "Ada, baker.", ["- 2026-09-01 Main memory."]);
  const dimension = mk("vb-dim", ['  grown_from: "pub-1"', '  mainline-id: "vb-main"', '  face: "dimension"'], "2026-09-05", "Ada, baker and bookkeeper.", ["- 2026-09-05 Phone memory."]);
  const ab = await merge(mainline, dimension);
  const ba = await merge(dimension, mainline);
  expect(ab.json.text).toBe(ba.json.text);
  const head = ab.json.text.split("\n---\n")[0];
  expect(head).toContain('id: "vb-main"');
  expect(head).not.toContain("face:");
  expect(head).not.toContain("grown_from");
  expect(head).toContain('updated: "2026-09-06"');
  expect(ab.json.text).toMatch(/## Who I am\n\nAda, baker\.\n/);
  expect(ab.json.text).toContain("### Who I am\n\nAda, baker and bookkeeper.");
  expect(ab.json.text).toContain("- 2026-09-05 Phone memory.");
  expect(ab.json.text).toContain("- 2026-09-01 Main memory.");
  expect(ab.json.text.match(/Reunited two copies of me/g).length).toBe(1);
  expect(ab.json.added).toBe(1);
  expect(ba.json.added).toBe(1);

  // 2. meeting the same copy again changes nothing: one set-aside section, one note, same bytes
  const again = await merge(ab.json.text, dimension);
  expect(again.json.text).toBe(ab.json.text);
  const reversed = await merge(dimension, ab.json.text);
  expect(reversed.json.text).toBe(ab.json.text);
  expect(again.json.text.match(/## Set aside from another copy/g).length).toBe(1);
  expect(again.json.added).toBe(0);

  // 3. a memory entry that wraps onto an indented line stays one entry through a reunion and an append
  const wrapped = mk("vb-w1", [], "2026-09-02", "Ada.", ["- 2026-09-02 A long memory that", "  wraps onto a second line."]);
  const other = mk("vb-w2", ['  grown_from: "vb-w1"', '  mainline-id: "vb-w1"'], "2026-09-03", "Ada.", ["- 2026-09-03 Short."]);
  const w = await merge(wrapped, other);
  expect(w.json.text).toContain("- 2026-09-02 A long memory that wraps onto a second line.");
  expect(w.json.text).not.toMatch(/\n  wraps onto/);
  await page.evaluate((f) => localStorage.setItem("vbrainstem.file", f), wrapped);
  await page.reload();
  const wrappedAppend = await page.evaluate(() => { localStorage.setItem("github_token", "fake-github-token"); return true; });
  expect(wrappedAppend).toBe(true);

  // 4. a failed tool-runtime load is retried on the next call instead of being remembered forever
  const oneClass = ["from agents.basic_agent import BasicAgent", "", "class RetryAgent(BasicAgent):", "    def __init__(self):", "        self.name = 'RetryAgent'",
    "        self.metadata = {'name': self.name, 'description': 'retry', 'parameters': {'type': 'object', 'properties': {}, 'required': []}}",
    "        super().__init__(self.name, self.metadata)", "    def perform(self, **kwargs):", "        return 'RESULT-AFTER-RETRY'", ""].join("\n");
  const sha = require("crypto").createHash("sha256").update(oneClass, "utf8").digest("hex");
  const skill = ["---", 'name: "retry"', 'description: "One class."', "metadata:", '  tool-name: "RetryAgent"', '  agent-sha256: "' + sha + '"', "---", "", "# Retry", "", "## What it needs", "", "```json", '{"type":"object","properties":{},"required":[]}', "```", "", "## The code", "", "<!-- agent sha256=" + sha + " -->", "```python", oneClass.replace(/\n$/, ""), "```", "<!-- /agent -->", ""].join("\n");
  await page.route("https://raw.githubusercontent.com/someone/retry/main/retry/SKILL.md", (r) => r.fulfill({ status: 200, body: skill }));
  await page.route("https://rapp-auth.kwildfeuer.workers.dev/api/copilot/token", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "fake-copilot-token", expires_at: Math.floor(Date.now() / 1000) + 3600, endpoints: { api: "https://api.individual.githubcopilot.com" } }) }));
  await page.route("https://api.github.com/copilot_internal/v2/token", (r) => r.fulfill({ status: 403, body: "no" }));
  await page.route("https://api.individual.githubcopilot.com/models", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [{ id: "gpt-4o", model_picker_enabled: true, capabilities: { type: "chat" } }] }) }));
  let rememberOnce = true;
  await page.route("https://api.individual.githubcopilot.com/chat/completions", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    const tm = body.messages.filter((m) => m.role === "tool");
    if (rememberOnce && tm.length === 0) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "r1", type: "function", function: { name: "remember", arguments: JSON.stringify({ fact: "Ada likes short lines." }) } }] } }] }) });
      return;
    }
    if (rememberOnce) {
      rememberOnce = false;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "saved" } }] }) });
      return;
    }
    await route.abort("failed");
  });
  await page.reload();
  const remembered = await page.evaluate(() => window.vbrainstem.dispatch("POST", "/chat", { user_input: "remember this", conversation_history: [] }));
  expect(remembered.json.agent_logs).toContain("[remember]");
  const afterAppend = await page.evaluate(() => localStorage.getItem("vbrainstem.file"));
  expect(afterAppend).toContain("- 2026-09-02 A long memory that wraps onto a second line.");
  expect(afterAppend).not.toMatch(/\n  wraps onto/);
  expect(afterAppend).toMatch(/- \d{4}-\d{2}-\d{2} Ada likes short lines\./);
  await page.unroute("https://api.individual.githubcopilot.com/chat/completions");
  await page.route("https://api.individual.githubcopilot.com/chat/completions", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    const tm = body.messages.filter((m) => m.role === "tool");
    if (tm.length === 0) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "RetryAgent", arguments: "{}" } }] } }] }) });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done: " + tm[tm.length - 1].content } }] }) });
    }
  });
  let pyodideLoads = 0;
  await page.route("https://cdn.jsdelivr.net/pyodide/**/pyodide.js", async (route) => {
    pyodideLoads += 1;
    if (pyodideLoads === 1) { await route.abort("failed"); return; }
    await route.continue();
  });
  await page.evaluate(() => { localStorage.setItem("github_token", "fake-github-token"); });
  await page.reload();
  await page.locator('[data-open="tools"]').first().click();
  await page.locator("#tool-url").fill("https://raw.githubusercontent.com/someone/retry/main/retry/SKILL.md");
  await page.locator("#load-tool-url").click();
  await expect(page.locator("#tool-message")).toContainText("ready");
  await page.locator("#tools-sheet [data-close]").click();
  const first = await page.evaluate(() => window.vbrainstem.dispatch("POST", "/chat", { user_input: "run", conversation_history: [] }));
  expect(first.json.agent_logs).toMatch(/^\[RetryAgent\] ERROR:/);
  const second = await page.evaluate(() => window.vbrainstem.dispatch("POST", "/chat", { user_input: "run", conversation_history: [] }));
  expect(second.json.agent_logs).toBe("[RetryAgent] RESULT-AFTER-RETRY");
  expect(pyodideLoads).toBe(2);

  // 5. a refused sign-in offers a new code, and reopening the sheet never shows a dead end
  await page.evaluate(() => { localStorage.removeItem("github_token"); });
  await page.route("https://rapp-auth.kwildfeuer.workers.dev/api/auth/device", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ device_code: "dc", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 }) }));
  await page.route("https://rapp-auth.kwildfeuer.workers.dev/api/auth/device/poll", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ error: "access_denied" }) }));
  await page.reload();
  await page.locator("#sign-in-shortcut").click();
  await expect(page.locator("#sign-in-start")).toBeVisible();
  await page.locator("#start-sign-in").click();
  await expect(page.locator("#device-code")).toHaveText("ABCD-EFGH");
  await expect(page.locator("#sign-in-message")).toContainText("Get a new code", { timeout: 10000 });
  await expect(page.locator("#sign-in-start")).toBeVisible();
  await expect(page.locator("#sign-in-code")).toBeHidden();
  await page.locator("#sign-in-sheet [data-close]").click();
  await page.locator("#sign-in-shortcut").click();
  await expect(page.locator("#sign-in-start")).toBeVisible();
  await expect(page.locator("#start-sign-in")).toBeEnabled();

  // 6. someone without a file is told where to get one, on the file sheet and the about sheet
  const setupLink = 'a[href="https://raw.githubusercontent.com/kody-w/vbrainstem/main/vbrainstem-setup/SKILL.md"]';
  expect(await page.locator("#file-sheet " + setupLink).count()).toBe(1);
  expect(await page.locator("#about-sheet " + setupLink).count()).toBe(1);
});


test("round-four fixes: a sign-in GitHub rejects is dropped, the sheet reopens, and the shortcut is never dead", async ({ page }) => {
  // round-four fixes
  const person = ["---", 'name: "vbrainstem"', 'description: "d"', 'license: "MIT"', 'compatibility: "Any."', "metadata:", '  id: "vb-r4"', '  owner: "Ada"', '  created: "2026-09-04"', '  updated: "2026-09-04"', "---", "", "# Ada", "", "## My tools", "", "- (none)", "", "## Memory", "", "- 2026-09-04 x", "", "## Memory (older)", "", "- (nothing yet)", ""].join("\n");
  let completions = 0;
  await page.route("https://api.github.com/copilot_internal/v2/token", (r) => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "Bad credentials" }) }));
  await page.route("https://rapp-auth.kwildfeuer.workers.dev/api/copilot/token", (r) => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "bad token" }) }));
  await page.route("https://api.individual.githubcopilot.com/**", (r) => { completions += 1; r.fulfill({ status: 500, body: "never" }); });
  await page.goto("/index.html");
  await page.evaluate((p) => { localStorage.clear(); localStorage.setItem("github_token", "revoked-token"); localStorage.setItem("brainstem_token", "revoked-alias"); localStorage.setItem("vbrainstem.file", p); }, person);
  await page.reload();
  // before: a token is stored, so the shortcut reads signed in, but it must still open the sheet
  await expect(page.locator("#sign-in-shortcut")).toBeEnabled();
  await page.locator("#message").fill("hello");
  await page.locator("#composer").evaluate((form) => form.requestSubmit());
  await expect(page.locator("#sign-in-sheet")).toBeVisible();
  await expect(page.locator("#sign-in-start")).toBeVisible();
  expect(completions).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem("github_token"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("brainstem_token"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("vbrainstem.file"))).toContain("# Ada");
  await expect(page.locator(".transcript, #transcript, main").first()).toContainText("Get a new code");
  const status = await page.evaluate(() => window.vbrainstem.dispatch("GET", "/login/status"));
  expect(status.json.authenticated).toBe(false);
  await expect(page.locator("#sign-in-shortcut")).toHaveText("Sign in with GitHub");
  await expect(page.locator("#sign-in-shortcut")).toBeEnabled();
  // the chat route itself reports the rejection with its code, like a 401 from a server
  await page.evaluate(() => localStorage.setItem("github_token", "revoked-again"));
  const direct = await page.evaluate(() => window.vbrainstem.dispatch("POST", "/chat", { user_input: "hi", conversation_history: [] }));
  expect(direct.status).toBe(401);
  expect(direct.json.code).toBe("signin_rejected");
  expect(await page.evaluate(() => localStorage.getItem("github_token"))).toBeNull();
  // a signed-in person can still reach the sheet to switch accounts
  await page.evaluate(() => localStorage.setItem("github_token", "some-token"));
  await page.reload();
  await expect(page.locator("#sign-in-shortcut")).toBeEnabled();
  await page.locator("#sign-in-shortcut").click();
  await expect(page.locator("#sign-in-sheet")).toBeVisible();
});


test("round-four fixes, part two: set-aside stays visible to the AI, seals decide by their sha, other default branches, link reunion, start a file here", async ({ page }) => {
  // round-four fixes (hand-verified findings)
  const mk = (id, extra, updated, who, mem, tail = []) => ["---", 'name: "vbrainstem"', 'description: "d"', 'license: "MIT"', 'compatibility: "Any."', "metadata:", '  id: "' + id + '"', ...extra, '  owner: "Ada"', '  created: "2026-08-01"', '  updated: "' + updated + '"', "---", "", "# Ada", "", "## Who I am", "", who, "", "## Memory", "", ...mem, "", "## Memory (older)", "", "- (nothing yet)", ...tail, ""].join("\n");
  await page.goto("/index.html");
  await page.evaluate(() => localStorage.clear());

  // 1. what the AI reads keeps every section after the older memory, and only drops the older memory itself
  const withAside = mk("vb-a", [], "2026-09-01", "Ada, baker.", ["- 2026-09-01 x"], ["", "## Set aside from another copy", "", "### Who I am", "", "Ada, baker and bookkeeper."]);
  const seen = await page.evaluate((f) => { localStorage.setItem("vbrainstem.file", f); return null; }, withAside);
  expect(seen).toBeNull();
  await page.route("https://rapp-auth.kwildfeuer.workers.dev/api/copilot/token", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "fake-copilot-token", expires_at: Math.floor(Date.now() / 1000) + 3600, endpoints: { api: "https://api.individual.githubcopilot.com" } }) }));
  await page.route("https://api.github.com/copilot_internal/v2/token", (r) => r.fulfill({ status: 403, body: "no" }));
  await page.route("https://api.individual.githubcopilot.com/models", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [{ id: "gpt-4o", model_picker_enabled: true, capabilities: { type: "chat" } }] }) }));
  let systemPrompt = "";
  await page.route("https://api.individual.githubcopilot.com/chat/completions", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    systemPrompt = body.messages[0].content;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }] }) });
  });
  await page.evaluate(() => localStorage.setItem("github_token", "fake-github-token"));
  await page.reload();
  await page.evaluate(() => window.vbrainstem.dispatch("POST", "/chat", { user_input: "hi", conversation_history: [] }));
  expect(systemPrompt).toContain("Ada, baker and bookkeeper.");
  expect(systemPrompt).toContain("## Set aside from another copy");
  expect(systemPrompt).not.toContain("## Memory (older)");

  // 2. a sealed tool whose text contains an end-marker line loads when its seal matches
  const innerText = ["---", 'name: "sealed-doc"', 'description: "Documents sealing."', "---", "", "# Sealed doc", "", "## What it needs", "", "```json", '{"type":"object","properties":{},"required":[]}', "```", "", "## Steps", "", "A seal ends with this line:", "", "<!-- RAW-SKILL-END -->", "", "and nothing after it counts."].join("\n") + "\n";
  const innerHash = require("crypto").createHash("sha256").update(innerText, "utf8").digest("hex");
  const sealedDoc = "---\nname: sealed-doc\nschema: rapp/1-skill\nskill_hash: " + innerHash + "\n---\n<!-- RAW-SKILL-BEGIN sha256=" + innerHash + " -->\n" + innerText + "<!-- RAW-SKILL-END -->\n";
  await page.route("https://raw.githubusercontent.com/someone/sealed/main/doc/SKILL.md", (r) => r.fulfill({ status: 200, body: sealedDoc }));
  await page.locator('[data-open="tools"]').first().click();
  await page.locator("#tool-url").fill("https://raw.githubusercontent.com/someone/sealed/main/doc/SKILL.md");
  await page.locator("#load-tool-url").click();
  await expect(page.locator("#tool-message")).toContainText("ready");
  await expect(page.locator("#tool-list")).toContainText("sealed-doc");
  expect(await page.evaluate(() => localStorage.getItem("vbrainstem.tools") || "")).toContain("and nothing after it counts");
  await page.locator("#tools-sheet [data-close]").click();

  // 3. a front door on a repository whose default branch is not main is still reached
  const face = ["---", 'name: "trunk-ai"', 'description: "Public face."', 'license: "MIT"', 'compatibility: "Any."', "metadata:", '  id: "pub-trunk"', '  owner: "Ada"', '  created: "2026-09-04"', '  updated: "2026-09-04"', "---", "", "# Trunk AI", "", "## Who I am", "", "Ada, on trunk.", "", "## My tools", "", "- (none)", "", "## Memory", "", "- 2026-09-04 On trunk.", "", "## Memory (older)", "", "- (nothing yet)", ""].join("\n");
  await page.route("https://raw.githubusercontent.com/someone/trunk-ai/main/trunk-ai/SKILL.md", (r) => r.fulfill({ status: 404, body: "404: Not Found" }));
  await page.route("https://api.github.com/repos/someone/trunk-ai/contents/trunk-ai/SKILL.md?ref=main", (r) => r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "Not Found" }) }));
  await page.route("https://api.github.com/repos/someone/trunk-ai", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ default_branch: "trunk" }) }));
  await page.route("https://api.github.com/repos/someone/trunk-ai/contents/trunk-ai/SKILL.md?ref=trunk", (r) => r.fulfill({ status: 200, contentType: "text/plain", body: face }));
  const dialed = await page.evaluate(() => window.vbrainstem.dispatch("POST", "/file/dial", { url: "https://github.com/someone/trunk-ai", face: "public" }));
  expect(dialed.status).toBe(200);
  expect(dialed.json.content).toContain("Ada, on trunk.");

  // 4. a front-door link opened with the same AI already here reunites, and the link does not dial again on reload
  await page.evaluate(() => { localStorage.removeItem("vbrainstem.file"); });
  const publicFace = ["---", 'name: "their-ai"', 'description: "Public face."', 'license: "MIT"', 'compatibility: "Any."', "metadata:", '  id: "pub-link"', '  owner: "Ada"', '  created: "2026-09-04"', '  updated: "2026-09-04"', "---", "", "# Their AI", "", "## Who I am", "", "Ada, in public.", "", "## My tools", "", "- (none)", "", "## Memory", "", "- 2026-09-04 Public memory.", "", "## Memory (older)", "", "- (nothing yet)", ""].join("\n");
  await page.route("https://raw.githubusercontent.com/someone/their-ai/main/their-ai/SKILL.md", (r) => r.fulfill({ status: 200, body: publicFace }));
  await page.goto("/index.html?dial=someone/their-ai");
  await expect(page.locator("main, .transcript, #transcript").first()).toContainText("Your AI is here from someone/their-ai");
  expect(await page.evaluate(() => location.search)).toBe("");
  expect(await page.evaluate(() => localStorage.getItem("vbrainstem.file"))).toContain('grown_from: "pub-link"');
  await page.evaluate(() => { const f = localStorage.getItem("vbrainstem.file"); localStorage.setItem("vbrainstem.file", f.replace("## Memory\n", "## Memory\n\n- 2026-09-05 Learned here.\n")); });
  await page.goto("/index.html?dial=someone/their-ai");
  await expect(page.locator("main, .transcript, #transcript").first()).toContainText("Reunited with the copy on this device");
  const after = await page.evaluate(() => localStorage.getItem("vbrainstem.file"));
  expect(after).toContain("- 2026-09-05 Learned here.");
  expect(after).not.toContain("Forget everything first");
  // a different AI already here is never replaced by a link
  await page.evaluate((f) => localStorage.setItem("vbrainstem.file", f), mk("vb-other", [], "2026-09-01", "Someone else.", ["- 2026-09-01 y"]));
  await page.goto("/index.html?dial=someone/their-ai");
  await expect(page.locator("#file-message")).toContainText("A different AI is already on this device");
  expect(await page.evaluate(() => localStorage.getItem("vbrainstem.file"))).toContain("Someone else.");

  // 5. a person with no file and no other AI can start one here with their name
  await page.evaluate(() => { localStorage.removeItem("vbrainstem.file"); });
  await page.goto("/index.html");
  await page.locator('[data-open="file"]').first().click();
  await page.locator("#start-file").click();
  await expect(page.locator("#file-message")).toContainText("Enter your name");
  await page.locator("#start-name").fill("Grace Hopper");
  await page.locator("#start-file").click();
  await expect(page.locator("#file-message")).toContainText("Your file is started");
  const started = await page.evaluate(() => localStorage.getItem("vbrainstem.file"));
  expect(started).toContain('owner: "Grace Hopper"');
  expect(started).toMatch(/id: "vb-[0-9a-f]{32}"/);
  expect(started).toContain("## Memory");
  const health = await page.evaluate(() => window.vbrainstem.dispatch("GET", "/health"));
  expect(health.json.soul).toBe("loaded");
});


test("round-four fixes, part three: private file access is granted by a second sign-in code, never pasted", async ({ page }) => {
  // private access by code
  const deviceRequests = [];
  let pollMode = "private";
  await page.route("https://rapp-auth.kwildfeuer.workers.dev/api/auth/device", async (route) => {
    deviceRequests.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ device_code: "dc-" + deviceRequests.length, user_code: "CODE-" + deviceRequests.length, verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 }) });
  });
  const polls = [];
  await page.route("https://rapp-auth.kwildfeuer.workers.dev/api/auth/device/poll", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    polls.push(body);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ access_token: pollMode === "private" ? "repo-token-1" : "chat-token-1" }) });
  });
  const publicFace = ["---", 'name: "their-ai"', 'description: "Public face."', 'license: "MIT"', 'compatibility: "Any."', "metadata:", '  id: "pub-3"', '  owner: "Ada"', '  mainline-id: "vb-main3"', '  private-repo: "someone/their-ai-private"', '  private-path: "vbrainstem/SKILL.md"', '  created: "2026-09-04"', '  updated: "2026-09-04"', "---", "", "# Their AI", "", "## Who I am", "", "Ada, in public.", "", "## My tools", "", "- (none)", "", "## Memory", "", "- 2026-09-04 Public memory.", "", "## Memory (older)", "", "- (nothing yet)", ""].join("\n");
  const privateFile = ["---", 'name: "vbrainstem"', 'description: "d"', 'license: "MIT"', 'compatibility: "Any."', "metadata:", '  id: "vb-main3"', '  owner: "Ada"', '  created: "2026-09-01"', '  updated: "2026-09-04"', "---", "", "# Ada", "", "## Who I am", "", "Ada, privately.", "", "## Memory", "", "- 2026-09-04 Private memory.", "", "## Memory (older)", "", "- (nothing yet)", ""].join("\n");
  await page.route("https://raw.githubusercontent.com/someone/their-ai/main/their-ai/SKILL.md", (r) => r.fulfill({ status: 200, body: publicFace }));
  const privateReads = [];
  await page.route("https://api.github.com/repos/someone/their-ai-private/contents/vbrainstem/SKILL.md**", async (route) => {
    const auth = route.request().headers()["authorization"] || "";
    privateReads.push(auth);
    if (auth === "Bearer repo-token-1") { await route.fulfill({ status: 200, contentType: "text/plain", body: privateFile }); return; }
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "Not Found" }) });
  });
  await page.goto("/index.html");
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("github_token", "fake-chat-token"); });
  await page.reload();
  // 1. a private dial with only the chat sign-in says what to do, and does not pretend
  await page.locator('[data-open="file"]').first().click();
  await page.locator('#dial-face input[value="private"]').check();
  await page.locator("#dial-url").fill("https://github.com/someone/their-ai");
  await page.locator("#dial-public").click();
  await expect(page.locator("#file-message")).toContainText("no private file access yet");
  expect(privateReads).toEqual(["Bearer fake-chat-token"]);
  // 2. allow private file access: a second code, through the owner's app, asking only for repositories
  await page.locator("#allow-private").click();
  await expect(page.locator("#sign-in-sheet")).toBeVisible();
  await expect(page.locator("#sign-in-title")).toHaveText("Allow private file access");
  await page.locator("#start-sign-in").click();
  await expect(page.locator("#device-code")).toHaveText("CODE-1");
  expect(deviceRequests[0]).toEqual({ client_id: "Ov23liABVShVz22EmQni", scope: "repo" });
  await expect(page.locator("#sign-in-message")).toContainText("Private file access allowed", { timeout: 15000 });
  expect(polls[polls.length - 1].client_id).toBe("Ov23liABVShVz22EmQni");
  expect(await page.evaluate(() => localStorage.getItem("github_repo_token"))).toBe("repo-token-1");
  expect(await page.evaluate(() => localStorage.getItem("github_token"))).toBe("fake-chat-token");
  await page.locator("#sign-in-sheet [data-close]").click();
  // 3. the same dial now opens the private file with the granted access
  await page.locator('[data-open="file"]').first().click();
  await page.locator('#dial-face input[value="private"]').check();
  await page.locator("#dial-url").fill("https://github.com/someone/their-ai");
  await page.locator("#dial-public").click();
  // the public copy assembled by the first dial reunites with the private mainline the access now reaches
  await expect(page.locator("#file-message")).toContainText("Reunited with the copy on this device");
  expect(privateReads[privateReads.length - 1]).toBe("Bearer repo-token-1");
  const stored = await page.evaluate(() => localStorage.getItem("vbrainstem.file"));
  expect(stored).toContain('id: "vb-main3"');
  expect(stored).toContain("Ada, privately.");
  expect(stored).toContain("- 2026-09-04 Private memory.");
  const status = await page.evaluate(() => window.vbrainstem.dispatch("GET", "/login/status"));
  expect(status.json).toMatchObject({ pending: false, authenticated: true, private_access: true });
  // 4. right after the chat sign-in, a file that names a private place is offered the second code at once
  await page.evaluate(() => { localStorage.removeItem("github_token"); localStorage.removeItem("github_repo_token"); });
  await page.reload();
  pollMode = "chat";
  await page.locator("#sign-in-shortcut").click();
  await expect(page.locator("#sign-in-title")).toHaveText("Sign in with GitHub");
  await page.locator("#start-sign-in").click();
  await expect(page.locator("#sign-in-message")).toContainText("Signed in", { timeout: 15000 });
  expect(deviceRequests[deviceRequests.length - 1]).toEqual({});
  await expect(page.locator("#allow-private-next")).toBeVisible();
  pollMode = "private";
  await page.locator("#allow-private-next-button").click();
  await expect(page.locator("#sign-in-title")).toHaveText("Allow private file access");
  await expect(page.locator("#sign-in-start")).toBeVisible();
});


test("a throttled sign-in service is reported while the page keeps checking, and completes when it clears", async ({ page }) => {
  // sign-in under throttle
  let pollCount = 0;
  await page.route("https://rapp-auth.kwildfeuer.workers.dev/api/auth/device", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ device_code: "dc", user_code: "BUSY-0001", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 }) }));
  await page.route("https://rapp-auth.kwildfeuer.workers.dev/api/auth/device/poll", async (route) => {
    pollCount += 1;
    if (pollCount <= 2) { await route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ message: "restricted" }) }); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ access_token: "chat-token-after-busy" }) });
  });
  await page.goto("/index.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator("#sign-in-shortcut").click();
  await page.locator("#start-sign-in").click();
  await expect(page.locator("#device-code")).toHaveText("BUSY-0001");
  await expect(page.locator("#sign-in-message")).toContainText("GitHub is busy", { timeout: 15000 });
  await expect(page.locator("#sign-in-message")).toContainText("Signed in", { timeout: 40000 });
  expect(await page.evaluate(() => localStorage.getItem("github_token"))).toBe("chat-token-after-busy");
  expect(pollCount).toBeGreaterThanOrEqual(3);
});
