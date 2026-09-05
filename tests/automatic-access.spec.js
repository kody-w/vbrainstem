const { test, expect } = require("@playwright/test");
const { createFixtures, artifact, installRoutes } = require("./helpers/dial-fixtures");

let fixtures;
test.beforeAll(() => { fixtures = createFixtures(); });
test.afterAll(() => { fixtures?.cleanup(); });

function address(pair, extra = {}) {
  return "/index.html?" + new URLSearchParams({
    dial: pair.public_repo, space: pair.public_repo, trust: pair.estate_owner, ...extra
  });
}

test("favorites are visible, keyboard reachable and use one automatic dial address each", async ({ page }) => {
  await page.goto("/index.html");
  const favorites = page.getByRole("navigation", { name: "Favorite AIs" });
  await expect(favorites).toBeVisible();
  for (const name of ["Overwatch", "Scout", "Forge", "Sentinel"]) {
    const link = favorites.getByRole("link", { name: "Dial " + name, exact: true });
    await expect(link).toHaveAttribute("href", "?dial=kody-w/vb-" + name.toLowerCase());
    await link.focus();
    await expect(link).toBeFocused();
  }
  await expect(page.locator("#switch-copy")).toHaveCount(0);
  await expect(page.locator("#dial-face")).toHaveCount(0);
});

test("authorized access automatically loads full context without a mode choice", async ({ page }) => {
  const pair = fixtures.pairs.get("vb-overwatch");
  await installRoutes(page, fixtures.pairs, { authorized: true });
  await page.goto(address(pair));
  await page.getByRole("button", { name: "Open your file", exact: true }).click();
  await expect(page.locator("#file-editor")).toHaveValue(artifact(pair, "private", pair.private_skill_path));
  await expect(page.locator("#file-state")).toHaveText("Ready");
  await expect(page.locator(".brand")).toHaveText("Overwatch");
  await expect(page.getByRole("button", { name: /Use (public|private) copy/ })).toHaveCount(0);
});

for (const status of [401, 403, 404]) {
  test(`denied access ${status} opens the shared AI normally`, async ({ page }) => {
    const pair = fixtures.pairs.get("vb-atlas");
    const observed = await installRoutes(page, fixtures.pairs, { seedToken: true, deniedStatus: status });
    await page.goto(address(pair, { face: "private" }));
    await expect(page.locator("#file-state")).toHaveText("Ready");
    await expect(page.locator("#shade")).toBeHidden();
    await page.getByRole("button", { name: "Open your file", exact: true }).click();
    await expect(page.locator("#file-editor")).toHaveValue(artifact(pair, "public", pair.public_skill_path));
    expect(observed.privateProbes.length).toBeGreaterThan(0);
    expect(observed.privateReads).toHaveLength(0);
  });
}

test("the chat connection is tried when the saved repository connection lacks access", async ({ page }) => {
  const pair = fixtures.pairs.get("vb-forge");
  const observed = await installRoutes(page, fixtures.pairs, {
    authorized: true, repoToken: "limited-connection", chatToken: "working-connection",
    acceptedTokens: ["working-connection"]
  });
  await page.goto(address(pair));
  await expect(page.locator("#file-state")).toHaveText("Ready");
  await page.getByRole("button", { name: "Open your file", exact: true }).click();
  await expect(page.locator("#file-editor")).toHaveValue(artifact(pair, "private", pair.private_skill_path));
  expect(observed.privateProbes.some((probe) => !probe.authorized)).toBe(true);
  expect(observed.privateProbes.some((probe) => probe.authorized)).toBe(true);
});

for (const options of [
  { seedToken: true, deniedStatus: 500 },
  { seedToken: true, deniedStatus: 429 },
  { authorized: true, missingPrivateFile: "FRAME.json" },
  { authorized: true, mutate: (file, text) => file === "private/vbrainstem/SKILL.md" ? text + "\nTampered.\n" : text }
]) {
  test(`failure is not disguised as denied access: ${options.deniedStatus || options.missingPrivateFile || "tamper"}`, async ({ page }) => {
    const pair = fixtures.pairs.get("vb-quill");
    await installRoutes(page, fixtures.pairs, options);
    await page.goto("/index.html?space=fixture/vb-quill");
    const result = await page.evaluate((pair) => window.vbrainstem.dispatch("POST", "/file/dial", {
      url: "https://github.com/" + pair.public_repo, trust: pair.estate_owner
    }), pair);
    expect(result.status).not.toBe(200);
    expect(result.json.content).toBeUndefined();
  });
}

