import { runOcrOnce } from "../lib/ocr.js";

export default function Capture() {
  return (
    <div>
      <h1>Capture</h1>
      <p>placeholder view - ticket 10 owns this flow</p>
      <button
        id="run-ocr"
        type="button"
        onClick={async () => {
          window.__probe.ocr = "loading";
          try {
            const out = await runOcrOnce();
            window.__probe.parsed = { ...out, isolated: window.crossOriginIsolated };
            window.__probe.ocr = "ready";
          } catch (error) {
            window.__probe.error = String(error && error.message ? error.message : error);
            window.__probe.ocr = "error";
          }
        }}
      >
        load OCR runtime
      </button>
    </div>
  );
}
