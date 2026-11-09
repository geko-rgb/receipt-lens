#!/usr/bin/env node
/**
 * Keeps `packages/core/dist` from going stale under the app and its tests.
 *
 * Why this exists. `@receipt-lens/core` publishes `./dist/index.js` (see its package.json `exports`), so every
 * consumer — the PWA bundle, the PWA's vitest run, `tsc` resolving the `.d.ts` — reads build output, never
 * `src/`. `dist/` is gitignored, so it is not restored with the source tree and nothing in a plain
 * `git checkout <old-commit>` refreshes it. That combination produced a real failure on 2026-11-09: a walk
 * through candidate commits for a patch left `dist/` holding a three-day-old parser while `src/` held the
 * current one, and the app was served the old parser's behaviour with the new parser's source checked out.
 * Nothing errored. `tsc` was clean and 327 core tests passed, because both read `src/`.
 *
 * The rule is deliberately one-directional: a missing or older `dist/index.js` than the newest file under
 * `src/` means rebuild. It never tries to decide whether the *content* agrees — `tsc` already knows that, and
 * a skipped rebuild is the failure being prevented, so the bias is toward building.
 *
 * Speed. `tsc -p .` for core is ~1.8 s, and this script is a no-op when `dist` is current, so it is safe to
 * hang off `predev`/`pretest`/`prebuild`: the happy path stats a directory and exits.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = path.join(repoRoot, "packages", "core");
const srcDir = path.join(coreDir, "src");
const distEntry = path.join(coreDir, "dist", "index.js");

/** Every `.ts` file that `tsc` would emit from — the same set its tsconfig `include`s, minus tests. */
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!entry.name.endsWith(".ts")) return [];
    // tsconfig excludes `src/**/*.test.ts`; a test file changing does not change the emitted JS.
    if (entry.name.endsWith(".test.ts")) return [];
    return [full];
  });
}

/** Every emitted file, so the staleness test compares against the whole build rather than one entry point. */
function emittedFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return emittedFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

function newestMtime(files) {
  return files.reduce((newest, file) => Math.max(newest, statSync(file).mtimeMs), 0);
}

function main() {
  const checkOnly = process.argv.includes("--check");

  if (!existsSync(srcDir)) {
    console.error(`ensure-core-built: no ${srcDir} — run from the repository root`);
    process.exit(1);
  }

  const sources = sourceFiles(srcDir);
  if (sources.length === 0) {
    console.error(`ensure-core-built: found no sources under ${srcDir}`);
    process.exit(1);
  }

  if (existsSync(distEntry)) {
    const distAge = newestMtime(emittedFiles(path.join(coreDir, "dist")));
    const srcAge = newestMtime(sources);
    if (srcAge <= distAge) return; // current — the common case, and it costs one directory walk
    const staleBy = ((srcAge - distAge) / 1000).toFixed(0);
    if (checkOnly) {
      console.error(
        `ensure-core-built: packages/core/dist is stale (src is ${staleBy}s newer). ` +
          "Consumers import the built package, so this tree would test or serve old parser behaviour. " +
          "Run `node scripts/ensure-core-built.mjs` or `pnpm build`.",
      );
      process.exit(1);
    }
    console.log(`ensure-core-built: packages/core/src is ${staleBy}s newer than dist/ — rebuilding`);
  } else {
    if (checkOnly) {
      console.error("ensure-core-built: packages/core/dist is missing. Run `pnpm build`.");
      process.exit(1);
    }
    console.log("ensure-core-built: packages/core/dist is missing — building");
  }

  // `pnpm exec tsc` would need the pnpm shim, which is a native-binary placeholder on some installs and
  // fails with ENOEXEC under execFileSync. Resolve the workspace's own tsc binary instead: it is the same
  // compiler this package's `build` script runs, and it needs no shell.
  const tsc = path.join(repoRoot, "node_modules", ".bin", "tsc");
  if (!existsSync(tsc)) {
    console.error(`ensure-core-built: no tsc at ${tsc} — run \`pnpm install\` first`);
    process.exit(1);
  }
  execFileSync(tsc, ["-p", "."], { cwd: coreDir, stdio: "inherit" });
}

main();