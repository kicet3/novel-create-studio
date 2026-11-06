import { describe, expect, it } from "vitest";
import {
  ENUMS,
  ENUM_NAMES,
  NOVEL_STATUS,
  TASK_KIND,
  enumSchema,
  isEnumValue,
  novelStatusSchema,
} from "../src/enums.js";
import * as enumsModule from "../src/enums.js";
import { LABELS_KO, labelKo } from "../src/labels.ko.js";

describe("enum registry", () => {
  it("has non-empty, duplicate-free, snake_case value lists", () => {
    for (const name of ENUM_NAMES) {
      const values = ENUMS[name] as readonly string[];
      expect(values.length, name).toBeGreaterThan(0);
      expect(new Set(values).size, `${name} has duplicates`).toBe(values.length);
      for (const v of values) expect(v, `${name}.${v}`).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
      expect(name).toMatch(/^[a-z]+(_[a-z0-9]+)*$/);
    }
  });

  it("exports a constant, and a zod schema, for every enum", () => {
    const mod = enumsModule as Record<string, unknown>;
    for (const name of ENUM_NAMES) {
      expect(mod[name.toUpperCase()], name).toBe(ENUMS[name]);
      const camel = name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      expect(mod[`${camel}Schema`], name).toBeDefined();
    }
  });

  it("keeps doc-mandated ordering and key values", () => {
    expect(NOVEL_STATUS[0]).toBe("concept");
    expect(ENUMS.episode_status).toEqual([
      "planned", "outlining", "drafting", "checking", "polishing", "awaiting_approval", "revising", "approved", "published",
    ]);
    expect(TASK_KIND.slice(0, 3)).toEqual(["concept_turn", "import_concept", "check_concept_brief"]);
    expect(ENUMS.canon_status).toEqual(["candidate", "approved", "published_locked", "rejected", "retracted"]);
    expect(ENUMS.ref_type).toContain("concept_message");
    expect(ENUMS.outbox_kind).toContain("concept_message");
    expect(ENUMS.approval_type[0]).toBe("concept_brief");
    expect(ENUMS.question_topic).toContain("concept_confirm");
    // target_type is a subset of ref_type (00 §6.3)
    for (const t of ENUMS.target_type) expect(ENUMS.ref_type as readonly string[]).toContain(t);
  });

  it("validates with zod and guards", () => {
    expect(novelStatusSchema.parse("serializing")).toBe("serializing");
    expect(() => novelStatusSchema.parse("nope")).toThrow();
    expect(enumSchema("task_status").safeParse("done").success).toBe(true);
    expect(enumSchema("task_status").safeParse("finished").success).toBe(false);
    expect(isEnumValue("channel_kind", "telegram")).toBe(true);
    expect(isEnumValue("channel_kind", "line")).toBe(false);
    expect(isEnumValue("channel_kind", 3)).toBe(false);
  });

  it("labels every value of labelled enums in Korean", () => {
    for (const [name, map] of Object.entries(LABELS_KO)) {
      const values = ENUMS[name as keyof typeof ENUMS] as readonly string[];
      expect(Object.keys(map).sort(), name).toEqual([...values].sort());
      for (const label of Object.values(map)) expect(label.length).toBeGreaterThan(0);
    }
    expect(labelKo("episode_status", "awaiting_approval")).toBe("승인 대기");
    expect(labelKo("wake_status", "pending")).toBe("pending");
  });
  it("labels every enum the web shows (FR-UI-03, review regression)", () => {
    const shown = ["entity_name_status", "identity_decision_status", "mention_kind", "target_type", "export_version_selection", "deployment_mode", "exposure", "database_mode", "telegram_receive_mode", "backup_trigger", "backup_mode", "health_check_kind"];
    for (const name of shown) expect(LABELS_KO, name).toHaveProperty(name);
  });
});
