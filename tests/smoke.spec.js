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
  await page.route("https://api.github.com/repos/someone/their-ai-private/contents/their-ai/SKILL.md**", async (route) => {
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
      '  private-repo: "someone/their-ai-private"', '  private-path: "their-ai/SKILL.md"',
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
  await expect(page.getByText("Signed in", { exact: true })).toBeVisible();
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
    expect(mem).toEqual(["- 2026-09-05 Reunited with another copy of me; 1 memory line(s) brought in.", "- 2026-09-04 Spring menu drafted.", "- 2026-09-03 Likes rye.", "- 2026-09-02 Opened at 6."]);
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
      model: "gpt-4o"
    }
  });
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
