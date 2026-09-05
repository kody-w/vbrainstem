const { test, expect } = require("@playwright/test");
const { createFixtures, artifact, installRoutes, slugs } = require("./helpers/dial-fixtures");
let fixtures;
let pairs;

test.beforeAll(() => {
  fixtures = createFixtures();
  pairs = fixtures.pairs;
});

test.afterAll(() => {
  if (fixtures) fixtures.cleanup();
});

async function routes(page, options = {}) {
  return (await installRoutes(page, pairs, options)).privateReads;
}

test("browser verifier accepts exact Python-generated publication bytes for both faces", async ({ page }) => {
  await page.goto("/index.html");
  for (const slug of slugs) {
    const pair = pairs.get(slug);
    for (const face of ["public", "private"]) {
      const checked = await page.evaluate(async (input) => {
        const result = await window.VBDialIntegrity.verifyPublishedFace(input);
        return { id: result.head.stream_id, frames: result.framesChecked };
      }, {
        expectedOwner: pair.estate_owner, publicRepo: pair.public_repo, face,
        receiptText: artifact(pair, face, "DIAL.json"),
        registryText: artifact(pair, face, "registry.json"),
        frameText: artifact(pair, face, "FRAME.json"),
        chainText: artifact(pair, face, "FRAMES.jsonl"),
        skillText: artifact(pair, face, pair[face + "_skill_path"])
      });
      expect(checked).toEqual({ id: pair[face + "_id"], frames: 1 });
    }
  }
});

for (const slug of slugs) {
  for (const face of ["public", "private"]) {
    for (const width of [390, 1280]) {
      test(`${slug} ${face} dials into a fresh ${width}px device context`, async ({ page }) => {
        const pair = pairs.get(slug);
        const privateRequests = await routes(page, { authorized: face === "private" });
        await page.setViewportSize({ width, height: 844 });
        const query = new URLSearchParams({
          dial: pair.public_repo, space: pair.public_repo, face, trust: pair.estate_owner
        });
        await page.goto("/index.html?" + query);
        await expect(page.locator("#file-state")).toHaveText("Ready");
        await page.getByRole("button", { name: "Open your file", exact: true }).click();
        await expect(page.locator("#file-editor")).toHaveValue(artifact(pair, face, pair[face + "_skill_path"]));
        await expect(page.locator("#publication-state")).toContainText("Verified");
        const current = await page.locator("#file-editor").inputValue();
        expect(current.includes("PRIVATE_TEST_MARKER_SYNTHETIC_ONLY")).toBe(face === "private");
        expect(privateRequests.length > 0).toBe(face === "private");
        await page.reload();
        await page.getByRole("button", { name: "Open your file", exact: true }).click();
        await expect(page.locator("#file-editor")).toHaveValue(current);
      });
    }
  }
}

test("private denial is explicit and never substitutes public content", async ({ page }) => {
  const pair = pairs.get("vb-atlas");
  await routes(page);
  await page.goto("/index.html?space=fixture/vb-atlas&face=private");
  const result = await page.evaluate((pair) => window.vbrainstem.dispatch("POST", "/file/dial", {
    url: "https://github.com/" + pair.public_repo, face: "private", trust: pair.estate_owner
  }), pair);
  expect(result.status).not.toBe(200);
  expect(result.json.content).toBeUndefined();
  await expect(page.locator("#file-state")).toHaveText("Not connected");
});

test("tampered signed carrier is refused without replacing a saved local file", async ({ page }) => {
  const pair = pairs.get("vb-atlas");
  await routes(page, { mutate: (file, text) => file.endsWith("SKILL.md") ? text + "\nForged addition.\n" : text });
  await page.goto("/index.html?space=fixture/vb-atlas");
  const original = artifact(pair, "public", pair.public_skill_path);
  await page.getByRole("button", { name: "Open your file", exact: true }).click();
  await page.locator("#file-paste").fill(original);
  await page.locator("#use-paste").click();
  await expect(page.locator("#file-editor")).toHaveValue(original);
  const result = await page.evaluate((pair) => window.vbrainstem.dispatch("POST", "/file/dial", {
    url: "https://github.com/" + pair.public_repo, trust: pair.estate_owner
  }), pair);
  expect(result.status).not.toBe(200);
  expect(result.json.content).toBeUndefined();
  await expect(page.locator("#file-editor")).toHaveValue(original);
});

test("wrong private identity and registry cannot be borrowed from another AI", async ({ page }) => {
  const pair = pairs.get("vb-atlas");
  const other = pairs.get("vb-forge");
  await routes(page, { authorized: true, mutate: (file, text) => file.startsWith("private/") ?
    artifact(other, "private", file.slice("private/".length)) : text });
  await page.goto("/index.html?space=fixture/vb-atlas&face=private");
  const result = await page.evaluate((pair) => window.vbrainstem.dispatch("POST", "/file/dial", {
    url: "https://github.com/" + pair.public_repo, face: "private", trust: pair.estate_owner
  }), pair);
  expect(result.status).not.toBe(200);
  expect(result.json.content).toBeUndefined();
});

test("newly available access is selected automatically on the next dial", async ({ page }) => {
  const pair = pairs.get("vb-atlas");
  const privateRequests = await routes(page, { authorized: true, seedToken: false });
  await page.setViewportSize({ width: 390, height: 844 });
  const query = new URLSearchParams({
    dial: pair.public_repo, space: pair.public_repo, face: "public", trust: pair.estate_owner
  });
  await page.goto("/index.html?" + query);
  await expect(page.locator("#file-state")).toHaveText("Ready");
  expect(privateRequests).toHaveLength(0);
  await page.evaluate(() => localStorage.setItem("github_repo_token", "fixture-private-token"));
  await page.reload();
  await expect(page.locator("#file-state")).toHaveText("Ready");
  await page.getByRole("button", { name: "Open your file", exact: true }).click();
  await expect(page.locator("#file-editor")).toHaveValue(artifact(pair, "private", pair.private_skill_path));
  await expect(page.locator("#publication-state")).toContainText("Verified private");
});
