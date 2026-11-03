import { ReceiptLensError } from "../errors.js";
import type { OcrProvider } from "./provider.js";
import type { OcrResult, OcrWord } from "./types.js";
import {
  fetchModelManifest,
  fetchVerifiedAsset,
  type FetchLike,
  type LoadedModelManifest,
  type ModelManifest,
} from "./model-manifest.js";
import { dbPostprocess, planDetResize, scaleBoxesToImage, toChwTensor, type Box } from "./pp-ocrv6/detect.js";
import { browserOcrEnvironment, type OcrEnvironment } from "./pp-ocrv6/image.js";
import { groupWordsIntoLines } from "./pp-ocrv6/lines.js";
import { ctcGreedyDecode, parseDictionary, planRecognitionSize, type CtcDecoded } from "./pp-ocrv6/recognize.js";

/** The slice of onnxruntime-web this provider uses. Kept structural so the runtime is
 * only loaded lazily and can be swapped in tests. */
interface OrtTensor {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, object>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}

export interface OrtRuntime {
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => object;
  InferenceSession: {
    create(model: ArrayBuffer | Uint8Array, options?: Record<string, unknown>): Promise<OrtSession>;
  };
  env: {
    wasm: {
      numThreads: number;
      wasmPaths?: string | Record<string, string>;
    };
  };
}

export interface PPOCRv6SessionInfo {
  readonly executionProvider: "wasm";
  readonly numThreads: number;
  readonly detection: { readonly inputNames: string[]; readonly outputNames: string[] };
  readonly recognition: { readonly inputNames: string[]; readonly outputNames: string[] };
}

export interface PPOCRv6ProviderOptions {
  /** Directory that serves the manifest and assets, trailing slash included. */
  assetBaseUrl?: string;
  manifestUrl?: string;
  fetch?: FetchLike;
  /**
   * WASM thread count. "auto" (default) uses threads only when the page is
   * cross-origin isolated; otherwise a single thread, because SharedArrayBuffer is
   * unavailable and ORT would fail to spawn workers.
   */
  numThreads?: number | "auto";
  /** Directory the onnxruntime-web WASM artifacts are served from. */
  wasmPaths?: string;
  /** Test seam; production always uses the real onnxruntime-web WASM build. */
  loadRuntime?: () => Promise<OrtRuntime>;
  /** Test seam over image decode/render; production uses the browser implementation. */
  environment?: OcrEnvironment;
}

interface LoadedState {
  ort: OrtRuntime;
  det: OrtSession;
  rec: OrtSession;
  dictionary: string[];
  manifest: ModelManifest;
}

