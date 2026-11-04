import { copyFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

/**
 * Ticket 09b — the batch OCR page used by the end-to-end accuracy driver.
 *
 * A separate entry point so `dist/main.js` keeps the exact bytes ticket 08 measured: DECISIONS/0012 F11
 * re-triggers the footprint measurement when the app bundle changes, and a benchmark tool must not be
 * what changes it.
 */
const harnessDir = import.meta.dirname;

const result = await build({
  absWorkingDir: harnessDir,
  entryPoints: ["src/batch.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: true,
  outfile: "dist/batch.js",
  logLevel: "warning",
  metafile: true,
});

await copyFile(path.join(harnessDir, "src/batch.html"), path.join(harnessDir, "dist/batch.html"));

for (const [file, meta] of Object.entries(result.metafile.outputs)) {
  if (file.endsWith(".map")) continue;
  process.stdout.write(`built ${path.relative(harnessDir, file)} — ${(meta.bytes / 1024).toFixed(0)} KB\n`);
}
