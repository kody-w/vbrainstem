const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const slugs = ["vb-atlas", "vb-forge", "vb-quill", "vb-harbor"];
const pairs = new Map();
let staging;

test.beforeAll(() => {
  const parent = path.join(__dirname, "test-results");
  fs.mkdirSync(parent, { recursive: true });
  staging = fs.mkdtempSync(path.join(parent, "dial-fixtures-"));
  for (const slug of slugs) {
    const output = execFileSync("python3", [
      "-B", path.join(root, "tools/dial_pairs.py"), "create", "--slug", slug, "--owner", "fixture",
      "--output", path.join(staging, "packages"), "--key-dir", path.join(staging, "keys")
    ], { encoding: "utf8" });
    pairs.set(slug, JSON.parse(output));
  }
});

test.afterAll(() => {
  if (staging) fs.rmSync(staging, { recursive: true, force: true });
});

function artifact(pair, face, file) {
  return fs.readFileSync(path.join(pair.directory, face, file), "utf8");
}

async function routes(page, { authorized = false, mutate = (_, text) => text } = {}) {
  const privateRequests = [];
  await page.route("https://**", (route) => route.abort());
  await page.route("https://raw.githubusercontent.com/fixture/**", (route) => {
    const parts = new URL(route.request().url()).pathname.split("/").filter(Boolean);
    const pair = pairs.get(parts[1]);
    if (!pair || parts[2] !== "main") return route.fulfill({ status: 404 });
    const file = parts.slice(3).join("/");
    const text = artifact(pair, "public", file);
    return route.fulfill({ status: 200, contentType: "text/plain", body: mutate(file, text) });
  });
  await page.route("https://api.github.com/repos/fixture/**", (route) => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/^\/repos\/fixture\/(vb-[a-z]+)-private\/contents\/(.+)$/);
    if (!match) return route.fulfill({ status: 404 });
    privateRequests.push(route.request().url());
    if (!authorized || route.request().headers().authorization !== "Bearer fixture-private-token") {
      return route.fulfill({ status: 404 });
    }
    const pair = pairs.get(match[1]);
    return route.fulfill({
      status: 200, contentType: "text/plain",
      body: mutate("private/" + match[2], artifact(pair, "private", match[2]))
    });
  });
  if (authorized) {
    await page.addInitScript(() => localStorage.setItem("github_repo_token", "fixture-private-token"));
  }
  return privateRequests;
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
        await expect(page.locator("#file-state")).toHaveText("Your file is ready");
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
  await expect(page.locator("#file-state")).toHaveText("No file yet");
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
