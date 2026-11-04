import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { VitePWA } from "vite-plugin-pwa";

const variant = process.env.VARIANT || "bare-hash";
const withPwa = variant.startsWith("pwa");
const routerMode = variant.includes("history") ? "history" : "hash";
const bigLimit = 20 * 1024 * 1024;

const pwa = VitePWA({
  strategies: "generateSW",
  registerType: "autoUpdate",
  injectRegister: null,
  manifest: { id: "/", name: "probe", short_name: "probe", start_url: "/", display: "standalone" },
    workbox: {
    globPatterns: ["**/*.{js,css,html,wasm}"],
    ...(variant === "pwa-big" ? { maximumFileSizeToCacheInBytes: bigLimit } : {}),
  },
});

export default defineConfig({
  envPrefix: "VITE_",
  plugins: [svelte(), ...(withPwa ? [pwa] : [])],
  build: { outDir: `dist/${variant}`, emptyOutDir: true, manifest: true, sourcemap: false, assetsInlineLimit: 0 },
  define: { "import.meta.env.VITE_ROUTER_MODE": JSON.stringify(routerMode) },
});
