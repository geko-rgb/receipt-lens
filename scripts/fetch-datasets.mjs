import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Materializes the pinned dataset snapshots into benchmarks/datasets/raw/ from the
 * URLs in dataset-manifest.json, verifying every file against its pinned SHA-256.
 * Dev/CI-time only: the benchmark harness itself never reaches the network.
 */

const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;
const repoRoot = path.resolve(import.meta.dirname, "..");
const datasetRoot = path.join(repoRoot, "benchmarks", "datasets");
const rawRoot = path.join(datasetRoot, "raw");
const manifestPath = path.join(datasetRoot, "dataset-manifest.json");

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

// Manifest file names are relative to raw/<datasetKey>/, not to raw/ (DECISIONS/0003).

async function sha256Of(file) {
  const hash = createHash("sha256");
  const handle = await open(file, "r");
  try {
    await handle.createReadStream().forEach((chunk) => hash.update(chunk));
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function download(url, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  if (!response.body) throw new Error(`empty response body for ${url}`);
  const temp = `${target}.part`;
  await mkdir(path.dirname(target), { recursive: true });
  const stream = createWriteStream(temp);
  try {
    for await (const chunk of response.body) stream.write(chunk);
    await new Promise((resolve, reject) => stream.end((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    stream.destroy();
    await rm(temp, { force: true });
    throw error;
  }
  await rename(temp, target);
}

const problems = [];
let verified = 0;
let fetched = 0;

for (const [key, dataset] of Object.entries(manifest.datasets)) {
  if (!dataset.resolveBase) {
    problems.push(`${key}: manifest has no resolveBase, cannot fetch`);
    continue;
  }
  const base = path.join(rawRoot, key);
  for (const file of dataset.files) {
    const target = path.join(base, file.name);
    const url = new URL(file.name, dataset.resolveBase).href;
    const existing = await stat(target).then(
      (info) => info,
      () => null
    );
    if (existing) {
      if (existing.size === file.bytes && (await sha256Of(target)) === file.sha256) {
        verified++;
        console.log(`verified  ${key}/${file.name}`);
        continue;
      }
      // Present but wrong: never trust it, re-fetch rather than score against it.
      console.log(`corrupt   ${key}/${file.name} — re-fetching`);
      await rm(target, { force: true });
    }
    const { free } = await statfs(datasetRoot);
    if (free < MIN_FREE_BYTES) {
      problems.push(
        `free space ${Math.round(free / 1024 ** 3)} GB below the 5 GB floor (docs/storage.md) — stopping before ${key}/${file.name}`
      );
      break;
    }
    console.log(`fetching  ${url}`);
    await download(url, target);
    const after = await stat(target);
    const digest = await sha256Of(target);
    if (digest !== file.sha256 || after.size !== file.bytes) {
      await rm(target, { force: true });
      problems.push(
        `${key}/${file.name} does not match its pin (sha256 ${digest === file.sha256 ? "ok" : "MISMATCH"}, bytes ${after.size} vs ${file.bytes}) — unverified bytes deleted`
      );
      continue;
    }
    fetched++;
    console.log(`fetched   ${key}/${file.name}`);
  }
}

if (problems.length) {
  console.error("\nfetch:datasets failed:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

await writeFile(
  path.join(datasetRoot, ".fetch-stamp"),
  `${new Date().toISOString()} verified=${verified} fetched=${fetched}\n`
);
console.log(`\nall pinned files present and hash-verified (verified=${verified}, fetched=${fetched})`);
