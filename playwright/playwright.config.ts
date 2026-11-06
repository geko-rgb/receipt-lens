import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  reporter: "list",
  // A missing locator used to hang until the test timeout, which made one bad assertion cost the whole run.
  // Actions and expectations fail in seconds, so a real hang is visible as a timeout instead of as slow CI.
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    actionTimeout: 5_000,
    /**
     * Ticket 17 (DECISIONS/0027 W19): the app now registers a service worker, and any context that lets it
     * install precaches ~15 MB and answers every later request from a cache instead of the network. That is
     * the product behaving correctly and the rest of the suite being reinterpreted by accident, so the
     * default blocks workers and `offline-reload.spec.ts` opts in per file with `test.use()`.
     *
     * Blocking does not hide traffic: measured in Chromium, `page.on("request")` still fires for responses
     * the worker serves, so a request walk stays honest; what goes quiet is `context.route`, which is a
     * bypass rather than an observation point. Ticket 18 owns the audit scenario that runs with workers
     * allowed and asserts the *worker's* own egress.
     */
    serviceWorkers: "block",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
