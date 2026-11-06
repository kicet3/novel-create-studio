import { describe, expect, it } from "vitest";
import { createRuntime, createWorkerPool } from "../src/runtime/index.js";
import { createLogger, createWorkSignal } from "../src/platform/index.js";

describe("worker pool", () => {
  it("never exceeds concurrency and drains", async () => {
    const pool = createWorkerPool(2);
    let active = 0;
    let peak = 0;
    const job = () =>
      pool.submit(async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      });
    await Promise.all([job(), job(), job(), job(), job()]);
    expect(peak).toBe(2);
    await pool.drain();
    expect(pool.active).toBe(0);
    pool.close();
    await expect(pool.submit(async () => 1)).rejects.toThrow(/closed/);
  });
});

describe("runtime", () => {
  it("ticks loops on start and on WorkSignal, never overlapping, and stops gracefully", async () => {
    const signal = createWorkSignal();
    const rt = createRuntime({ log: createLogger("silent"), workSignal: signal, concurrency: 1 });
    let ticks = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    rt.add({
      name: "t",
      intervalMs: 60_000,
      wakeOn: ["wake"],
      async tick() {
        maxConcurrent = Math.max(maxConcurrent, ++concurrent);
        ticks++;
        await new Promise((r) => setTimeout(r, 5));
        concurrent--;
      },
    });
    rt.start();
    signal.notify("wake");
    signal.notify("wake");
    await new Promise((r) => setTimeout(r, 40));
    expect(ticks).toBeGreaterThanOrEqual(2); // initial + coalesced follow-up
    expect(maxConcurrent).toBe(1);
    await rt.stop(1000);
    const after = ticks;
    signal.notify("wake");
    await new Promise((r) => setTimeout(r, 20));
    expect(ticks).toBe(after);
    expect(rt.signal.aborted).toBe(true);
  });
});
