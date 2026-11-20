import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    target: "es2022",
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    // One page: the client's private strategy at /strategy/<token>. (The interview page was retired on
    // 20 Nov 2026; its address now shows a paused page from the private site overlay.)
    cssCodeSplit: true,
    sourcemap: false,
    reportCompressedSize: true,
    rolldownOptions: {
      input: {
        strategy: resolve(import.meta.dirname, "strategy/index.html"),
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Every line, branch and function of the page's code is tested (owner, 20 Nov 2026: "Ensure 100% tdd
    // coverage"). npm test fails below 100%.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary"],
      thresholds: { 100: true },
    },
  },
});
