import { demoParse } from "./lib/parse-demo.js";

const views = {
  "/": () => `<h1>Capture</h1><p>placeholder view</p><button id="run-ocr" type="button">load OCR runtime</button>`,
  "/bill": () => `<h1>Bill</h1><p>placeholder view</p><span id="parse-items">${demoParse().items}</span>`,
  "/share": () => `<h1>Share</h1><p>placeholder view</p>`,
};

window.__probe = { rawHash: "", routeParam: "", ocr: "idle", parsed: null, error: null };

function currentPath() {
  const path = window.location.pathname;
  return views[path] ? path : (path.startsWith("/v1") ? "/share" : "/");
}

function render() {
  const app = document.getElementById("app");
  const path = currentPath();
  app.innerHTML = `<nav><a href="/">capture</a><a href="/bill">bill</a><a href="/share">share</a></nav><main>${views[path]()}</main>`;
  window.__probe.rawHash = window.location.hash;
  window.__probe.routePath = path;
  if (path.startsWith("/v1")) window.__probe.routeParam = decodeURIComponent(path.slice(4));
  document.querySelectorAll("nav a").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      window.history.pushState({}, "", link.getAttribute("href"));
      render();
    });
  });
  const button = document.getElementById("run-ocr");
  if (button) {
    button.addEventListener("click", async () => {
      window.__probe.ocr = "loading";
      try {
        const { runOcrOnce } = await import("./lib/ocr.js");
        const out = await runOcrOnce();
        window.__probe.parsed = { ...out, isolated: window.crossOriginIsolated };
        window.__probe.ocr = "ready";
      } catch (error) {
        window.__probe.error = String(error && error.message ? error.message : error);
        window.__probe.ocr = "error";
      }
    });
  }
}

window.addEventListener("popstate", render);
render();
window.__probeMounted = true;
