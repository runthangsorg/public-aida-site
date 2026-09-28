import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    target: "es2022",
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    sourcemap: false,
    reportCompressedSize: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
