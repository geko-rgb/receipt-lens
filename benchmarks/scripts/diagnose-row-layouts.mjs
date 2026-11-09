// Read-only diagnosis for two-line record layouts (ticket 24). Compares two OCR fixtures through the row
// geometry, the anchor path and the header-free pairing stage, so a routing or guard decision is measurable
// instead of guessed:
//
//   node benchmarks/scripts/diagnose-row-layouts.mjs \
//     --a benchmarks/fixtures/eval/cord-v2/085.json --b harness/out/image1.ocr.json
//
// `--a`/`--b` take either a benchmark fixture (`{ ocr: { imageSize, lines } }`) or a harness capture
// (`{ result: { imageSize, lines } }`). Nothing here is used by the parser.
import { readFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const argOf = (flag) => {
  const at = args.indexOf(flag);
  return at === -1 ? null : args[at + 1];
};
if (!argOf("--a") || !argOf("--b")) {
  console.error("usage: node benchmarks/scripts/diagnose-row-layouts.mjs --a <fixture.json> --b <fixture.json>");
  process.exit(2);
}

// The package's published entry point, plus the row-geometry helpers it does not re-export (read-only use).
const core = await import("@receipt-lens/core");
const stage = (name) =>
  import(
    new URL(`../../packages/core/dist/parse/${name}`, import.meta.url).href
  );
const geometry = await stage("geometry.js");
const patterns = await stage("patterns.js");
const { isAmountShaped, rowBandTolerance, weightedMedianWordHeight } = geometry;
const quantity = core;
const pairs = core;

// The classifier's own predicates (classify.ts), copied so the diagnosis asks the stage the same questions.
const isFurniture = (row) => {
  const words = row.words.map((word) => word.text);
  return (
    patterns.matchesHeaderOrNoisePattern(words) ||
    patterns.matchesTenderFamily(row.text) ||
    patterns.readMetadata(words) !== null ||
    patterns.isFooterInstructionRow(words)
  );
};
const isLabelled = (row) =>
  patterns.matchesChargeLabel(row.text) ||
  (row.words.some((word) => /[A-Za-z]{2,}/.test(word.text)) &&
    patterns.matchesHeaderOrNoisePattern(row.words.map((word) => word.text)));
const options = {
  consumed: new Set(),
  isFurniture,
  isLabelled,
  headerFloorIndex: undefined,
  headerRowIndexes: new Set(),
};

const load = async (file) => {
  const parsed = JSON.parse(await readFile(path.resolve(file), "utf8"));
  return { name: path.relative(process.cwd(), file), ocr: parsed.ocr ?? parsed.result };
};

/** Amount-shaped words grouped into printed lines, whatever column they sit in. */
const amountLines = (words) => {
  const lines = [];
  for (const word of [...words].filter((entry) => isAmountShaped(entry.text)).sort((a, b) => a.box.y - b.box.y)) {
    const centre = word.box.y + word.box.height / 2;
    const line = lines.find((entry) => Math.abs(entry.centre - centre) <= 8);
    if (line) {
      line.words.push(word);
      line.centre = (line.centre + centre) / 2;
    } else lines.push({ centre, words: [word], height: word.box.height });
  }
  return lines;
};

const isNameWord = (word) => /[A-Za-z]{2,}/.test(word.text);

for (const file of [argOf("--a"), argOf("--b")]) {
  const { name, ocr } = await load(file);
  const words = ocr.lines.flatMap((line) => line.words ?? []);
  const tolerance = rowBandTolerance(weightedMedianWordHeight(words));
  const column = geometry.inferPriceColumnFromWords(words, ocr.imageSize.width);
  const bands = geometry.clusterRowsByTolerance(words, tolerance);
  const qtyColumn = quantity.detectQuantityColumn(bands, ocr.imageSize.width, column);
  const anchors = geometry.clusterRowsByAnchor(words, column, tolerance);

  console.log(`\n=== ${name} — ${ocr.imageSize.width}x${ocr.imageSize.height}, ${ocr.lines.length} provider lines`);
  console.log(
    `tolerance ${tolerance.toFixed(2)} · price column ${Math.round(column.center)}/±${Math.round(column.tolerance)} fallback ${column.fallback} · qty column ${JSON.stringify(qtyColumn)}`
  );

  const lines = amountLines(words);
  const withTwo = lines.filter((line) => line.words.length >= 2).length;
  const qtyOnAmountLine = lines.filter((line) =>
    words.some(
      (word) =>
        /^\d{1,3}$/.test(word.text) &&
        Math.abs(word.box.y + word.box.height / 2 - line.centre) <= line.height / 2
    )
  ).length;
  const nearestNameSide = lines.filter((line) => {
    const names = words.filter(isNameWord);
    const above = names.filter((word) => word.box.y + word.box.height / 2 < line.centre).at(-1);
    const below = names.find((word) => word.box.y + word.box.height / 2 >= line.centre);
    const gapUp = above ? line.centre - (above.box.y + above.box.height / 2) : Infinity;
    const gapDown = below ? below.box.y + below.box.height / 2 - line.centre : Infinity;
    return gapUp < gapDown;
  }).length;
  console.log(
    `amount lines ${lines.length} · lines with ≥2 amounts ${withTwo} (${(withTwo / lines.length).toFixed(2)}) · ` +
      `qty on the amount's own line ${qtyOnAmountLine} · nearest name above ${nearestNameSide}`
  );

  for (const [kind, rows] of [
    ["band rows", bands],
    ["anchor rows", anchors ?? bands],
  ]) {
    const columns = geometry.inferValueColumns(rows, ocr.imageSize.width, 8, qtyColumn !== null);
    const amountOnly = geometry.inferValueColumns(rows, ocr.imageSize.width, 8);
    const roles = pairs.inferPairingRoles(rows, ocr.imageSize.width, options);
    const pairing = pairs.reconstructWithoutHeader(rows, ocr.imageSize.width, options);
    console.log(`\n-- ${kind} (${rows.length})`);
    console.log(
      `   value bands ${JSON.stringify(columns.map((band) => `${Math.round(band.center)}×${band.members}`))}` +
        ` (amount-only ${JSON.stringify(amountOnly.map((band) => `${Math.round(band.center)}×${band.members}`))}) · ` +
        `pairing roleSource ${pairing.roleSource} · records ${pairing.records.length} · ` +
        `roles ${JSON.stringify(roles.roles.map((role) => `${role.role}@${Math.round(role.center)}`))} · ` +
        `top scores ${JSON.stringify(pairing.scored.slice(0, 2))}`
    );
    for (const row of rows) {
      const amounts = row.words.filter((word) => isAmountShaped(word.text)).length;
      console.log(`   [${String(row.index).padStart(2)}] y=${Math.round(row.box.y)} amounts=${amounts} ${JSON.stringify(row.text)}`);
    }
    if (pairing.unpaired.length > 0) console.log(`   unpaired ${JSON.stringify(pairing.unpaired)}`);
    console.log(`   pairing records ${JSON.stringify(pairing.records.map((record) => [record.name, record.qty, record.lineTotal]))}`);
  }

  const parsed = core.parse(ocr);
  console.log(`\n-- shipped parse(): ${parsed.items.length} items`);
  for (const item of parsed.items) console.log(`   ${JSON.stringify([item.name, item.qty, item.unitPrice ?? null, item.lineTotal])}`);
  console.log(`   grandTotal ${JSON.stringify(parsed.totals?.grandTotal ?? null)} · unclassified ${JSON.stringify(parsed.unclassifiedRows.map((row) => row.text))}`);
}
