/**
 * Spike/doctor helper: boot embedded PostgreSQL on a throwaway data dir, apply migrations,
 * check extensions, run a seed insert and stop.  Usage: pnpm db:check-embedded [port]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddedPostgresRuntime, createDb, postgresJsTarget, runMigrations } from "../src/index.js";
import { seedNovel } from "../src/testing/seed.js";

const port = Number(process.argv[2] ?? 54399);
const dir = mkdtempSync(join(tmpdir(), "ncs-pg-check-"));
const rt = new EmbeddedPostgresRuntime({ dataDir: dir, port });
const t0 = Date.now();
try {
  await rt.start();
  console.log(`started embedded PG on ${port} in ${Date.now() - t0} ms (data: ${dir})`);
  const h = createDb(rt.url, { max: 2 });
  const [{ version }] = (await h.sql`SELECT version()`) as unknown as [{ version: string }];
  console.log(version);
  const r = await runMigrations(postgresJsTarget(h.sql), { appVersion: "check", requireExtensions: ["btree_gist"] });
  console.log(`migrations applied: ${r.applied.join(", ")}`);
  const ext = await h.sql`SELECT extname FROM pg_extension ORDER BY 1`;
  console.log(`extensions: ${ext.map((e) => e.extname).join(", ")}`);
  const avail = await h.sql`SELECT name FROM pg_available_extensions WHERE name IN ('btree_gist','pg_trgm','vector') ORDER BY 1`;
  console.log(`available: ${avail.map((e) => e.name).join(", ")}`);
  const trgm = await h.sql`SELECT show_trgm('회귀자') AS t`;
  console.log(`pg_trgm on Hangul: ${JSON.stringify(trgm[0]?.t)}`);
  const seeded = await seedNovel(h.db);
  console.log(`seeded novel ${seeded.novelId}`);
  const ex = await h.sql`SELECT conname FROM pg_constraint WHERE contype = 'x' ORDER BY 1`;
  console.log(`exclude constraints: ${ex.map((e) => e.conname).join(", ")}`);
  await h.close();
  console.log("OK");
} finally {
  await rt.stop();
  rmSync(dir, { recursive: true, force: true });
}
