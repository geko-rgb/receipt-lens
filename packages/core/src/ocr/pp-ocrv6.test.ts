import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ReceiptLensError } from "../errors.js";
import type { FetchLike, ModelManifest } from "./model-manifest.js";
import { ocr, type OcrProvider } from "./provider.js";
import type { OcrResult } from "./types.js";
import { PPOCRv6Provider, type OrtRuntime } from "./pp-ocrv6.js";
import { planDetResize } from "./pp-ocrv6/detect.js";
import type { DecodedImage, OcrEnvironment } from "./pp-ocrv6/image.js";
import { groupWordsIntoLines } from "./pp-ocrv6/lines.js";
import { ctcGreedyDecode, parseDictionary } from "./pp-ocrv6/recognize.js";

const modelsUrl = new URL("../../../../assets/models/", import.meta.url);
const manifestText = await readFile(new URL("manifest.json", modelsUrl), "utf8");
const manifest = JSON.parse(manifestText) as ModelManifest;
const dictionary = parseDictionary(await readFile(new URL("PP-OCRv6_tiny_rec.txt", modelsUrl), "utf8"));
const imageWidth = 320;
const imageHeight = 480;

/** Class index for a character: 0 is CTC blank, dictionary line i is class i+1. */
function classOf(char: string): number {
  const index = dictionary.indexOf(char);
  if (index < 0) throw new Error(`character not in dictionary: ${JSON.stringify(char)}`);
  return index + 1;
}

/**
 * Encodes text as one-hot *probabilities* — these exports already apply softmax.
 * Repeated characters are separated by a blank, exactly as a real recognizer emits
 * them, which makes the collapse rule observable rather than incidental.
 */
function encodeText(text: string, classes: number): { data: Float32Array; timesteps: number } {
  const sequence: number[] = [0];
  let previous = -1;
  for (const char of text) {
    const cls = classOf(char);
    if (cls === previous) sequence.push(0);
    sequence.push(cls);
    previous = cls;
  }
  sequence.push(0);

  const timesteps = sequence.length;
  const data = new Float32Array(timesteps * classes);
  sequence.forEach((cls, step) => {
    data[step * classes + cls] = 0.98;
  });
  return { data, timesteps };
}

function createFetch(options: { tamperAsset?: string } = {}): FetchLike {
  return async (url: string) => {
    if (url.endsWith("manifest.json")) return new Response(manifestText);
    const asset = manifest.assets.find((candidate) => candidate.url === url);
    if (!asset) return new Response("not found", { status: 404 });
    const bytes = new Uint8Array(await readFile(new URL(asset.file, modelsUrl)));
    if (options.tamperAsset === asset.file) {
      bytes[0] = bytes[0]! ^ 0xff;
      return new Response(bytes);
    }
    return new Response(bytes);
  };
}

interface RuntimeOptions {
  /** Probability map for the probed input dimensions; all zeros means "no text". */
  detProbability: (height: number, width: number) => Float32Array;
  recOutput: (classes: number) => { data: Float32Array; timesteps: number };
  recClasses?: number;
}

const detBytes = (): number => manifest.assets.find((asset) => asset.role === "det")!.bytes;

function createRuntime(options: RuntimeOptions): OrtRuntime {
  const Tensor = class {
    readonly data: Float32Array;
    readonly dims: number[];
    constructor(_type: string, data: Float32Array, dims: number[]) {
      this.data = data;
      this.dims = dims;
    }
  };

  const session = (produce: (dims: number[]) => { data: Float32Array; dims: number[] }) => ({
    inputNames: ["x"],
    outputNames: ["fetch_name_0"],
    run: async (feeds: Record<string, object>) => {
      const input = feeds.x as { dims: number[] };
      return { fetch_name_0: produce(input.dims) };
    },
  });

  const detSession = session((dims) => {
    const [, , height, width] = dims as [number, number, number, number];
    return { dims: [1, 1, height, width], data: options.detProbability(height, width) };
  });
  const recSession = session(() => {
    const classes = options.recClasses ?? dictionary.length + 1;
    const encoded = options.recOutput(classes);
    return { dims: [1, encoded.timesteps, classes], data: encoded.data };
  });

  return {
    Tensor: Tensor as unknown as OrtRuntime["Tensor"],
    InferenceSession: {
      create: async (model: ArrayBuffer | Uint8Array) =>
        model.byteLength === detBytes() ? detSession : recSession,
    },
    env: { wasm: { numThreads: 1 } },
  };
}

