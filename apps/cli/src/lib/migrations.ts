import { loadMigrations, type MigrationFile, type MigrationTarget } from "@ncs/db";

export interface MigrationStatus {
  known: string[];
  applied: Array<{ id: string; name: string; appliedAt: string | null; appVersion: string | null }>;
  pending: string[];
  /** applied in DB but unknown to this app (DB is newer → downgrade) */
  unknown: string[];
  checksumMismatch: string[];
  ok: boolean;
}

export async function migrationStatus(target: MigrationTarget, migrations: MigrationFile[] = loadMigrations()): Promise<MigrationStatus> {
  const [t] = await target.query<{ r: string | null }>(`SELECT to_regclass('public.app_migrations')::text AS r`);
  const rows = t?.r
    ? await target.query<{ id: string; name: string; checksum: string; applied_at: Date | string | null; app_version: string | null }>(
        `SELECT id, name, checksum, applied_at, app_version FROM app_migrations ORDER BY id`,
      )
    : [];
  const known = new Map(migrations.map((m) => [m.id, m]));
  const appliedIds = new Set(rows.map((r) => r.id));
  const unknown = rows.filter((r) => !known.has(r.id)).map((r) => `${r.id}_${r.name}`);
  const checksumMismatch = rows.filter((r) => known.has(r.id) && known.get(r.id)!.checksum !== r.checksum).map((r) => `${r.id}_${r.name}`);
  const pending = migrations.filter((m) => !appliedIds.has(m.id)).map((m) => `${m.id}_${m.name}`);
  return {
    known: migrations.map((m) => `${m.id}_${m.name}`),
    applied: rows.map((r) => ({ id: r.id, name: r.name, appliedAt: r.applied_at ? new Date(r.applied_at).toISOString() : null, appVersion: r.app_version })),
    pending,
    unknown,
    checksumMismatch,
    ok: !unknown.length && !checksumMismatch.length,
  };
}
