import { defineConfig } from "vitest/config";

// Unit tests for the pure logic in both workspaces. Nothing here needs a DOM,
// so the node environment is enough and fast.
export default defineConfig({
  test: {
    include: ["server/src/**/*.test.ts", "web/src/**/*.test.ts"],
    environment: "node",
  },
});
