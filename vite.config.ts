import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    target: "es2022",
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    // Two pages: the coming-soon page and the interview at /talk/. Each keeps
    // its own stylesheet, so the home page never ships the interview's CSS.
    cssCodeSplit: true,
    sourcemap: false,
    reportCompressedSize: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        talk: resolve(import.meta.dirname, "talk/index.html"),
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
