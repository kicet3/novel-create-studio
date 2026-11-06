import { defineConfig } from "vitest/config";

/**
 * Opt-in REAL Supabase smoke (`NCS_TEST_SUPABASE_URL=… pnpm test:supabase`, after `pnpm build`): boots the built server
 * against that database in a throwaway schema, see apps/server/test-supabase/boot.supabase.test.ts. Skips without the URL.
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
          name: "server-supabase",
          root: "apps/server",
          include: ["test-supabase/**/*.supabase.test.ts"],
          testTimeout: 10 * 60_000,
          hookTimeout: 2 * 60_000,
          fileParallelism: false,
          passWithNoTests: true,
          silent: false,
        },
      },
    ],
  },
});
