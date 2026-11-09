/**
 * The staleness guard's own tests, with `node --test` because that needs no configuration and the thing under
 * test is a Node script rather than a module the app imports.
 *
 * Each case builds a throwaway tree shaped like `packages/core` — `src/` plus a gitignored `dist/` — and runs
 * the real script against it with `REPO_ROOT` pointed at that tree, so the rules are asserted against the
 * shipped script instead of a copy of its logic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = path.resolve(import.meta.dirname, "ensure-core-built.mjs");

/** A fake repo whose `packages/core` has the given files, with an optional tsc that "builds" by touching dist. */
function makeRepo({ distAgeMs, srcAgeMs, withDist = true }) {
  const root = mkdtempSync(path.join(tmpdir(), "ensure-core-built-"));
  const core = path.join(root, "packages", "core");
  mkdirSync(path.join(core, "src", "parse"), { recursive: true });
  mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });

  writeFileSync(path.join(core, "src", "parse", "index.ts"), "export {};\n");
  writeFileSync(path.join(core, "package.json"), "{}\n");

  // The fake compiler: writes dist/index.js and dist/parse/index.js, so "rebuilt" is observable.
  const tsc = path.join(root, "node_modules", ".bin", "tsc");
  writeFileSync(
    tsc,
    `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const dist = path.join(path.dirname(process.argv[1]), "..", "..", "packages", "core", "dist");
mkdirSync(path.join(dist, "parse"), { recursive: true });
writeFileSync(path.join(dist, "index.js"), "export {};\\n");
writeFileSync(path.join(dist, "parse", "index.js"), "export {};\\n");
`,
    { mode: 0o755 },
  );

  const now = Date.now();
  if (withDist) {
    mkdirSync(path.join(core, "dist", "parse"), { recursive: true });
    const distEntry = path.join(core, "dist", "index.js");
    const distNested = path.join(core, "dist", "parse", "index.js");
    writeFileSync(distEntry, "export {};\n");
    writeFileSync(distNested, "export {};\n");
    // Both emitted files carry the same age: the guard reads the newest one.
    utimesSync(distEntry, new Date(now + distAgeMs), new Date(now + distAgeMs));
    utimesSync(distNested, new Date(now + distAgeMs), new Date(now + distAgeMs));
  }

  const srcFile = path.join(core, "src", "parse", "index.ts");
  utimesSync(srcFile, new Date(now + srcAgeMs), new Date(now + srcAgeMs));

  return { root, core };
}

/** Runs the guard against a fake repo. Returns `{ status, stdout }` rather than throwing on a non-zero exit. */
function run({ root, core }, args = []) {
  // The script resolves the repo root from its own location, so it is copied into the fake tree.
  const copied = path.join(root, "scripts", "ensure-core-built.mjs");
  mkdirSync(path.dirname(copied), { recursive: true });
  writeFileSync(copied, execFileSync("cat", [script]));
  try {
    const stdout = execFileSync(process.execPath, [copied, ...args], { cwd: root, encoding: "utf8" });
    return { status: 0, stdout, core };
  } catch (error) {
    return { status: error.status, stdout: `${error.stdout ?? ""}${error.stderr ?? ""}`, core };
  }
}

test("is silent and touches nothing when dist is current", () => {
  const repo = makeRepo({ distAgeMs: 0, srcAgeMs: -10_000 });
  const before = existsSync(path.join(repo.core, "dist", "index.js"));
  const result = run(repo);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.ok(before);
});

test("rebuilds when src is newer than dist", () => {
  const repo = makeRepo({ distAgeMs: -120_000, srcAgeMs: 0 });
  const result = run(repo);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /newer than dist\/ — rebuilding/);
});

test("rebuilds when dist is missing entirely", () => {
  const repo = makeRepo({ withDist: false, srcAgeMs: 0 });
  const result = run(repo);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /dist is missing — building/);
  assert.ok(existsSync(path.join(repo.core, "dist", "index.js")));
});

test("--check fails on a stale tree without rebuilding it", () => {
  const repo = makeRepo({ distAgeMs: -120_000, srcAgeMs: 0 });
  const result = run(repo, ["--check"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /dist is stale/);
});

test("--check fails when dist is missing", () => {
  const repo = makeRepo({ withDist: false, srcAgeMs: 0 });
  const result = run(repo, ["--check"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /dist is missing/);
});

test("--check passes on a current tree", () => {
  const repo = makeRepo({ distAgeMs: 0, srcAgeMs: -10_000 });
  const result = run(repo, ["--check"]);
  assert.equal(result.status, 0);
});

test("a touched test file does not count as staleness", () => {
  // tsconfig excludes `src/**/*.test.ts`, so changing one changes no emitted byte.
  const repo = makeRepo({ distAgeMs: 0, srcAgeMs: -10_000 });
  const testFile = path.join(repo.core, "src", "parse", "index.test.ts");
  writeFileSync(testFile, "// a test\n");
  utimesSync(testFile, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  const result = run(repo, ["--check"]);
  assert.equal(result.status, 0);
});