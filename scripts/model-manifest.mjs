import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const modelsDir = path.resolve(import.meta.dirname, "../assets/models");
const files = (await readdir(modelsDir)).filter((f) => f !== "manifest.json").sort();

const assets = [];
for (const file of files) {
  const bytes = await readFile(path.join(modelsDir, file));
  assets.push({
    file,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

const manifest = { assets };
await writeFile(
  path.join(modelsDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);
console.log(JSON.stringify(manifest, null, 2));
