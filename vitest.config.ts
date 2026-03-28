import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "dist/**",
      "node_modules/**",
      // CLI integration tests invoke the built binary via execSync and connect to
      // external services (Wintermute activity API). They are slow (~40s) and are
      // excluded from the default run to keep CI fast. Run manually with:
      //   npx vitest run tests/cli/
      "tests/cli/**",
    ],
    pool: "forks",
    forceExit: true,
  },
});
