/**
 * Ticket 04 checkpoint: load both ONNX sessions through onnxruntime-web and log the
 * input/output names and the tensor shapes each graph actually produces.
 *
 *   node scripts/inspect-ocr-sessions.mjs
 *
 * This intentionally runs outside the provider so a failure here is unambiguously a
 * model/runtime problem, not a preprocessing one. WASM only — this machine has no GPU.
 */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
// onnxruntime-web is a dependency of packages/core, not of the workspace root.
const coreRequire = createRequire(path.join(repoRoot, "packages/core/package.json"));
const ortDist = path.dirname(coreRequire.resolve("onnxruntime-web/wasm"));
const modelsDir = path.join(repoRoot, "assets/models");

const ort = await import(pathToFileURL(path.join(ortDist, "ort.node.min.mjs")).href);
ort.env.wasm.wasmPaths = pathToFileURL(`${ortDist}${path.sep}`).href;
ort.env.wasm.numThreads = 1;

const manifest = JSON.parse(await readFile(path.join(modelsDir, "manifest.json"), "utf8"));

async function load(role) {
  const asset = manifest.assets.find((entry) => entry.role === role);
  if (!asset) throw new Error(`manifest has no ${role} asset`);
  const started = performance.now();
  const bytes = await readFile(path.join(modelsDir, asset.file));
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  return { session, loadedMs: Math.round(performance.now() - started), bytes: bytes.byteLength };
}

const det = await load("det");
const rec = await load("rec");

const detName = det.session.outputNames[0];
const runDet = async (height, width) => {
  const input = new ort.Tensor("float32", new Float32Array(3 * height * width), [1, 3, height, width]);
  const out = await det.session.run({ [manifest.detection.inputName]: input });
  return { input: [height, width], output: [...out[detName].dims] };
};
// H and W must be multiples of 32. Several sizes so the downsample factor is measured,
// not assumed: a single tiny probe can hide it.
const detProbes = [await runDet(96, 160), await runDet(480, 640)];
const detShape = detProbes[0].input;

const recWidth = manifest.recognition.preprocessing.baseWidth;
const recInput = new ort.Tensor(
  "float32",
  new Float32Array(3 * manifest.recognition.preprocessing.height * recWidth),
  [1, 3, manifest.recognition.preprocessing.height, recWidth],
);
const recOut = await rec.session.run({ [manifest.recognition.inputName]: recInput });
const recName = rec.session.outputNames[0];

const dictText = await readFile(path.join(modelsDir, manifest.assets.find((a) => a.role === "dict").file), "utf8");
const dictEntries = dictText.replace(/\r\n/g, "\n").split("\n").filter((line, index, all) => !(index === all.length - 1 && line === "")).length;

const report = {
  executionProvider: "wasm",
  numThreads: ort.env.wasm.numThreads,
  detection: {
    loadedMs: det.loadedMs,
    bytes: det.bytes,
    inputNames: [...det.session.inputNames],
    outputNames: [...det.session.outputNames],
    probes: detProbes,
  },
  recognition: {
    loadedMs: rec.loadedMs,
    bytes: rec.bytes,
    inputNames: [...rec.session.inputNames],
    outputNames: [...rec.session.outputNames],
    probeInputShape: [1, 3, manifest.recognition.preprocessing.height, recWidth],
    outputShape: [...recOut[recName].dims],
    classes: recOut[recName].dims[2],
  },
  dictionary: {
    entries: dictEntries,
    manifestEntries: manifest.recognition.decoder.dictionaryEntries,
    blankIndex: manifest.recognition.decoder.blankIndex,
    classesExpected: dictEntries + 1,
  },
};

console.log(JSON.stringify(report, null, 2));

const problems = [];
if (detProbes.some((probe) => probe.output.length !== 4)) problems.push("detection output is not 4-D");
if (recOut[recName].dims[2] !== dictEntries + 1) {
  problems.push(`recognition classes ${recOut[recName].dims[2]} != dictionary ${dictEntries} + 1 blank`);
}
if (dictEntries !== manifest.recognition.decoder.dictionaryEntries) {
  problems.push(`dictionary has ${dictEntries} entries, manifest says ${manifest.recognition.decoder.dictionaryEntries}`);
}
if (problems.length > 0) {
  console.error(`\nFAILED:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("\nOK: sessions loaded, shapes and vocabulary agree.");
