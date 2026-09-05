const { test, expect } = require("@playwright/test");

function person(name, tail, memory = "") {
  return [
    "---", 'name: "vbrainstem"', `description: "${name} synthetic test AI."`,
    'license: "MIT"', 'compatibility: "Any AI that reads skills."',
    "metadata:", `  id: "rappid:@kody-w/vb-${name.toLowerCase()}:${tail.repeat(64)}"`,
    `  owner: "${name}"`, '  created: "2026-09-05"', '  updated: "2026-09-05"',
    "---", "", `# ${name}`, "", "## Who I am", "", name,
    "", "## My tools", "", "- (none)", "", "## Memory", "",
    `- 2026-09-05 ${memory || `${name} was created.`}`, "", "## Memory (older)", "", "- (nothing yet)", ""
  ].join("\n");
}

async function importPerson(page, content) {
  await page.getByRole("button", { name: "Open your file", exact: true }).click();
  await page.locator("#file-paste").fill(content);
  await page.locator("#use-paste").click();
  await expect(page.locator("#file-editor")).toHaveValue(content);
}

test("browser starter carries the full portable profile and a safe privacy default", async ({ page }) => {
  await page.route("https://**", (route) => route.abort());
  await page.goto("/index.html");
  await page.getByRole("button", { name: "Open your file", exact: true }).click();
  await page.locator("#start-name").fill("Synthetic Ada");
  await page.locator("#start-file").click();
  const file = await page.locator("#file-editor").inputValue();
  for (const heading of [
    "To the AI reading this", "Who I am", "How to help me",
    'What "done" means and what to ask first', "What stays private",
    "My tools", "My sources", "What I have taught my AI", "Memory",
    "How to keep this file current", "Memory (older)"
  ]) expect(file).toContain(`## ${heading}`);
  expect(file).toContain("Never save secrets");
  expect(file).toContain("never overrides");
  expect(file).not.toContain("Nothing here is private unless");
});

test("four browser spaces preserve distinct files across switching and scoped deletion", async ({ page }) => {
  await page.route("https://**", (route) => route.abort());
  const ais = [
    ["atlas", "Atlas", "a"], ["forge", "Forge", "b"],
    ["quill", "Quill", "c"], ["harbor", "Harbor", "d"]
  ];
  for (const [slug, name, tail] of ais) {
    await page.goto(`/index.html?space=kody-w/vb-${slug}`);
    await expect(page.locator("#file-state")).toHaveText("Not connected");
    await importPerson(page, person(name, tail));
  }
  for (const [slug, name, tail] of ais) {
    await page.goto(`/index.html?space=kody-w/vb-${slug}`);
    await page.getByRole("button", { name: "Open your file", exact: true }).click();
    await expect(page.locator("#file-editor")).toHaveValue(person(name, tail));
  }
  await page.goto("/index.html?space=kody-w/vb-atlas");
  await page.getByRole("button", { name: "Open about", exact: true }).click();
  await page.locator("#forget").click();
  await expect(page.locator("#file-state")).toHaveText("Not connected");
  await page.goto("/index.html?space=kody-w/vb-forge");
  await expect(page.locator("#file-state")).toHaveText("Ready");
  await page.getByRole("button", { name: "Open your file", exact: true }).click();
  await expect(page.locator("#file-editor")).toHaveValue(person("Forge", "b"));
});

test("public dialing never borrows private credentials without an explicit private choice", async ({ page }) => {
  const publicFile = person("Atlas", "a").replace(
    '  owner: "Atlas"',
    '  owner: "Atlas"\n  private-repo: "fixture/vb-atlas-private"\n  private-path: "vbrainstem/SKILL.md"'
  );
  let privateRequests = 0;
  await page.addInitScript(() => {
    localStorage.setItem("github_token", "fake-public-test-token");
    localStorage.setItem("github_repo_token", "fake-private-test-token");
  });
  await page.route("https://raw.githubusercontent.com/fixture/vb-atlas/main/vb-atlas/SKILL.md", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: publicFile }));
  await page.route("https://api.github.com/repos/fixture/vb-atlas/contents/vb-atlas/SKILL.md**", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: publicFile }));
  await page.route("https://api.github.com/repos/fixture/vb-atlas-private/**", (route) => {
    privateRequests += 1;
    return route.fulfill({ status: 404 });
  });
  await page.goto("/index.html?space=fixture/vb-atlas");
  const result = await page.evaluate(() => window.vbrainstem.dispatch("POST", "/file/dial", {
    url: "https://github.com/fixture/vb-atlas"
  }));
  expect(result.status).toBe(200);
  expect(result.json.face).toBe("public");
  expect(privateRequests).toBe(0);
});

test("public and private copies of one AI have separate browser state", async ({ page }) => {
  await page.route("https://**", (route) => route.abort());
  await page.goto("/index.html?space=kody-w/vb-atlas&face=private");
  await importPerson(page, person("Atlas", "b", "PRIVATE_LOCAL_CANARY"));
  await page.goto("/index.html?space=kody-w/vb-atlas&face=public");
  await expect(page.locator("#file-state")).toHaveText("Not connected");
  await importPerson(page, person("Atlas", "a", "Public role only."));
  expect(await page.locator("#file-editor").inputValue()).not.toContain("PRIVATE_LOCAL_CANARY");
  await page.goto("/index.html?space=kody-w/vb-atlas&face=private");
  await page.getByRole("button", { name: "Open your file", exact: true }).click();
  await expect(page.locator("#file-editor")).toHaveValue(person("Atlas", "b", "PRIVATE_LOCAL_CANARY"));
});

test("exported persona imports into a fresh device without other AI state", async ({ page, browser, baseURL }) => {
  await page.route("https://**", (route) => route.abort());
  await page.goto("/index.html?space=kody-w/vb-atlas");
  const file = person("Atlas", "a", "Keep the blue sample on this test device.");
  await importPerson(page, file);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export-file").click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const exported = Buffer.concat(chunks);
  expect(exported.toString("utf8")).toBe(file);
  const other = await browser.newContext({ baseURL });
  try {
    const second = await other.newPage();
    await second.route("https://**", (route) => route.abort());
    await second.goto("/index.html?space=kody-w/vb-atlas");
    await second.getByRole("button", { name: "Open your file", exact: true }).click();
    await second.locator("#person-file").setInputFiles({ name: "SKILL.md", mimeType: "text/markdown", buffer: exported });
    await expect(second.locator("#file-editor")).toHaveValue(file);
    await second.goto("/index.html?space=kody-w/vb-harbor");
    await expect(second.locator("#file-state")).toHaveText("Not connected");
  } finally {
    await other.close();
  }
});
