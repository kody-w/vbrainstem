// Live probe (not part of CI): real GitHub token from the local Brainstem's token file, no mocks.
const { chromium } = require("@playwright/test");
const fs = require("fs"); const path = require("path"); const os = require("os");
(async () => {
  const ghToken = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".brainstem/src/rapp_brainstem/.copilot_token"), "utf8")).access_token;
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const netlog = []; page.on("response", r => { const u = r.url(); if (/github|copilot|workers\.dev/.test(u)) netlog.push(`${r.status()} ${u.split("?")[0]}`); });
  page.on("console", m => { if (m.type() === "error") netlog.push("console.error: " + m.text().slice(0, 160)); });
  await page.goto("http://127.0.0.1:4173/index.html");
  await page.evaluate(t => localStorage.setItem("github_token", t), ghToken);
  await page.reload();
  await page.setInputFiles("#person-file", path.resolve(__dirname, "../samples/ada/SKILL.md"));
  await page.setInputFiles("#tool-file", path.resolve(__dirname, "../samples/tools/hello-world/SKILL.md"));
  const health = await page.evaluate(() => window.vbrainstem.dispatch("GET", "/health"));
  let chat;
  try {
    chat = await page.evaluate(() => window.vbrainstem.dispatch("POST", "/chat", { user_input: "Use my greeting tool to greet me by my name. Then, in one short line, say what I do for a living. Under 40 words.", conversation_history: [] }));
  } catch (e) { chat = { error: String(e).slice(0, 300) }; }
  fs.writeFileSync(path.join(__dirname, "live-result.json"), JSON.stringify({ health, chat, netlog }, null, 2));
  await browser.close();
})();
