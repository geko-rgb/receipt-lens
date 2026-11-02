export interface OcrBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrWord {
  text: string;
  box: OcrBox;
  /** normalized 0..1 when the provider supplies a meaningful score; never fabricated */
  confidence: number | null;
}

export interface OcrLine {
  id: string;
  /** normalized, space-joined text */
  text: string;
  /** union of word boxes */
  box: OcrBox;
  /** mean of available meaningful word scores, otherwise null */
  confidence: number | null;
  words: OcrWord[];
}

export interface OcrResult {
  lines: OcrLine[];
  imageSize: { width: number; height: number };
  provider: string;
  /** provider version plus model hash prefix where available */
  version: string;
}
