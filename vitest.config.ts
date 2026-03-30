import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "dist/**",
      "node_modules/**",
      // Isolated pipeline workspaces are cloned inside .ripline/runs/ — exclude
      // them to prevent vitest from picking up Wintermute tests that require
      // jsdom and other browser deps not installed in Ripline.
      ".ripline/**",
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
