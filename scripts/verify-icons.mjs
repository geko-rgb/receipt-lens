#!/usr/bin/env node
/**
 * Ticket 17 — DECISIONS/0027 W11's "the icons are re-derivable" claim, checked.
 *
 * Nothing binary is committed: the build emits the PNGs from `renderIconPng`, so what a reviewer can check is
 * that the generator is deterministic, that the bytes it writes are real decodable PNGs at the advertised
 * sizes, and that the artifact `pnpm build` left in `dist/app` is exactly what a fresh render produces today.
 * A committed binary would instead have to be trusted.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { appIcons, decodeIconPng, renderIconPng } from "./make-icons.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const appDir = path.join(repoRoot, "packages/pwa", "dist/app");
const problems = [];

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

// 1. determinism: two renders in this process, and the CLI's own render, agree byte for byte.
for (const { file, png } of appIcons()) {
  const size = Number(file.match(/(\d+)/)?.[1]);
  const maskable = file.includes("maskable");
  const again = renderIconPng(size, { maskable });
  if (!again.equals(png)) problems.push(`${file}: two renders of the same inputs differ`);
  const { width, height } = decodeIconPng(png);
  if (width !== size || height !== size) problems.push(`${file}: decodes to ${width}x${height}, the manifest declares ${size}x${size}`);
}

// 2. maskable must be a genuinely different tile; identical bytes would mean the safe area was never applied.
if (renderIconPng(512).equals(renderIconPng(512, { maskable: true }))) {
  problems.push("icons/receipt-lens-512-maskable.png is byte-identical to the plain tile, so it has no safe area");
}

// 3. the built artifact is what the generator produces now.
for (const { file, png } of appIcons()) {
  const built = path.join(appDir, file);
  let onDisk;
  try {
    onDisk = readFileSync(built);
  } catch {
    problems.push(`${file}: not present in dist/app — run \`pnpm build\` before \`pnpm verify:icons\``);
    continue;
  }
  if (!onDisk.equals(png)) problems.push(`${file}: dist/app holds ${sha(onDisk)}, a fresh render gives ${sha(png)}`);
}

if (problems.length > 0) {
  process.stdout.write(`icon check failed (DECISIONS/0027 W11)\n- ${problems.join("\n- ")}\n`);
  process.exit(1);
}
process.stdout.write(
  `icons: three deterministic tiles, decodable at their declared sizes, and dist/app matches a fresh render (DECISIONS/0027 W11)\n`,
);
for (const { file, png } of appIcons()) process.stdout.write(`  ${file}  ${png.byteLength} B  sha256:${sha(png)}\n`);
