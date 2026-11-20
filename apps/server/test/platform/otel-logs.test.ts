import { describe, expect, it } from "vitest";
import { SeverityNumber } from "@opentelemetry/api";
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { createLogger } from "../../src/platform/logger.js";
import { createOtelLogSink, otelLogsEnabled, pinoLineToLogRecord, severityOf } from "../../src/platform/otel-logs.js";

describe("OpenTelemetry log export", () => {
  it("is enabled only by a standard OTLP endpoint variable", () => {
    expect(otelLogsEnabled({})).toBe(false);
    expect(otelLogsEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" })).toBe(true);
    expect(otelLogsEnabled({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs" })).toBe(true);
    expect(otelLogsEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", OTEL_SDK_DISABLED: "true" })).toBe(false);
    expect(otelLogsEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", OTEL_LOGS_EXPORTER: "none" })).toBe(false);
  });

  it("maps pino levels to severities", () => {
    expect(severityOf(10).number).toBe(SeverityNumber.TRACE);
    expect(severityOf(20).number).toBe(SeverityNumber.DEBUG);
    expect(severityOf(30).text).toBe("INFO");
    expect(severityOf(40).number).toBe(SeverityNumber.WARN);
    expect(severityOf(50).number).toBe(SeverityNumber.ERROR);
    expect(severityOf(60).text).toBe("FATAL");
  });

  it("turns a pino line into a log record", () => {
    const r = pinoLineToLogRecord(
      JSON.stringify({ level: 50, time: 1795159858445, pid: 1, hostname: "h", module: "agents", runId: "run_1", db: { host: "127.0.0.1", port: 5432 }, tags: ["a", "b"], nested: { deep: { x: 1 } }, err: { type: "TaskFailure", message: "boom", stack: "TaskFailure: boom\n  at x", code: "internal" }, msg: "run failed" }),
    )!;
    expect(r.scope).toBe("agents");
    expect(r.record.body).toBe("run failed");
    expect(r.record.severityNumber).toBe(SeverityNumber.ERROR);
    expect((r.record.timestamp as Date).getTime()).toBe(1795159858445);
    expect(r.record.attributes).toEqual({
      module: "agents",
      runId: "run_1",
      "db.host": "127.0.0.1",
      "db.port": 5432,
      tags: ["a", "b"],
      "nested.deep": '{"x":1}',
      "exception.type": "TaskFailure",
      "exception.message": "boom",
      "exception.stacktrace": "TaskFailure: boom\n  at x",
      "err.code": "internal",
    });
    expect(pinoLineToLogRecord("not json")).toBeNull();
    expect(pinoLineToLogRecord("[1]")).toBeNull();
  });

  it("exports what the logger writes, already redacted, and respects the level", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const sink = createOtelLogSink({ serviceName: "ncs-test", serviceVersion: "9.9.9", processors: [new SimpleLogRecordProcessor({ exporter })] });
    const log = createLogger("info", { otel: sink.stream });
    log.debug("dropped below the level");
    log.child({ module: "llm" }).warn({ apiKey: "sk-secret", provider: "anthropic" }, "call failed");
    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.body).toBe("call failed");
    expect(rec.severityText).toBe("WARN");
    expect(rec.instrumentationScope.name).toBe("llm");
    expect(rec.attributes).toMatchObject({ module: "llm", provider: "anthropic", apiKey: "[redacted]" });
    expect(JSON.stringify(rec.attributes)).not.toContain("sk-secret");
    expect(rec.resource.attributes["service.name"]).toBe("ncs-test");
    expect(rec.resource.attributes["service.version"]).toBe("9.9.9");
    await sink.shutdown();
    log.info("after shutdown is ignored");
    expect(exporter.getFinishedLogRecords().length).toBeLessThanOrEqual(1);
  });
});
