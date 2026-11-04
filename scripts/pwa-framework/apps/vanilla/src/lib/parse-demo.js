/**
 * A static core import: the bill view will need parse()/validate() on first render, so
 * the probe bundles them eagerly and measures what survives tree-shaking. Only the OCR
 * runtime behind them stays lazy.
 */
import { parse, validate } from "@receipt-lens/core";

const DEMO_OCR = {
  imageSize: { width: 200, height: 120 },
  provider: "probe",
  version: "probe-0",
  lines: [
    {
      id: "l1",
      text: "KOPI 12.00",
      box: { x: 10, y: 20, width: 180, height: 10 },
      confidence: null,
      words: [
        { text: "KOPI", box: { x: 10, y: 20, width: 50, height: 10 }, confidence: null },
        { text: "12.00", box: { x: 150, y: 20, width: 40, height: 10 }, confidence: null },
      ],
    },
    {
      id: "l2",
      text: "TEH 8.00",
      box: { x: 10, y: 40, width: 180, height: 10 },
      confidence: null,
      words: [
        { text: "TEH", box: { x: 10, y: 40, width: 40, height: 10 }, confidence: null },
        { text: "8.00", box: { x: 155, y: 40, width: 35, height: 10 }, confidence: null },
      ],
    },
  ],
};

export function demoParse() {
  const result = parse(DEMO_OCR);
  const validation = validate(result);
  return { items: result.items.length, findings: validation.findings.length };
}
