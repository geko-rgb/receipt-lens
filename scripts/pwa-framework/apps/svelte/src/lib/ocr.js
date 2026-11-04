/**
 * The lazy OCR path, verbatim in shape with what ticket 10 will do: the ONNX runtime is
 * reached through core's own dynamic `import("onnxruntime-web/wasm")`, triggered from a
 * user action rather than at module evaluation. The probe measures whether a framework
 * build keeps it out of the first-paint graph.
 */
let load = null;

export function runOcrOnce() {
  if (!load) {
    load = (async () => {
      const { createPPOCRv6Provider } = await import("@receipt-lens/core");
      const provider = createPPOCRv6Provider({
        assetBaseUrl: "/assets/models/",
        wasmPaths: "/ort/",
        numThreads: "auto",
      });
      await provider.load();
      const blob = await fetch("/sample.jpg").then((response) => response.blob());
      const file = new File([blob], "sample.jpg", { type: blob.type || "image/jpeg" });
      const result = await provider.recognize(file);
      return {
        threads: provider.sessionInfo?.numThreads ?? null,
        lines: result.lines.length,
        words: result.lines.reduce((count, line) => count + line.words.length, 0),
      };
    })();
    load.catch(() => {
      load = null;
    });
  }
  return load;
}
