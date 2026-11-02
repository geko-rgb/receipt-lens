import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shellPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../packages/pwa/index.html"
);

test("placeholder PWA page loads in a real browser", async ({ page }) => {
  await page.goto(`file://${shellPath}`);
  await expect(page.getByRole("heading", { name: "receipt-lens" })).toBeVisible();
  await expect(page.title()).resolves.toBe("receipt-lens");
});
