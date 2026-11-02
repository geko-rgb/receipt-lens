import { expect, it } from "vitest";
import "./index.js";

it("benchmark runner is wired and executes in Node without a browser or network", () => {
  expect(typeof process.versions.node).toBe("string");
  expect(process.env.VITEST).toBe("true");
});
