/**
 * JSON Schema shaping for OpenAI-compatible structured outputs (OpenAI Responses `text.format`, xAI chat
 * `response_format`). Strict mode needs every object closed (`additionalProperties:false`) with ALL properties
 * required and every node typed; schemas that do not fit (optional fields, records, `z.unknown()`, `$ref`) are sent
 * with `strict:false` — the gateway's zod validation + repair retries stay the source of truth either way.
 */
type Node = Record<string, unknown>;

function close(node: unknown, depth: number): Node | null {
  if (depth > 40 || !node || typeof node !== "object" || Array.isArray(node)) return null;
  const s = node as Node;
  if ("$ref" in s || "allOf" in s || "not" in s) return null;
  const variants = (s.anyOf ?? s.oneOf) as unknown[] | undefined;
  if (Array.isArray(variants)) {
    const mapped = variants.map((v) => close(v, depth + 1));
    if (mapped.some((m) => m === null)) return null;
    const { oneOf: _o, anyOf: _a, ...rest } = s;
    return { ...rest, anyOf: mapped };
  }
  const type = s.type;
  if (type === undefined) return "const" in s || Array.isArray(s.enum) ? { ...s } : null;
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("object")) {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    const keys = Object.keys(props);
    if (!keys.length) return null;
    const ap = s.additionalProperties;
    if (ap !== undefined && ap !== false) return null;
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    if (keys.some((k) => !required.has(k))) return null;
    const out: Record<string, Node> = {};
    for (const k of keys) {
      const c = close(props[k], depth + 1);
      if (!c) return null;
      out[k] = c;
    }
    return { ...s, properties: out, required: keys, additionalProperties: false };
  }
  if (types.includes("array")) {
    if (s.items === undefined) return null;
    const items = close(s.items, depth + 1);
    return items ? { ...s, items } : null;
  }
  return { ...s };
}

/** closed copy for strict structured outputs, or null when the schema is not strict-representable */
export function strictJsonSchema(schema: Record<string, unknown>): Record<string, unknown> | null {
  if (schema.type !== "object") return null;
  return close(schema, 0);
}

export function schemaFormatName(name: string): string {
  return (name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "output").replace(/^$/, "output");
}

/** `{type:"json_schema", name, schema, strict}` (OpenAI Responses `text.format` shape) */
export function jsonSchemaFormat(schemaName: string, schema: Record<string, unknown>): { type: "json_schema"; name: string; schema: Record<string, unknown>; strict: boolean } {
  const strict = strictJsonSchema(schema);
  return { type: "json_schema", name: schemaFormatName(schemaName), schema: strict ?? schema, strict: !!strict };
}