function resolveThreadCount(requested: number | "auto" | undefined): number {
  if (typeof requested === "number" && requested >= 1) return Math.floor(requested);
  const isolated = typeof self !== "undefined" && (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  if (!isolated) return 1;
  const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 1;
  return Math.max(1, Math.min(4, cores));
}

/**
 * Splits one recognized detection box into words, distributing the box horizontally
 * by character count. Detection boxes cover text lines, but the contract (and the
 * parser's price-column model) needs word-level boxes; the split is a deterministic
 * approximation of character positions, while every confidence value comes from the
 * recognizer's own per-character scores.
 */
function toWords(decoded: CtcDecoded, box: Box): OcrWord[] {
  const total = decoded.chars.length;
  if (total === 0) return [];

  const words: OcrWord[] = [];
  let current = "";
  let start = -1;
  let scoreSum = 0;
  let scoreCount = 0;

  const flush = (end: number) => {
    if (current.length === 0) return;
    const left = box.x + (start / total) * box.width;
    const right = box.x + (end / total) * box.width;
    words.push({
      text: current,
      box: { x: left, y: box.y, width: Math.max(1, right - left), height: box.height },
      confidence: scoreCount === 0 ? null : scoreSum / scoreCount,
    });
    current = "";
    start = -1;
    scoreSum = 0;
    scoreCount = 0;
  };

  for (let index = 0; index < total; index += 1) {
    const entry = decoded.chars[index]!;
    if (entry.char.trim().length === 0) {
      flush(index);
      continue;
    }
    if (current.length === 0) start = index;
    current += entry.char;
    scoreSum += entry.confidence;
    scoreCount += 1;
  }
  flush(total);
  return words;
}

/**
 * PP-OCRv6 Tiny, running entirely in the browser through onnxruntime-web's WASM
 * execution provider. Detection and recognition models plus the dictionary come from
 * this deployment's own origin (PROJECT(1).md §9); nothing is fetched from a
 * third-party CDN, and inference itself makes no network calls at all.
 */
export class PPOCRv6Provider implements OcrProvider {
  readonly name = "pp-ocrv6";

  /** provider version + preset + manifest hash prefix, per the OCR contract. */
  version = "unloaded";

  manifestHash: string | null = null;
  /** Bytes of det + rec + dictionary, for the harness's asset-byte line. */
  assetBytes = 0;
  sessionInfo: PPOCRv6SessionInfo | null = null;

  private state: LoadedState | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly options: PPOCRv6ProviderOptions = {}) {}

  private get fetcher(): FetchLike {
    return this.options.fetch ?? ((input: string) => fetch(input));
  }

  /** Loads and verifies the model set. Idempotent; a failed load may be retried. */
  load(): Promise<void> {
    if (!this.loading) {
      this.loading = this.loadInternal().catch((error: unknown) => {
        this.loading = null;
        throw error instanceof ReceiptLensError
          ? error
          : new ReceiptLensError(
              "MODEL_LOAD_FAILED",
              `the OCR model set could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error },
            );
      });
    }
    return this.loading;
  }

  private async loadInternal(): Promise<void> {
    const base = this.options.assetBaseUrl ?? "/assets/models/";
    const manifestUrl = this.options.manifestUrl ?? `${base}manifest.json`;

    const loaded: LoadedModelManifest = await fetchModelManifest(manifestUrl, this.fetcher);
    const { manifest, manifestHash } = loaded;

    const [detBytes, recBytes, dictBytes] = await Promise.all([
      fetchVerifiedAsset(loaded.asset("det"), this.fetcher),
      fetchVerifiedAsset(loaded.asset("rec"), this.fetcher),
      fetchVerifiedAsset(loaded.asset("dict"), this.fetcher),
    ]);

    const dictionary = parseDictionary(new TextDecoder().decode(dictBytes));
    const expectedEntries = manifest.recognition.decoder.dictionaryEntries;
    if (dictionary.length !== expectedEntries) {
      throw new ReceiptLensError(
        "MODEL_LOAD_FAILED",
        `recognition dictionary has ${dictionary.length} entries, manifest declares ${expectedEntries}`,
      );
    }

    const ort = await (this.options.loadRuntime ? this.options.loadRuntime() : importOrtRuntime());
    const numThreads = resolveThreadCount(this.options.numThreads);
    ort.env.wasm.numThreads = numThreads;
    if (this.options.wasmPaths) ort.env.wasm.wasmPaths = this.options.wasmPaths;

    const sessionOptions = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
    const [det, rec] = await Promise.all([
      ort.InferenceSession.create(detBytes, sessionOptions),
      ort.InferenceSession.create(recBytes, sessionOptions),
    ]);

    this.state = { ort, det, rec, dictionary, manifest };
    this.manifestHash = manifestHash;
    this.assetBytes = detBytes.byteLength + recBytes.byteLength + dictBytes.byteLength;
    this.version = `${manifest.providerVersion}-${manifest.preset}+sha256.${manifestHash.slice(0, 12)}`;
    this.sessionInfo = {
      executionProvider: "wasm",
      numThreads,
      detection: { inputNames: [...det.inputNames], outputNames: [...det.outputNames] },
      recognition: { inputNames: [...rec.inputNames], outputNames: [...rec.outputNames] },
    };
  }

  async recognize(image: ImageBitmap | Blob | File): Promise<OcrResult> {
    const environment = this.options.environment ?? browserOcrEnvironment;
    const decoded = await environment.decode(image);
    try {
      await this.load();
      const state = this.state;
      if (!state) throw new ReceiptLensError("MODEL_LOAD_FAILED", "the model set is not loaded");
      const { manifest } = state;

      const detPre = manifest.detection.preprocessing;
      const plan = planDetResize(decoded.width, decoded.height, detPre);
      const detPixels = environment.render(
        decoded.bitmap,
        { x: 0, y: 0, width: decoded.width, height: decoded.height },
        plan.width,
        plan.height,
      );
      const detTensor = new state.ort.Tensor("float32", toChwTensor(detPixels, detPre), [
        1,
        3,
        plan.height,
        plan.width,
      ]);
      const probability = await this.runSession(
        "detection",
        state.det,
        { [manifest.detection.inputName]: detTensor },
        manifest.detection.inputName,
      );

      if (probability.dims.length !== 4) {
        throw new ReceiptLensError(
          "RECOGNIZE_FAILED",
          `detection output has ${probability.dims.length} dimensions, expected 4`,
        );
      }
      const mapHeight = probability.dims[2]!;
      const mapWidth = probability.dims[3]!;
      const detections = dbPostprocess(
        probability.data,
        mapWidth,
        mapHeight,
        manifest.detection.postprocessing,
      );
      const boxes = scaleBoxesToImage(detections, mapWidth, mapHeight, decoded.width, decoded.height);

      const empty: OcrResult = {
        lines: [],
        imageSize: { width: decoded.width, height: decoded.height },
        provider: this.name,
        version: this.version,
      };
      // A receipt with no detectable text is a valid zero-word result, not an error.
      if (boxes.length === 0) return empty;

      const recPre = manifest.recognition.preprocessing;
      const decoder = manifest.recognition.decoder;
      const words: OcrWord[] = [];

      for (const box of boxes) {
        const clipped: Box = {
          x: Math.max(0, box.x),
          y: Math.max(0, box.y),
          width: Math.min(box.width, decoded.width - Math.max(0, box.x)),
          height: Math.min(box.height, decoded.height - Math.max(0, box.y)),
        };
        if (clipped.width < 3 || clipped.height < 3) continue;

        const size = planRecognitionSize(clipped.width, clipped.height, recPre);
        const crop = environment.render(decoded.bitmap, clipped, size.drawnWidth, size.height);
        const input = new state.ort.Tensor("float32", toChwTensor(crop, recPre, size.targetWidth), [
          1,
          3,
          size.height,
          size.targetWidth,
        ]);
        const logits = await this.runSession(
          "recognition",
          state.rec,
          { [manifest.recognition.inputName]: input },
          manifest.recognition.inputName,
        );

        if (logits.dims.length !== 3) {
          throw new ReceiptLensError(
            "RECOGNIZE_FAILED",
            `recognition output has ${logits.dims.length} dimensions, expected 3`,
          );
        }
        const timesteps = logits.dims[1]!;
        const classes = logits.dims[2]!;

        let decodedText: CtcDecoded;
        try {
          decodedText = ctcGreedyDecode(logits.data, timesteps, classes, state.dictionary, {
            blankIndex: decoder.blankIndex,
            outputActivation: decoder.outputActivation,
          });
        } catch (cause) {
          throw new ReceiptLensError("RECOGNIZE_FAILED", "recognized logits do not match the model vocabulary", {
            cause,
          });
        }
        if (decodedText.chars.length === 0) continue;
        words.push(...toWords(decodedText, clipped));
      }

      return {
        lines: groupWordsIntoLines(words, manifest.readingOrder.toleranceRatio),
        imageSize: { width: decoded.width, height: decoded.height },
        provider: this.name,
        version: this.version,
      };
    } finally {
      if (decoded.owned) decoded.bitmap.close();
    }
  }

  private async runSession(
    stage: "detection" | "recognition",
    session: OrtSession,
    feeds: Record<string, object>,
    inputName: string,
  ): Promise<OrtTensor> {
    let output: Record<string, OrtTensor>;
    try {
      output = await session.run(feeds);
    } catch (cause) {
      throw new ReceiptLensError("RECOGNIZE_FAILED", `${stage} inference failed`, { cause });
    }
    const name = session.outputNames[0];
    const tensor = name === undefined ? undefined : output[name];
    if (!tensor) {
      throw new ReceiptLensError(
        "RECOGNIZE_FAILED",
        `${stage} produced no output tensor for input "${inputName}"`,
      );
    }
    return tensor;
  }
}

async function importOrtRuntime(): Promise<OrtRuntime> {
  // WASM-only build: no WebGPU/WebGL artifacts are bundled or attempted.
  return (await import("onnxruntime-web/wasm")) as unknown as OrtRuntime;
}

export function createPPOCRv6Provider(options: PPOCRv6ProviderOptions = {}): PPOCRv6Provider {
  return new PPOCRv6Provider(options);
}
