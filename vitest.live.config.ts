import { defineConfig } from "vitest/config";

/**
 * Opt-in LIVE suite (`pnpm test:live`): calls the real Claude API (ANTHROPIC_API_KEY) and/or the real Claude Code CLI
 * (`claude -p`, dev mode). Not part of `pnpm test` (root vitest.config.ts only includes `test/**`). Each lane skips
 * itself with a printed reason when unavailable. Files: apps/server/test-live/**\/*.live.test.ts.
 */
const shared = {
  resolve: { conditions: ["@ncs/source"] },
  ssr: { resolve: { conditions: ["@ncs/source"], externalConditions: ["@ncs/source"] } },
};

export default defineConfig({
  test: {
    reporters: ["verbose"],
    projects: [
      {
        ...shared,
        test: {
          name: "server-live",
          root: "apps/server",
          include: ["test-live/**/*.live.test.ts"],
          // real model calls can take minutes each
          testTimeout: 45 * 60_000,
          hookTimeout: 5 * 60_000,
          fileParallelism: false,
          sequence: { concurrent: false },
          passWithNoTests: true,
          // always show the lanes' skip reasons and the call report (also for passing tests)
          silent: false,
        },
      },
    ],
  },
});
