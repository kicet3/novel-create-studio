import { defineConfig } from "vitest/config";

/**
 * Root vitest config. Each workspace package is a vitest "project" (vitest ≥3 replaces
 * vitest.workspace.ts with `test.projects`). Workspace packages are resolved to their TS
 * sources through the custom export condition "@ncs/source".
 */
const shared = {
  resolve: { conditions: ["@ncs/source"] },
  ssr: { resolve: { conditions: ["@ncs/source"], externalConditions: ["@ncs/source"] } },
};

export default defineConfig({
  test: {
    projects: [
      { ...shared, test: { name: "shared", root: "packages/shared", include: ["test/**/*.test.ts"] } },
      { ...shared, test: { name: "db", root: "packages/db", include: ["test/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000 } },
      { ...shared, test: { name: "test-kit", root: "packages/test-kit", include: ["test/**/*.test.ts"], passWithNoTests: true } },
      { ...shared, test: { name: "server", root: "apps/server", include: ["test/**/*.test.ts"], passWithNoTests: true, testTimeout: 60_000 } },
      { ...shared, test: { name: "cli", root: "apps/cli", include: ["test/**/*.test.ts"], passWithNoTests: true } },
      { ...shared, test: { name: "web", root: "apps/web", include: ["src/**/*.test.{ts,tsx}"], passWithNoTests: true } },
    ],
  },
});
