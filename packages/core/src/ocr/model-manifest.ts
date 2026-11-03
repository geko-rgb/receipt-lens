import { ReceiptLensError } from "../errors.js";

export type ModelAssetRole = "det" | "rec" | "dict";

export interface ModelAsset {
  role: ModelAssetRole;
  file: string;
  url: string;
  bytes: number;
  sha256: string;
}

export type ColorOrder = "BGR" | "RGB";

export interface Normalization {
  /** Channel order of the tensor. "BGR" means channel 0 is blue. */
  colorOrder: ColorOrder;
  scale: number;
  mean: readonly [number, number, number];
  std: readonly [number, number, number];
}

export interface DetPreprocessing extends Normalization {
  limitSideLen: number;
  sizeMultiple: number;
}

export interface DetPostprocessing {
  name: string;
  threshold: number;
  boxThreshold: number;
  unclipRatio: number;
  minSize: number;
  maxCandidates: number;
}

export interface RecPreprocessing extends Normalization {
  height: number;
  baseWidth: number;
  maxWidth: number;
}

/**
 * The model manifest (PROJECT(1).md §9). It is both the asset inventory and the
 * description of how these specific weights must be driven — the provider reads the
 * preprocessing and decoder values from here rather than hardcoding them, so a model
 * swap cannot silently pair new weights with old normalization.
 */
export interface ModelManifest {
  schemaVersion: number;
  provider: string;
  providerVersion: string;
  preset: string;
  license: string;
  assets: ModelAsset[];
  detection: {
    inputName: string;
    outputName: string;
    inputShape: string[];
    outputShape: string[];
    preprocessing: DetPreprocessing;
    postprocessing: DetPostprocessing;
  };
  recognition: {
    inputName: string;
    outputName: string;
    inputShape: string[];
    preprocessing: RecPreprocessing;
    decoder: {
      name: string;
      blankIndex: number;
      dictionaryEntries: number;
      /** "softmax" when the graph already normalizes its output; "logits" otherwise. */
      outputActivation: "softmax" | "logits";
    };
  };
  readingOrder: { toleranceRatio: number };
}

export interface LoadedModelManifest {
  manifest: ModelManifest;
  /** SHA-256 (hex) of the manifest bytes exactly as served; the model cache key of §9. */
  manifestHash: string;
  asset(role: ModelAssetRole): ModelAsset;
}

function fail(message: string, cause?: unknown): never {
  throw new ReceiptLensError("MODEL_LOAD_FAILED", message, cause === undefined ? undefined : { cause });
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function expectString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string") fail(`${where}.${key} is missing or not a string`);
  return value;
}

