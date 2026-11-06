/** Small output helpers (Korean user-facing text; no secrets). */
export function printJson(v: unknown): void {
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "-";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)}${u[i]}`;
}

export function fail(message: string, code = 1): never {
  process.stderr.write(`오류: ${message}\n`);
  process.exit(code);
}

export function table(rows: Array<Record<string, unknown>>, cols: string[]): string {
  const cells = rows.map((r) => cols.map((c) => String(r[c] ?? "")));
  const w = cols.map((c, i) => Math.max(c.length, ...cells.map((r) => [...r[i]!].length)));
  const line = (vals: string[]) => vals.map((v, i) => v + " ".repeat(Math.max(0, w[i]! - [...v].length))).join("  ");
  return [line(cols), line(w.map((n) => "-".repeat(n))), ...cells.map(line)].join("\n");
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

/**
 * embedded-postgres installs async-exit-hook, whose `beforeExit` handler calls `process.exit(0)` and
 * so drops `process.exitCode`. One-shot commands therefore exit explicitly; long-running ones
 * (`run`) mark themselves so main() leaves the process alive.
 */
let longRunning = false;
export function markLongRunning(): void {
  longRunning = true;
}
export function isLongRunning(): boolean {
  return longRunning;
}
