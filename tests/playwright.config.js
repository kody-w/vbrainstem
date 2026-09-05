const { defineConfig } = require("@playwright/test");

const port = Number(process.env.VB_TEST_PORT || 4173);

module.exports = defineConfig({
  testDir: ".",
  testMatch: "*.spec.js",
  timeout: 120000,
  expect: {
    timeout: 30000
  },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 390, height: 844 },
    timezoneId: "America/New_York",
    trace: "retain-on-failure"
  },
  webServer: {
    command: `python3 -m http.server ${port} --bind 127.0.0.1 --directory ..`,
    url: `http://127.0.0.1:${port}/index.html`,
    reuseExistingServer: false
  }
});
