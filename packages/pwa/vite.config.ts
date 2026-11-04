import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  build: {
    // dist/ holds tsc output for the pure-TS modules; the deployable shell bundle goes to dist/app so
    // ticket 08's footprint remeasurement (DECISIONS/0017 D9) has one directory to read.
    outDir: "dist/app",
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
