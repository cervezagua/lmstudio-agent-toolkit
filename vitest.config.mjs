import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["plugin/src/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 20000,
    // Forks, not worker threads: PDF.js transfers ArrayBuffers, which fails across the separate
    // JS realm that vitest's thread pool uses ("Cannot transfer object of unsupported type").
    pool: "forks",
    server: {
      // Let unpdf (and the PDF.js build inside it) load as real Node modules; vite's transform
      // breaks PDF.js's buffer transfer, which works fine in the plugin's plain Node runtime.
      deps: { external: [/unpdf/, /pdfjs/, /@napi-rs\/canvas/] },
    },
  },
});
