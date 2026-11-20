/**
 * OpenTelemetry log export (OTLP/HTTP). The server keeps writing pino JSON lines to stdout; when an OTLP endpoint is
 * configured (standard `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`), the same — already
 * redacted (NFR-SEC-02) — lines are also sent as OpenTelemetry log records. Export never blocks or fails a request:
 * records are batched in the background and dropped when the collector is down.
 */
import { SeverityNumber, type Attributes, type LogRecord, type Logger as OtelLogger } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { defaultResource, detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider, type LogRecordProcessor } from "@opentelemetry/sdk-logs";

export const OTEL_DEFAULT_SERVICE_NAME = "ncs-server";
/** attribute values longer than this are cut (a context pack or an LLM response must not travel inside one log record) */
const MAX_ATTRIBUTE_CHARS = 8_000;

export interface OtelLogSink {
  /** pino destination: receives one serialized (redacted) JSON line per call */
  stream: { write(line: string): void };
  /** flush what is buffered and stop exporting (called once at shutdown) */
  shutdown(): Promise<void>;
}

export interface OtelLogOptions {
  serviceName?: string;
  serviceVersion?: string;
  /** extra resource attributes (e.g. `deployment.environment.name`) */
  resource?: Record<string, string>;
  /** test seam: replaces the OTLP batch processor */
  processors?: LogRecordProcessor[];
}

/** true when the standard OTLP endpoint variables ask for log export (and `OTEL_SDK_DISABLED` / `OTEL_LOGS_EXPORTER=none` do not turn it off) */
export function otelLogsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return false;
  if (env.OTEL_LOGS_EXPORTER?.trim().toLowerCase() === "none") return false;
  return !!(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim());
}

/** pino level number → OpenTelemetry severity */
export function severityOf(level: unknown): { number: SeverityNumber; text: string } {
  const n = typeof level === "number" ? level : 30;
  if (n >= 60) return { number: SeverityNumber.FATAL, text: "FATAL" };
  if (n >= 50) return { number: SeverityNumber.ERROR, text: "ERROR" };
  if (n >= 40) return { number: SeverityNumber.WARN, text: "WARN" };
  if (n >= 30) return { number: SeverityNumber.INFO, text: "INFO" };
  if (n >= 20) return { number: SeverityNumber.DEBUG, text: "DEBUG" };
  return { number: SeverityNumber.TRACE, text: "TRACE" };
}

const clip = (s: string) => (s.length > MAX_ATTRIBUTE_CHARS ? `${s.slice(0, MAX_ATTRIBUTE_CHARS)}…` : s);

type AttributeValue = string | number | boolean | string[] | number[] | boolean[];

function attributeValue(v: unknown): AttributeValue | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return clip(v);
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === "string")) return (v as string[]).map(clip);
    if (v.every((x) => typeof x === "number")) return v as number[];
    if (v.every((x) => typeof x === "boolean")) return v as boolean[];
  }
  try {
    return clip(JSON.stringify(v));
  } catch {
    return clip(String(v));
  }
}

/** one level of nesting becomes dotted keys (`db.host`), deeper values are kept as JSON text */
function addAttributes(out: Attributes, key: string, value: unknown): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const a = attributeValue(v);
      if (a !== undefined) out[`${key}.${k}`] = a;
    }
    return;
  }
  const a = attributeValue(value);
  if (a !== undefined) out[key] = a;
}

const PINO_CORE_KEYS = new Set(["level", "time", "msg", "pid", "hostname", "v"]);

/**
 * A pino JSON line as an OpenTelemetry log record: `msg` → body, `level` → severity, `time` → timestamp, `err` →
 * `exception.*` (semantic conventions), every other field → an attribute. `scope` is the logger name (`module`).
 * Returns null for a line that is not a pino object (never throws: logging must not break the caller).
 */
export function pinoLineToLogRecord(line: string): { scope: string | null; record: LogRecord } | null {
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const severity = severityOf(o.level);
  const attributes: Attributes = {};
  for (const [k, v] of Object.entries(o)) {
    if (PINO_CORE_KEYS.has(k)) continue;
    if ((k === "err" || k === "error") && v !== null && typeof v === "object" && !Array.isArray(v)) {
      const e = v as Record<string, unknown>;
      if (typeof e.type === "string" || typeof e.name === "string") attributes["exception.type"] = clip(String(e.type ?? e.name));
      if (typeof e.message === "string") attributes["exception.message"] = clip(e.message);
      if (typeof e.stack === "string") attributes["exception.stacktrace"] = clip(e.stack);
      for (const [ek, ev] of Object.entries(e)) {
        if (ek === "type" || ek === "name" || ek === "message" || ek === "stack") continue;
        const a = attributeValue(ev);
        if (a !== undefined) attributes[`${k}.${ek}`] = a;
      }
      continue;
    }
    addAttributes(attributes, k, v);
  }
  const time = typeof o.time === "number" && Number.isFinite(o.time) ? new Date(o.time) : undefined;
  return {
    scope: typeof o.module === "string" && o.module ? o.module : null,
    record: {
      ...(time ? { timestamp: time } : {}),
      severityNumber: severity.number,
      severityText: severity.text,
      body: typeof o.msg === "string" ? clip(o.msg) : "",
      attributes,
    },
  };
}

/** Starts the OTLP log pipeline (endpoint, headers, timeout: standard `OTEL_EXPORTER_OTLP_*` variables). */
export function createOtelLogSink(opts: OtelLogOptions = {}): OtelLogSink {
  const serviceName = opts.serviceName?.trim() || process.env.OTEL_SERVICE_NAME?.trim() || OTEL_DEFAULT_SERVICE_NAME;
  // SDK defaults ← `OTEL_RESOURCE_ATTRIBUTES` ← explicit options
  const resource = defaultResource()
    .merge(detectResources({ detectors: [envDetector] }))
    .merge(
      resourceFromAttributes({
        ...(opts.resource ?? {}),
        "service.name": serviceName,
        ...(opts.serviceVersion ? { "service.version": opts.serviceVersion } : {}),
      }),
    );
  const provider = new LoggerProvider({
    resource,
    processors: opts.processors ?? [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  });
  const loggers = new Map<string, OtelLogger>();
  const loggerOf = (scope: string | null): OtelLogger => {
    const name = scope ?? serviceName;
    let l = loggers.get(name);
    if (!l) loggers.set(name, (l = provider.getLogger(name, opts.serviceVersion)));
    return l;
  };
  let closed = false;
  return {
    stream: {
      write(line: string) {
        if (closed) return;
        try {
          const r = pinoLineToLogRecord(line);
          if (r) loggerOf(r.scope).emit(r.record);
        } catch {
          // export is best effort; stdout still has the line
        }
      },
    },
    async shutdown() {
      if (closed) return;
      closed = true;
      // a collector that is down must not hold the process: the exporter's own timeout bounds this
      await provider.shutdown().catch(() => undefined);
    },
  };
}