test("cached private data stays concealed until access is checked and is not exposed on downgrade", async ({ page }) => {
  const pair = fixtures.pairs.get("vb-harbor");
  await installRoutes(page, fixtures.pairs, { seedToken: true, deniedStatus: 404, probeDelay: 400 });
  await page.addInitScript((text) => {
    localStorage.setItem("vbrainstem:fixture/vb-harbor:private:file", text);
  }, artifact(pair, "private", pair.private_skill_path));
  await page.goto(address(pair, { face: "private" }));
  await expect(page.locator("#message")).toBeDisabled();
  await expect(page.locator("#file-editor")).toHaveValue("");
  await expect(page.locator("#file-state")).toHaveText("Ready");
  await page.getByRole("button", { name: "Open your file", exact: true }).click();
  await expect(page.locator("#file-editor")).toHaveValue(artifact(pair, "public", pair.public_skill_path));
  expect(await page.locator("#file-editor").inputValue()).not.toContain("PRIVATE_TEST_MARKER");
  expect(await page.evaluate(() => localStorage.getItem("vbrainstem:fixture/vb-harbor:private:file"))).toContain("PRIVATE_TEST_MARKER");
});

test("favorites fit a narrow phone without clipping", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 667 });
  await page.goto("/index.html");
  const links = page.getByRole("navigation", { name: "Favorite AIs" }).getByRole("link");
  await expect(links).toHaveCount(4);
  expect(await links.evaluateAll((items) => items.every((item) => {
    const box = item.getBoundingClientRect();
    return item.scrollWidth <= item.clientWidth + 1 && box.width >= 44 && box.height >= 44 &&
      box.left >= 0 && box.right <= innerWidth;
  }))).toBe(true);
});

test("sign-in automatically reconnects to saved context without requesting extra permissions", async ({ page }) => {
  const pair = fixtures.pairs.get("vb-forge");
  await installRoutes(page, fixtures.pairs, {
    authorized: true, seedToken: false, acceptedTokens: ["new-chat-connection"]
  });
  const requests = [];
  await page.route("https://rapp-auth.kwildfeuer.workers.dev/api/auth/device", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { device_code: "test-device", user_code: "DEMO", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 900 } });
  });
  await page.route("https://rapp-auth.kwildfeuer.workers.dev/api/auth/device/poll", (route) =>
    route.fulfill({ json: { access_token: "new-chat-connection" } }));
  await page.goto(address(pair));
  await expect(page.locator("#file-state")).toHaveText("Ready");
  await page.locator("#sign-in-shortcut").click();
  await page.locator("#start-sign-in").click();
  await expect(page).toHaveURL(/face=private/);
  await expect(page.locator("#file-state")).toHaveText("Ready");
  await page.getByRole("button", { name: "Open your file", exact: true }).click();
  await expect(page.locator("#file-editor")).toHaveValue(artifact(pair, "private", pair.private_skill_path));
  expect(requests).toEqual([{}]);
});

test("an account change cannot reuse the previous account's extra access or private view", async ({ page }) => {
  const pair = fixtures.pairs.get("vb-forge");
  await installRoutes(page, fixtures.pairs, {
    authorized: true, repoToken: "extra-account-one", chatToken: "old-chat",
    acceptedTokens: ["extra-account-one"]
  });
  await page.route("https://api.github.com/user", (route) => route.fulfill({
    json: { id: route.request().headers().authorization === "Bearer old-chat" ? 1 : 2 }
  }));
  await page.route("https://rapp-auth.kwildfeuer.workers.dev/api/auth/device", (route) => route.fulfill({
    json: { device_code: "switch-device", user_code: "SWITCH", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 900 }
  }));
  await page.route("https://rapp-auth.kwildfeuer.workers.dev/api/auth/device/poll", (route) =>
    route.fulfill({ json: { access_token: "new-chat" } }));
  await page.goto(address(pair));
  await expect(page).toHaveURL(/face=private/);
  await expect(page.locator("#file-state")).toHaveText("Ready");
  await page.locator("#sign-in-shortcut").click();
  await page.locator("#start-sign-in").click();
  await expect(page).toHaveURL(/face=public/);
  await expect(page.locator("#file-state")).toHaveText("Ready");
  expect(await page.evaluate(() => localStorage.getItem("github_repo_token"))).toBeNull();
  await page.getByRole("button", { name: "Open your file", exact: true }).click();
  await expect(page.locator("#file-editor")).toHaveValue(artifact(pair, "public", pair.public_skill_path));
});

test("automatic reconnect preserves local customizations without asking for an access mode", async ({ page }) => {
  const pair = fixtures.pairs.get("vb-atlas");
  await installRoutes(page, fixtures.pairs);
  await page.goto(address(pair));
  await expect(page.locator("#file-state")).toHaveText("Ready");
  await page.getByRole("button", { name: "Open your file", exact: true }).click();
  const customized = artifact(pair, "public", pair.public_skill_path).replace(
    "Compare sources, identify uncertainty", "Use concise comparisons of sources, identify uncertainty"
  );
  await page.locator("#file-editor").fill(customized);
  await expect(page.locator("#file-message")).toContainText("Saved");
  await page.reload();
  await expect(page.locator("#file-state")).toHaveText("Ready");
  await expect(page.locator("#shade")).toBeHidden();
  await page.getByRole("button", { name: "Open your file", exact: true }).click();
  await expect(page.locator("#file-editor")).toHaveValue(customized);
  await expect(page.locator("#file-message")).toContainText("saved changes were kept");
});
