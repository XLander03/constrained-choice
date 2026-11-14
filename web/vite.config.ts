import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The mock client runs the real pipeline from ../src (extractor, retriever, mock decider, router) in the browser.
// Backend modules import node:fs / node:crypto at the top level for file loaders and the Sheets exporter; the UI only
// uses their pure functions, so those built-ins resolve to a small shim.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: /^node:(fs|crypto)$/, replacement: fileURLToPath(new URL("./src/lib/node-shim.ts", import.meta.url)) }],
  },
  // Open the UI at http://localhost:5173 (or 5174): the API's default ALLOWED_ORIGINS lists exactly those, not 127.0.0.1.
  server: { host: "localhost", port: 5173, fs: { allow: [".."] } },
  preview: { host: "localhost", port: 5174 },
  build: { target: "es2022", chunkSizeWarningLimit: 900 },
});
