import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.js"],
    coverage: {
      reporter: ["text", "html"],
      include: ["src/rules/**/*.js"],
      exclude: ["src/rules/**/*.test.js", "src/rules/__fixtures__/**"],
    },
  },
});
