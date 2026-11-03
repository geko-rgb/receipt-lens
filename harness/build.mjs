import { access } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const harnessDir = import.meta.dirname;
const coreEntry = path.resolve(harnessDir, "../packages/core/dist/index.js");

// Fail with a clear message rather than a cryptic resolve error on a fresh clone.
try {
  await access(coreEntry);
} catch {
  throw new Error(`missing ${coreEntry} — run \`pnpm build\` (core builds first) before building the harness`);
}

const result = await build({
  absWorkingDir: harnessDir,
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: true,
  outfile: "dist/main.js",
  logLevel: "warning",
  metafile: true,
});

// The harness bundles the built package, not the source, so it exercises the same
// entry consumers get.
for (const [file, meta] of Object.entries(result.metafile.outputs)) {
  process.stdout.write(`built ${path.relative(harnessDir, file)} — ${(meta.bytes / 1024).toFixed(0)} KB\n`);
}
