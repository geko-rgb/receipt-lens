import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Enforces docs/storage.md for the committed fixtures: a 50 MB ceiling on
 * benchmarks/fixtures and nothing over 1 MB per committed file.
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const fixturesRoot = path.join(repoRoot, "benchmarks", "fixtures");
const budgetBytes = 50 * 1024 * 1024;
const fileCeilingBytes = 1024 * 1024;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

let total = 0;
let files = 0;
const offenders = [];

for await (const file of walk(fixturesRoot)) {
  const { size } = await stat(file);
  total += size;
  files += 1;
  if (size > fileCeilingBytes) offenders.push(`${path.relative(repoRoot, file)}: ${size} bytes`);
}

console.log(`benchmarks/fixtures: ${files} files, ${total} bytes (${(total / 1024 / 1024).toFixed(1)} MB of 50 MB)`);

if (offenders.length > 0) {
  console.error("over the 1 MB per-file commit ceiling:");
  for (const offender of offenders) console.error(`  ${offender}`);
  process.exit(1);
}
if (total > budgetBytes) {
  console.error(`fixtures exceed the 50 MB ceiling (docs/storage.md)`);
  process.exit(1);
}
