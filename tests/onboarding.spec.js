const { test, expect } = require("@playwright/test");

const platforms = ["ChatGPT", "Claude Code", "GitHub Copilot CLI"];
const coreUrl = "https://raw.githubusercontent.com/kody-w/vbrainstem/main/virtual-brainstem/SKILL.md";

test("each platform copies its own visible prompt and supports a complete keyboard cycle", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => { window.copiedPrompt = value; } }
    });
  });
  await page.goto("/index.html");
  const tabs = page.getByRole("tablist", { name: "Choose your AI" });
  for (const name of platforms) {
    await tabs.getByRole("tab", { name, exact: true }).click();
    const prompt = await page.locator("#setup-prompt").innerText();
    await page.getByRole("button", { name: `Copy prompt for ${name}`, exact: true }).click();
    expect(await page.evaluate(() => window.copiedPrompt)).toBe(prompt);
    await expect(page.locator("#setup-copy-status")).toContainText(name);
    await expect(tabs.locator('[aria-selected="true"]')).toHaveCount(1);
    await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
  }
  const keys = [
    ["Home", 0], ["ArrowLeft", 2], ["ArrowRight", 0],
    ["ArrowRight", 1], ["End", 2], ["ArrowLeft", 1]
  ];
  await tabs.getByRole("tab", { name: platforms[2], exact: true }).focus();
  for (const [key, index] of keys) {
    await page.keyboard.press(key);
    const selected = tabs.getByRole("tab", { name: platforms[index], exact: true });
    await expect(selected).toBeFocused();
    await expect(selected).toHaveAttribute("aria-selected", "true");
    await expect(selected).toHaveAttribute("tabindex", "0");
    await expect(page.locator("#setup-panel")).toHaveAttribute("aria-labelledby", await selected.getAttribute("id"));
    await expect(tabs.locator('[aria-selected="true"]')).toHaveCount(1);
    await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
  }
});

test("denied clipboard offers exact manual copy and stale completion cannot select another prompt", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => new Promise((resolve, reject) => { window.rejectCopy = reject; }) }
    });
  });
  await page.goto("/index.html");
  await page.getByRole("button", { name: "Copy prompt for ChatGPT", exact: true }).click();
  await page.getByRole("tab", { name: "Claude Code", exact: true }).click();
  await page.evaluate(() => window.rejectCopy(new Error("Clipboard denied")));
  await expect(page.locator("#setup-copy-status")).not.toContainText("ChatGPT");
  await page.getByRole("button", { name: "Copy prompt for Claude Code", exact: true }).click();
  await page.evaluate(() => window.rejectCopy(new Error("Clipboard denied")));
  await expect(page.locator("#setup-copy-status")).toContainText("Copy");
  expect(await page.evaluate(() => getSelection().toString())).toBe(await page.locator("#setup-prompt").innerText());
});

for (const width of [320, 375, 390, 768, 1440]) {
  for (const colorScheme of ["light", "dark"]) {
    test(`onboarding fits its container at ${width}px in ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width <= 375 ? 667 : 900 });
      await page.emulateMedia({ colorScheme });
      await page.goto("/index.html");
      for (const name of platforms) {
        await page.getByRole("tab", { name, exact: true }).click();
        const clipping = await page.evaluate(() => {
          const container = document.querySelector("#transcript").getBoundingClientRect();
          return [...document.querySelectorAll(".setup-tab, .setup-prompt-box, #copy-setup-prompt")]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return element.scrollWidth > element.clientWidth + 1 ||
                rect.left < container.left - 1 || rect.right > container.right + 1;
            }).map((element) => element.id || element.className);
        });
        expect(clipping).toEqual([]);
      }
      if (width === 375) {
        const copy = await page.locator("#copy-setup-prompt").boundingBox();
        const composer = await page.locator("#composer").boundingBox();
        expect(copy.y + copy.height).toBeLessThanOrEqual(composer.y);
      }
    });
  }
}

test("tabs grow with text instead of clipping and focus stays visible", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 667 });
  await page.goto("/index.html");
  await page.locator(".setup-tab").evaluateAll((tabs) => {
    for (const tab of tabs) tab.style.fontSize = `${parseFloat(getComputedStyle(tab).fontSize) * 2}px`;
  });
  expect(await page.locator(".setup-tab").evaluateAll((tabs) =>
    tabs.every((tab) => tab.scrollWidth <= tab.clientWidth + 1))).toBe(true);
  await page.getByRole("tab", { name: "ChatGPT", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  expect(await page.getByRole("tab", { name: "Claude Code", exact: true }).evaluate((tab) =>
    parseFloat(getComputedStyle(tab).outlineWidth))).toBeGreaterThanOrEqual(2);
});

test("first-run prompt needs neither storage nor the Brainstem kernel", async ({ page }) => {
  let coreRequests = 0;
  await page.route(coreUrl, (route) => { coreRequests += 1; return route.abort(); });
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new DOMException("Storage denied", "SecurityError"); }
    });
  });
  await page.goto("/index.html");
  await expect(page.getByRole("tablist", { name: "Choose your AI" })).toBeVisible();
  await page.getByRole("tab", { name: "Claude Code", exact: true }).click();
  await expect(page.locator("#setup-prompt")).toContainText("Claude");
  expect(coreRequests).toBe(0);
});

test("no JavaScript leaves usable links for all three hosts", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  await page.goto("/index.html");
  await expect(page.locator("noscript p")).toContainText("ChatGPT");
  await expect(page.locator("noscript p")).toContainText("Claude Code");
  await expect(page.locator("noscript p")).toContainText("GitHub Copilot CLI");
  await expect(page.locator("noscript a").first()).toBeVisible();
  await context.close();
});