const environment: OcrEnvironment = {
  decode: async (): Promise<DecodedImage> => ({
    bitmap: {} as unknown as ImageBitmap,
    width: imageWidth,
    height: imageHeight,
    owned: false,
  }),
  render: (_bitmap, _region, outWidth, outHeight) => ({
    data: new Uint8ClampedArray(outWidth * outHeight * 4),
    width: outWidth,
    height: outHeight,
  }),
};

/** One solid text-ish blob, so detection produces exactly one box. */
function oneBlob(height: number, width: number): Float32Array {
  const map = new Float32Array(height * width);
  for (let y = 100; y < 122 && y < height; y += 1) {
    for (let x = 40; x < 282 && x < width; x += 1) map[y * width + x] = 0.9;
  }
  return map;
}

function providerFor(options: RuntimeOptions, fetch = createFetch()): PPOCRv6Provider {
  return new PPOCRv6Provider({
    fetch,
    loadRuntime: async () => createRuntime(options),
    environment,
    numThreads: 1,
  });
}

describe("PP-OCRv6 provider pipeline", () => {
  it("turns a blank image into a valid zero-word result, not an error", async () => {
    const provider = providerFor({
      detProbability: (height, width) => new Float32Array(height * width),
      recOutput: () => ({ data: new Float32Array(0), timesteps: 0 }),
    });

    const result = await provider.recognize(new Blob([]));

    expect(result.lines).toEqual([]);
    expect(result.imageSize).toEqual({ width: imageWidth, height: imageHeight });
    expect(result.provider).toBe("pp-ocrv6");
    expect(result.version).toMatch(/^1\.0\.0-tiny\+sha256\.[0-9a-f]{12}$/);
    expect(provider.assetBytes).toBeGreaterThan(6_000_000);
    expect(provider.sessionInfo?.executionProvider).toBe("wasm");
  });

  it("decodes recognized text with the real dictionary and splits it into word boxes", async () => {
    const provider = providerFor({
      detProbability: oneBlob,
      recOutput: (classes) => encodeText("TOTAL 340.00", classes),
    });

    const result = await provider.recognize(new Blob([]));

    expect(result.lines).toHaveLength(1);
    const line = result.lines[0]!;
    expect(line.text).toBe("TOTAL 340.00");
    expect(line.words.map((word) => word.text)).toEqual(["TOTAL", "340.00"]);
    expect(line.id).toBe("l1");

    // Geometry stays inside the detected box and is ordered left to right.
    expect(line.box.y).toBeLessThanOrEqual(100);
    expect(line.box.x).toBeGreaterThan(0);
    expect(line.words[1]!.box.x).toBeGreaterThan(line.words[0]!.box.x);

    // Confidence is the recognizer's own probability, never an invented value.
    for (const word of line.words) {
      expect(word.confidence).toBeCloseTo(0.98, 5);
    }
    expect(line.confidence).toBeCloseTo(0.98, 5);
  });

  it("fails loudly when the model vocabulary does not match the dictionary", async () => {
    const provider = providerFor({
      detProbability: oneBlob,
      recClasses: dictionary.length + 2,
      recOutput: (classes) => encodeText("TOTAL", classes),
    });

    await expect(provider.recognize(new Blob([]))).rejects.toMatchObject({
      name: "ReceiptLensError",
      code: "RECOGNIZE_FAILED",
    });
  });

  it("fails loudly when the declared output activation does not match the model", async () => {
    // Row sums of 6906, i.e. raw logits, while the manifest says probabilities.
    const provider = providerFor({
      detProbability: oneBlob,
      recOutput: (classes) => ({ data: new Float32Array(4 * classes).fill(0), timesteps: 4 }),
    });

    await expect(provider.recognize(new Blob([]))).rejects.toMatchObject({
      name: "ReceiptLensError",
      code: "RECOGNIZE_FAILED",
    });
  });

  it("rejects a tampered model asset instead of running it", async () => {
    const provider = providerFor(
      {
        detProbability: oneBlob,
        recOutput: (classes) => encodeText("TOTAL", classes),
      },
      createFetch({ tamperAsset: "PP-OCRv6_tiny_rec.onnx" }),
    );

    await expect(provider.load()).rejects.toMatchObject({
      name: "ReceiptLensError",
      code: "MODEL_LOAD_FAILED",
    });
  });

  it("reports an undecodable file as IMAGE_UNREADABLE", async () => {
    const provider = new PPOCRv6Provider({
      fetch: createFetch(),
      loadRuntime: async () =>
        createRuntime({
          detProbability: oneBlob,
          recOutput: (classes) => encodeText("TOTAL", classes),
        }),
    });

    const error = await provider.recognize(new Blob(["this is not an image"])).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReceiptLensError);
    expect((error as ReceiptLensError).code).toBe("IMAGE_UNREADABLE");
  });
});

