import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { BenchmarkField, DatasetName, LabeledReceipt } from "../datasets/types.js";
import type { DatasetProvenance } from "../datasets/types.js";

export interface LoadedSplit {
  readonly provenance: DatasetProvenance;
  readonly receipts: readonly LabeledReceipt[];
}

/**
 * Reads a committed fixture split: the provenance header plus every receipt file.
 * Shared by the bootstrap test and the results CLI so the two can never disagree
 * about what a split contains.
 */
export async function loadFixtureSplit(fixturesRoot: string, split: "dev" | "eval", dataset: DatasetName): Promise<LoadedSplit> {
  const headerPath = path.join(fixturesRoot, split, `${dataset}.provenance.json`);
  const header = JSON.parse(await readFile(headerPath, "utf8")) as {
    provenance: { fieldsLabeled: BenchmarkField[]; fieldsExcluded: BenchmarkField[] } & Omit<DatasetProvenance, "fieldsLabeled" | "fieldsExcluded">;
    redactionCounts: Record<string, number>;
    unmatchedEntities: { class: string; textLength: number; words: number; digest: string }[];
  };
  const dir = path.join(fixturesRoot, split, dataset);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const receipts: LabeledReceipt[] = [];
  for (const name of names) {
    receipts.push(JSON.parse(await readFile(path.join(dir, name), "utf8")) as LabeledReceipt);
  }
  if (receipts.length !== header.provenance.receipts) {
    throw new Error(
      `${split}/${dataset}: header declares ${header.provenance.receipts} receipts but ${receipts.length} files are present — the committed set is inconsistent`
    );
  }
  return {
    provenance: {
      ...header.provenance,
      fieldsLabeled: header.provenance.fieldsLabeled,
      fieldsExcluded: header.provenance.fieldsExcluded,
    },
    receipts,
  };
}