function expectNumber(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${where}.${key} is missing or not a finite number`);
  return value;
}

function expectTriple(value: unknown, where: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    fail(`${where} must be three finite numbers`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function expectNormalization(record: Record<string, unknown>, where: string): Normalization {
  const colorOrder = expectString(record, "colorOrder", where);
  if (colorOrder !== "BGR" && colorOrder !== "RGB") fail(`${where}.colorOrder must be "BGR" or "RGB"`);
  return {
    colorOrder,
    scale: expectNumber(record, "scale", where),
    mean: expectTriple(record.mean, `${where}.mean`),
    std: expectTriple(record.std, `${where}.std`),
  };
}

function expectActivation(record: Record<string, unknown>, key: string, where: string): "softmax" | "logits" {
  const value = expectString(record, key, where);
  if (value !== "softmax" && value !== "logits") fail(`${where}.${key} must be "softmax" or "logits"`);
  return value;
}

function expectRecord(record: Record<string, unknown>, key: string, where: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) fail(`${where}.${key} is missing or not an object`);
  return value;
}

/** Structural validation: a manifest that cannot drive inference fails loudly at load. */
function parseManifest(raw: unknown): ModelManifest {
  if (!isRecord(raw)) fail("model manifest is not an object");
  const assetsRaw = raw.assets;
  if (!Array.isArray(assetsRaw) || assetsRaw.length === 0) fail("model manifest has no assets");
  const assets: ModelAsset[] = assetsRaw.map((entry, index) => {
    if (!isRecord(entry)) fail(`assets[${index}] is not an object`);
    const role = expectString(entry, "role", `assets[${index}]`);
    if (role !== "det" && role !== "rec" && role !== "dict") fail(`assets[${index}].role is not det|rec|dict`);
    return {
      role,
      file: expectString(entry, "file", `assets[${index}]`),
      url: expectString(entry, "url", `assets[${index}]`),
      bytes: expectNumber(entry, "bytes", `assets[${index}]`),
      sha256: expectString(entry, "sha256", `assets[${index}]`),
    };
  });
  for (const role of ["det", "rec", "dict"] as const) {
    if (!assets.some((asset) => asset.role === role)) fail(`model manifest is missing the "${role}" asset`);
  }

  const detection = expectRecord(raw, "detection", "manifest");
  const detectionPre = expectRecord(detection, "preprocessing", "detection");
  const detectionPost = expectRecord(detection, "postprocessing", "detection");
  const recognition = expectRecord(raw, "recognition", "manifest");
  const recognitionPre = expectRecord(recognition, "preprocessing", "recognition");
  const decoder = expectRecord(recognition, "decoder", "recognition");
  const readingOrder = expectRecord(raw, "readingOrder", "manifest");

  return {
    schemaVersion: expectNumber(raw, "schemaVersion", "manifest"),
    provider: expectString(raw, "provider", "manifest"),
    providerVersion: expectString(raw, "providerVersion", "manifest"),
    preset: expectString(raw, "preset", "manifest"),
    license: expectString(raw, "license", "manifest"),
    assets,
    detection: {
      inputName: expectString(detection, "inputName", "detection"),
      outputName: expectString(detection, "outputName", "detection"),
      inputShape: Array.isArray(detection.inputShape) ? detection.inputShape.map(String) : [],
      outputShape: Array.isArray(detection.outputShape) ? detection.outputShape.map(String) : [],
      preprocessing: {
        ...expectNormalization(detectionPre, "detection.preprocessing"),
        limitSideLen: expectNumber(detectionPre, "limitSideLen", "detection.preprocessing"),
        sizeMultiple: expectNumber(detectionPre, "sizeMultiple", "detection.preprocessing"),
      },
      postprocessing: {
        name: expectString(detectionPost, "name", "detection.postprocessing"),
        threshold: expectNumber(detectionPost, "threshold", "detection.postprocessing"),
        boxThreshold: expectNumber(detectionPost, "boxThreshold", "detection.postprocessing"),
        unclipRatio: expectNumber(detectionPost, "unclipRatio", "detection.postprocessing"),
        minSize: expectNumber(detectionPost, "minSize", "detection.postprocessing"),
        maxCandidates: expectNumber(detectionPost, "maxCandidates", "detection.postprocessing"),
      },
    },
    recognition: {
      inputName: expectString(recognition, "inputName", "recognition"),
      outputName: expectString(recognition, "outputName", "recognition"),
      inputShape: Array.isArray(recognition.inputShape) ? recognition.inputShape.map(String) : [],
      preprocessing: {
        ...expectNormalization(recognitionPre, "recognition.preprocessing"),
        height: expectNumber(recognitionPre, "height", "recognition.preprocessing"),
        baseWidth: expectNumber(recognitionPre, "baseWidth", "recognition.preprocessing"),
        maxWidth: expectNumber(recognitionPre, "maxWidth", "recognition.preprocessing"),
      },
      decoder: {
        name: expectString(decoder, "name", "recognition.decoder"),
        blankIndex: expectNumber(decoder, "blankIndex", "recognition.decoder"),
        dictionaryEntries: expectNumber(decoder, "dictionaryEntries", "recognition.decoder"),
        outputActivation: expectActivation(decoder, "outputActivation", "recognition.decoder"),
      },
    },
    readingOrder: { toleranceRatio: expectNumber(readingOrder, "toleranceRatio", "readingOrder") },
  };
}

export type FetchLike = (input: string) => Promise<Response>;

/**
 * Fetches and validates the model manifest. Only ever called against the app's own
 * origin — there is no third-party CDN fallback (PROJECT(1).md §9).
 */
export async function fetchModelManifest(manifestUrl: string, fetchImpl: FetchLike = fetch): Promise<LoadedModelManifest> {
  let response: Response;
  try {
    response = await fetchImpl(manifestUrl);
  } catch (cause) {
    fail(`model manifest could not be fetched from ${manifestUrl}`, cause);
  }
  if (!response.ok) fail(`model manifest ${manifestUrl} answered ${response.status}`);

  const text = await response.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    fail(`model manifest ${manifestUrl} is not valid JSON`, cause);
  }

  const manifest = parseManifest(raw);
  const manifestHash = await sha256Hex(new TextEncoder().encode(text));
  return {
    manifest,
    manifestHash,
    asset(role) {
      const asset = manifest.assets.find((candidate) => candidate.role === role);
      if (!asset) fail(`model manifest has no "${role}" asset`);
      return asset;
    },
  };
}

/** Downloads one asset and verifies both its size and its content hash. */
export async function fetchVerifiedAsset(asset: ModelAsset, fetchImpl: FetchLike = fetch): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetchImpl(asset.url);
  } catch (cause) {
    fail(`model asset ${asset.file} could not be fetched`, cause);
  }
  if (!response.ok) fail(`model asset ${asset.file} answered ${response.status}`);

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== asset.bytes) {
    fail(`model asset ${asset.file} is ${bytes.byteLength} bytes, manifest says ${asset.bytes}`);
  }
  const actual = await sha256Hex(bytes);
  if (actual !== asset.sha256) {
    fail(`model asset ${asset.file} sha256 ${actual} does not match manifest ${asset.sha256}`);
  }
  return bytes;
}