describe("OcrProvider contract", () => {
  it("is satisfied by a second, non-PP-OCRv6 implementation", async () => {
    const result: OcrResult = {
      lines: [
        {
          id: "l1",
          text: "PARCEL 120.00",
          box: { x: 0, y: 0, width: 100, height: 10 },
          confidence: null,
          words: [
            { text: "PARCEL", box: { x: 0, y: 0, width: 60, height: 10 }, confidence: null },
            { text: "120.00", box: { x: 70, y: 0, width: 30, height: 10 }, confidence: null },
          ],
        },
      ],
      imageSize: { width: 200, height: 300 },
      provider: "stub",
      version: "0.1.0",
    };
    const stub: OcrProvider = { name: "stub", version: "0.1.0", recognize: async () => result };

    await expect(ocr(new Blob([]), { provider: stub })).resolves.toBe(result);
    expect(result.lines[0]!.confidence).toBeNull();
    expect(result.lines[0]!.words.every((word) => word.confidence === null)).toBe(true);
  });

  it("refuses to run without a provider", async () => {
    await expect(ocr(new Blob([]), {} as { provider: OcrProvider })).rejects.toBeInstanceOf(TypeError);
  });
});

describe("OCR geometry and decoding units", () => {
  it("caps detection at 960 on the long side and snaps both sides to 32", () => {
    const plan = planDetResize(1920, 1080, manifest.detection.preprocessing);
    expect(plan.width % 32).toBe(0);
    expect(plan.height % 32).toBe(0);
    expect(plan.width).toBe(960);
    expect(plan.scaleX).toBeCloseTo(2, 5);
  });

  it("keeps a null line confidence when no word carries a score", () => {
    const lines = groupWordsIntoLines(
      [
        { text: "A", box: { x: 0, y: 0, width: 10, height: 10 }, confidence: null },
        { text: "B", box: { x: 20, y: 1, width: 10, height: 10 }, confidence: null },
      ],
      0.5,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("A B");
    expect(lines[0]!.confidence).toBeNull();
  });

  it("collapses CTC repeats and drops blanks without losing doubled characters", () => {
    const classes = 4;
    const small = ["A", "B", "C"];
    // rows: blank, A, A (collapses), blank, B
    const probabilities = new Float32Array(5 * classes);
    probabilities[0 * classes + 0] = 1;
    probabilities[1 * classes + 1] = 0.9;
    probabilities[2 * classes + 1] = 0.9;
    probabilities[3 * classes + 0] = 1;
    probabilities[4 * classes + 2] = 0.9;

    const decoded = ctcGreedyDecode(probabilities, 5, classes, small, {
      blankIndex: 0,
      outputActivation: "softmax",
    });
    expect(decoded.text).toBe("AB");
    expect(decoded.confidence).toBeCloseTo(0.9, 5);
  });
});
