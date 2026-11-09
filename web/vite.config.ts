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
      // `openbase serve` listens on 127.0.0.1:8080 by default.
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: false,
        // The server refuses cookie requests whose Origin is not its public URL, and the browser
        // sends the dev server's (:5173). Present the request as the page the server expects.
        configure: (proxy) => {
          const origin = process.env["OPENBASE_PUBLIC_URL"] ?? "http://localhost:8080";
          proxy.on("proxyReq", (proxyReq) => {
            if (proxyReq.getHeader("origin")) proxyReq.setHeader("origin", origin);
            if (proxyReq.getHeader("referer")) proxyReq.setHeader("referer", `${origin}/`);
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    // react-dom alone is ~180 kB minified; the warning threshold is not useful here.
    chunkSizeWarningLimit: 900,
    // Keep Vite from inlining assets as data: URIs or injecting inline scripts.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // .mjs: styles/checkTokens.test.mjs tests scripts/check-tokens.mjs, which is plain Node.
    include: ["src/**/*.test.{ts,tsx,mjs}"],
    css: false,
    restoreMocks: true,
  },
});
