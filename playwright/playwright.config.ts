import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  reporter: "list",
  // A missing locator used to hang until the test timeout, which made one bad assertion cost the whole run.
  // Actions and expectations fail in seconds, so a real hang is visible as a timeout instead of as slow CI.
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: { actionTimeout: 5_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
