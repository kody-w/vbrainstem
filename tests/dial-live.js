// Live: dial Kody's real public front door on the published page with a real token, no mocks.
const { chromium } = require("@playwright/test");
const fs = require("fs"); const path = require("path"); const os = require("os");
(async () => {
  const ghToken = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".brainstem/src/rapp_brainstem/.copilot_token"), "utf8")).access_token;
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(process.env.VB_URL || "https://kody-w.github.io/vbrainstem/");
  await page.evaluate(t => localStorage.setItem("github_token", t), ghToken); await page.reload();
  const dialed = await page.evaluate(() => window.vbrainstem.dispatch("POST", "/file/dial", { url: "https://github.com/kody-w/orion" }));
  const head = (dialed.json.content || "").split("\n").slice(0, 14).join("\n");
  await page.evaluate(async () => { /* the UI path: set the file the way the Dial button does */ });
  const setOk = await page.evaluate(async (content) => { const r = await window.vbrainstem.dispatch("GET", "/health"); localStorage.setItem("vbrainstem.file", content); return r.status; }, dialed.json.content);
  await page.reload();
  const health = await page.evaluate(() => window.vbrainstem.dispatch("GET", "/health"));
  let chat; try { chat = await page.evaluate(() => window.vbrainstem.dispatch("POST", "/chat", { user_input: "Who are you, whose AI are you, and what does done mean to him? Under 50 words.", conversation_history: [] })); } catch (e) { chat = { error: String(e) }; }
  fs.writeFileSync(path.join(__dirname, "dial-live-result.json"), JSON.stringify({ dialStatus: dialed.status, head, health, chat }, null, 2));
  await browser.close();
})();
