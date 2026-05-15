import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@actions/core": path.resolve(__dirname, "src/__tests__/mocks/actions-core.ts"),
      "@actions/github": path.resolve(__dirname, "src/__tests__/mocks/actions-github.ts"),
    },
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/__tests__/**", "src/index.ts"],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
      },
    },
  },
});
