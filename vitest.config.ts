import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts", "src/discord/gateway.ts"],
      // Floor locked at the M8 baseline (90.33 / 80.34 / 94.01). Thresholds may only go up.
      thresholds: { statements: 90, branches: 80, lines: 94 },
    },
  },
});
