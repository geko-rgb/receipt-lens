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
    url: `/assets/models/${file}`,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

const manifest = {
  provider: "PP-OCRv6",
  version: "tiny",
  license: "Apache-2.0 (per upstream model repo; re-verified in ticket 08)",
  upstream: "https://github.com/PaddlePaddle/PaddleOCR",
  assets,
};
await writeFile(path.join(modelsDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
