import type { RecPreprocessing } from "../model-manifest.js";

export interface CtcChar {
  char: string;
  /** Probability of the chosen class — a real score, never imputed. */
  confidence: number;
}

export interface CtcDecoded {
  text: string;
  chars: CtcChar[];
  /** Mean of the kept character confidences, or null when nothing was decoded. */
  confidence: number | null;
}

export interface DecoderOptions {
  blankIndex: number;
  /**
   * Whether the graph already applies softmax. PP-OCRv6 Tiny's export does (every
   * timestep row sums to 1), so treating its output as logits would silently turn
   * every confidence into roughly 1/classes.
   */
  outputActivation: "softmax" | "logits";
}

/**
 * PP-OCR dictionaries are one character per line, CRLF in the upstream download.
 * The trailing newline is not a character.
 */
export function parseDictionary(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * CTC greedy decode.
 *
 * Class 0 is the CTC blank; classes 1..N map to dictionary lines 0..N-1. That offset
 * is the classic silent failure: with it off by one the model still "decodes" a full
 * string of plausible rubbish. `dictionaryEntries` is therefore asserted against the
 * model's class count by the caller before any text is produced.
 *
 * Repeats collapse first (a repeated index is skipped), then blanks are dropped, which
 * is the ordering PaddleOCR's `CTCLabelDecode` uses.
 */
export function ctcGreedyDecode(
  output: Float32Array,
  timesteps: number,
  classes: number,
  dictionary: readonly string[],
  options: DecoderOptions,
): CtcDecoded {
  const expectedClasses = dictionary.length + 1;
  if (classes !== expectedClasses) {
    throw new Error(
      `recognition output has ${classes} classes but the dictionary has ${dictionary.length} entries ` +
        `(+1 blank expected ${expectedClasses}); decoding would silently mis-map characters`,
    );
  }

  // A manifest that claims probabilities but receives logits (or vice versa) is exactly
  // the drift this check exists to catch, before it becomes plausible-looking text.
  if (options.outputActivation === "softmax" && timesteps > 0) {
    let rowSum = 0;
    for (let c = 0; c < classes; c += 1) rowSum += output[c]!;
    if (Math.abs(rowSum - 1) > 0.05) {
      throw new Error(
        `recognition output is declared softmax but timestep 0 sums to ${rowSum.toFixed(4)}; ` +
          "the manifest's outputActivation does not match the model",
      );
    }
  }

  const chars: CtcChar[] = [];
  let previous = -1;

  for (let t = 0; t < timesteps; t += 1) {
    const row = t * classes;
    let bestIndex = 0;
    let bestValue = output[row]!;
    for (let c = 1; c < classes; c += 1) {
      const value = output[row + c]!;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = c;
      }
    }

    if (bestIndex === previous) continue;
    previous = bestIndex;
    if (bestIndex === options.blankIndex) continue;

    const dictionaryIndex = bestIndex < options.blankIndex ? bestIndex : bestIndex - 1;
    const char = dictionary[dictionaryIndex];
    if (char === undefined) {
      throw new Error(`recognition class ${bestIndex} has no dictionary entry (index ${dictionaryIndex})`);
    }

    let confidence = bestValue;
    if (options.outputActivation === "logits") {
      let sum = 0;
      for (let c = 0; c < classes; c += 1) sum += Math.exp(output[row + c]! - bestValue);
      confidence = 1 / sum;
    }

    chars.push({ char, confidence });
  }

  return {
    text: chars.map((entry) => entry.char).join(""),
    chars,
    confidence: chars.length === 0 ? null : chars.reduce((total, entry) => total + entry.confidence, 0) / chars.length,
  };
}

/**
 * Recognition input plan: keep the crop's aspect ratio, put its height at
 * `pre.height`, and pad the right edge out to at least `baseWidth`. Long lines widen
 * up to `maxWidth` instead of being squashed (the exported graph has a dynamic W).
 */
export function planRecognitionSize(cropWidth: number, cropHeight: number, pre: RecPreprocessing): { drawnWidth: number; targetWidth: number; height: number } {
  const height = pre.height;
  const aspect = cropHeight > 0 ? cropWidth / cropHeight : 1;
  const natural = Math.min(Math.max(Math.round(height * aspect), 1), pre.maxWidth);
  const targetWidth = Math.min(Math.max(natural, pre.baseWidth), pre.maxWidth);
  return { drawnWidth: Math.min(natural, targetWidth), targetWidth, height };
}
