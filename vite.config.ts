import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    target: "es2022",
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    // Three pages: the coming-soon page, the interview at /talk/, and the
    // client's private strategy at /strategy/<token>. Each keeps its own
    // stylesheet, so the home page never ships another page's CSS.
    cssCodeSplit: true,
    sourcemap: false,
    reportCompressedSize: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        talk: resolve(import.meta.dirname, "talk/index.html"),
        strategy: resolve(import.meta.dirname, "strategy/index.html"),
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
