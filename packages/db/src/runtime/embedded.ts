/**
 * Embedded PostgreSQL lifecycle (embedded-postgres, design/08 §1.3).
 * - ensureInitialized(): initdb on first use (data dir empty / missing PG_VERSION)
 * - start(): starts the child postmaster, or attaches to one already running on the same data dir
 * - stop(): stops the postmaster only if this runtime started it
 * - ensureDatabase(): creates the application database (default "ncs") if missing
 */
import { existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";
import { expandHome } from "./paths.js";

export interface EmbeddedPgOptions {
  dataDir: string;
  port: number;
  user?: string;
  password?: string;
  database?: string;
  onLog?: (msg: string) => void;
  onError?: (msg: unknown) => void;
}

export interface EmbeddedPgStatus {
  dataDir: string;
  port: number;
  initialized: boolean;
  running: boolean;
  pid: number | null;
  ownedByThisProcess: boolean;
}

function readPostmasterPid(dataDir: string): { pid: number; port: number | null } | null {
  const f = join(dataDir, "postmaster.pid");
  if (!existsSync(f)) return null;
  const lines = readFileSync(f, "utf8").split("\n");
  const pid = Number(lines[0]);
  const port = Number(lines[3]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, port: Number.isInteger(port) ? port : null };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class EmbeddedPostgresRuntime {
  readonly dataDir: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  private pg: EmbeddedPostgres;
  private owned = false;

  constructor(private readonly opts: EmbeddedPgOptions) {
    this.dataDir = expandHome(opts.dataDir);
    this.port = opts.port;
    this.user = opts.user ?? "ncs";
    this.password = opts.password ?? "ncs";
    this.database = opts.database ?? "ncs";
    this.pg = new EmbeddedPostgres({
      databaseDir: this.dataDir,
      port: this.port,
      user: this.user,
      password: this.password,
      authMethod: "scram-sha-256",
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: opts.onLog ?? (() => {}),
      onError: opts.onError ?? (() => {}),
    });
  }

  get isInitialized(): boolean {
    return existsSync(join(this.dataDir, "PG_VERSION"));
  }

  /** URL for the application database. */
  get url(): string {
    return `postgres://${encodeURIComponent(this.user)}:${encodeURIComponent(this.password)}@127.0.0.1:${this.port}/${this.database}`;
  }

  async ensureInitialized(): Promise<void> {
    if (this.isInitialized) return;
    mkdirSync(this.dataDir, { recursive: true });
    try {
      chmodSync(this.dataDir, 0o700);
    } catch {
      /* best effort (Windows) */
    }
    await this.pg.initialise();
  }

  status(): EmbeddedPgStatus {
    const pidInfo = readPostmasterPid(this.dataDir);
    const running = pidInfo !== null && isAlive(pidInfo.pid);
    return {
      dataDir: this.dataDir,
      port: this.port,
      initialized: this.isInitialized,
      running,
      pid: running ? pidInfo!.pid : null,
      ownedByThisProcess: this.owned,
    };
  }

  /** Initialise if needed, start (or attach to an already running postmaster) and ensure the app database. */
  async start(): Promise<void> {
    await this.ensureInitialized();
    const pidInfo = readPostmasterPid(this.dataDir);
    if (pidInfo && isAlive(pidInfo.pid)) {
      if (pidInfo.port !== null && pidInfo.port !== this.port) {
        throw new Error(`Embedded PostgreSQL for ${this.dataDir} is already running on port ${pidInfo.port} (pid ${pidInfo.pid}), expected ${this.port}`);
      }
      this.owned = false; // attach to the running instance
    } else {
      await this.pg.start();
      this.owned = true;
    }
    await this.ensureDatabase();
  }

  async ensureDatabase(): Promise<void> {
    const admin = postgres({ host: "127.0.0.1", port: this.port, user: this.user, password: this.password, database: "postgres", max: 1, onnotice: () => {} });
    try {
      const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${this.database}`;
      if (rows.length === 0) await admin.unsafe(`CREATE DATABASE "${this.database.replace(/"/g, '""')}" ENCODING 'UTF8'`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  }

  /** Stop the postmaster if this runtime started it (attach-only runtimes leave it running). */
  async stop(opts: { force?: boolean } = {}): Promise<void> {
    if (!this.owned && !opts.force) return;
    await this.pg.stop();
    this.owned = false;
  }
}
