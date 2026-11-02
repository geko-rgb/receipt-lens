import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import type { CordRow, CordValidLine } from "./cord.js";
import type { SroieRow } from "./sroie.js";

export interface PinnedFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ManifestDataset {
  readonly role: string;
  readonly source: string;
  readonly revision?: string;
  readonly license: string;
  readonly files: readonly PinnedFile[];
  readonly labelCoverageNote?: string;
}

export interface DatasetManifest {
  readonly datasets: Readonly<Record<"cord-v2" | "sroie", ManifestDataset>>;
}

/**
 * sha256 over the canonical per-dataset file list: names sorted, one `"<name>
 * <sha256>"` line each, trailing newline (DECISIONS/0003). This is the only key these
 * fixtures need — regeneration is a function of the snapshot alone.
 */
export function snapshotHashOf(dataset: ManifestDataset): string {
  const canonical = [...dataset.files]
    .map((file) => ({ name: file.name, sha256: file.sha256 }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((file) => `${file.name} ${file.sha256}`)
    .join("\n");
  return createHash("sha256").update(`${canonical}\n`).digest("hex");
}

export async function readManifest(datasetRoot: string): Promise<DatasetManifest> {
  return JSON.parse(await readFile(path.join(datasetRoot, "dataset-manifest.json"), "utf8")) as DatasetManifest;
}

/** Verifies raw bytes against the pin before any fixture is derived from them. */
export async function verifyPins(datasetRoot: string, key: "cord-v2" | "sroie", dataset: ManifestDataset): Promise<void> {
  for (const file of dataset.files) {
    const bytes = await readFile(path.join(datasetRoot, "raw", key, file.name));
    if (bytes.byteLength !== file.bytes) {
      throw new Error(`${key}/${file.name}: ${bytes.byteLength} bytes on disk, pin says ${file.bytes}`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== file.sha256) {
      throw new Error(`${key}/${file.name}: sha256 ${digest} does not match the pin ${file.sha256}`);
    }
  }
}

function pinnedFile(dataset: ManifestDataset, contains: string): PinnedFile {
  const match = dataset.files.find((file) => file.name.includes(contains));
  if (!match) throw new Error(`no pinned ${contains} file in the manifest`);
  return match;
}

async function rowsOf(datasetRoot: string, key: "cord-v2" | "sroie", file: PinnedFile): Promise<Record<string, unknown>[]> {
  const buffer = await asyncBufferFromFile(path.join(datasetRoot, "raw", key, file.name));
  return parquetReadObjects({ file: buffer });
}

function asText(value: unknown, where: string): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  throw new TypeError(`${where}: expected text, got ${typeof value}`);
}

function asNumber(value: unknown, where: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  throw new TypeError(`${where}: expected a number, got ${typeof value}`);
}

export async function readCordRows(datasetRoot: string, dataset: ManifestDataset, split: "validation" | "test"): Promise<CordRow[]> {
  const file = pinnedFile(dataset, split);
  const rows = await rowsOf(datasetRoot, "cord-v2", file);
  return rows.map((row, index) => {
    const groundTruth = JSON.parse(asText(row.ground_truth, `cord-v2/${split}[${index}] ground_truth`)) as {
      meta?: { image_size?: { width?: unknown; height?: unknown } };
      valid_line?: CordValidLine[];
    };
    const size = groundTruth.meta?.image_size;
    if (!size || !groundTruth.valid_line) {
      throw new TypeError(`cord-v2/${split}[${index}]: ground_truth carries no image_size or valid_line`);
    }
    return {
      imageSize: { width: asNumber(size.width, `cord-v2/${split}[${index}] width`), height: asNumber(size.height, `cord-v2/${split}[${index}] height`) },
      validLine: groundTruth.valid_line,
    };
  });
}

export async function readSroieRows(datasetRoot: string, dataset: ManifestDataset, split: "train" | "test"): Promise<SroieRow[]> {
  const file = pinnedFile(dataset, split);
  const rows = await rowsOf(datasetRoot, "sroie", file);
  return rows.map((row, index) => {
    const where = `sroie/${split}[${index}]`;
    const size = row.image_size as { width?: unknown; height?: unknown } | undefined;
    if (!size) throw new TypeError(`${where}: no image_size`);
    const entities = (row.entities ?? {}) as Record<string, unknown>;
    const optionalText = (key: string): string | undefined => {
      const value = entities[key];
      return value === undefined || value === null || value === "" ? undefined : asText(value, `${where} ${key}`);
    };
    return {
      words: (row.words as unknown[]).map((word, wordIndex) => asText(word, `${where} words[${wordIndex}]`)),
      // SROIE rectangles are stored as int64, so hyparquet hands back BigInts.
      bboxes: (row.bboxes as readonly (readonly (number | bigint)[])[]).map((box) =>
        box.map((value) => asNumber(value, `${where} bbox`))
      ),
      imageSize: { width: asNumber(size.width, `${where} width`), height: asNumber(size.height, `${where} height`) },
      entities: {
        company: optionalText("company"),
        date: optionalText("date"),
        address: optionalText("address"),
        total: optionalText("total"),
      },
    };
  });
}
