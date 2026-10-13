import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";
import { mockApi } from "./dev/mock-api";

// The Rust server embeds `dist/` (crates/server/src/web.rs) and serves it with
// `script-src 'self'`, so the build must not emit inline scripts.
export default defineConfig({
  // `VITE_MOCK=1 npm run dev` serves a fake API (dev/mock-api.ts) instead of proxying to a server.
  plugins: [react(), tailwindcss(), ...(process.env.VITE_MOCK ? [mockApi()] : [])],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      // `opengrid serve` listens on 127.0.0.1:8080 by default.
      "/api": { target: "http://127.0.0.1:8080", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    // react-dom alone is ~180 kB minified; the warning threshold is not useful here. The lazily loaded
    // Lucide icon set (components/icons/fullSet.ts, ~810 kB, ~190 kB gzipped) is the one deliberate giant:
    // it is fetched only when an icon picker opens or an icon outside the bundled popular 20 is drawn.
    chunkSizeWarningLimit: 900,
    // Keep Vite from inlining assets as data: URIs or injecting inline scripts.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    restoreMocks: true,
  },
});
