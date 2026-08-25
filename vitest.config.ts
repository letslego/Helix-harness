import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@helix/kernel": resolve(__dirname, "packages/kernel/src/index.ts"),
      "@helix/runtime": resolve(__dirname, "packages/runtime/src/index.ts"),
      "@helix/agent": resolve(__dirname, "packages/agent/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
