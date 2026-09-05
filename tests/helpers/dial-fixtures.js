const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const slugs = ["vb-overwatch", "vb-scout", "vb-forge", "vb-sentinel"];
const supported = [...slugs, "vb-atlas", "vb-quill", "vb-harbor"];

function createFixtures() {
  const parent = path.join(root, "tests/test-results");
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, "dial-fixtures-"));
  const pairs = new Map();
  for (const slug of supported) {
    pairs.set(slug, JSON.parse(execFileSync("python3", [
      "-B", path.join(root, "tools/dial_pairs.py"), "create", "--slug", slug, "--owner", "fixture",
      "--output", path.join(staging, "packages"), "--key-dir", path.join(staging, "keys")
    ], { encoding: "utf8" })));
  }
  return { pairs, cleanup: () => fs.rmSync(staging, { recursive: true, force: true }) };
}

function artifact(pair, face, file) {
  return fs.readFileSync(path.join(pair.directory, face, file), "utf8");
}

async function installRoutes(page, pairs, {
  authorized = false, seedToken = authorized, deniedStatus = 404,
  acceptedTokens = ["fixture-private-token"], repoToken = "fixture-private-token", chatToken = "",
  mutate = (_, text) => text, missingPrivateFile = "", probeDelay = 0
} = {}) {
  const privateReads = [];
  const privateProbes = [];
  await page.route("https://**", (route) => route.abort());
  await page.route("https://raw.githubusercontent.com/fixture/**", (route) => {
    const parts = new URL(route.request().url()).pathname.split("/").filter(Boolean);
    const pair = pairs.get(parts[1]);
    if (!pair || parts[2] !== "main") return route.fulfill({ status: 404 });
    const file = parts.slice(3).join("/");
    return route.fulfill({ status: 200, contentType: "text/plain", body: mutate(file, artifact(pair, "public", file)) });
  });
  await page.route("https://api.github.com/repos/fixture/**", async (route) => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/^\/repos\/fixture\/(vb-[a-z]+)-private(?:\/contents\/(.+))?$/);
    if (!match) return route.fulfill({ status: 404 });
    const auth = route.request().headers().authorization || "";
    const canRead = authorized && acceptedTokens.some((token) => auth === "Bearer " + token);
    if (!match[2]) {
      privateProbes.push({ repo: match[1], authorized: canRead });
      if (probeDelay) await new Promise((resolve) => setTimeout(resolve, probeDelay));
      return canRead ? route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ full_name: "fixture/" + match[1] + "-private", private: true })
      }) : route.fulfill({ status: deniedStatus, contentType: "application/json", body: '{"message":"Access unavailable"}' });
    }
    privateReads.push(route.request().url());
    if (!canRead || match[2] === missingPrivateFile) return route.fulfill({ status: 404 });
    return route.fulfill({
      status: 200, contentType: "text/plain",
      body: mutate("private/" + match[2], artifact(pairs.get(match[1]), "private", match[2]))
    });
  });
  if (seedToken || chatToken) {
    await page.addInitScript(({ repo, chat }) => {
      if (sessionStorage.getItem("fixture-connections-seeded")) return;
      sessionStorage.setItem("fixture-connections-seeded", "1");
      if (repo) localStorage.setItem("github_repo_token", repo);
      if (chat) localStorage.setItem("github_token", chat);
    }, { repo: seedToken ? repoToken : "", chat: chatToken });
  }
  return { privateReads, privateProbes };
}

module.exports = { createFixtures, artifact, installRoutes, slugs };
