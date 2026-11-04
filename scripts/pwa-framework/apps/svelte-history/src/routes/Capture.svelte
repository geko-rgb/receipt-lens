<script>
  import { runOcrOnce } from "../lib/ocr.js";

  async function loadOcr() {
    window.__probe.ocr = "loading";
    try {
      const out = await runOcrOnce();
      window.__probe.ocr = "ready";
      window.__probe.parsed = { ...out, isolated: window.crossOriginIsolated };
    } catch (error) {
      window.__probe.ocr = "error";
      window.__probe.error = String(error && error.message ? error.message : error);
    }
  }
</script>

<h1>Capture</h1>
<p>placeholder view — ticket 10 owns this flow</p>
<button id="run-ocr" type="button" onclick={loadOcr}>load OCR runtime</button>
