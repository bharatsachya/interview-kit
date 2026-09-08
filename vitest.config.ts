import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "scripts/**/*.test.ts"],
    // No real network and no real API key, ever. Anything that needs a provider
    // uses the fakes in packages/llm and packages/retrieval.
    testTimeout: 10_000,
  },
});
