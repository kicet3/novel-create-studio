import { describe, expect, it } from "vitest";
import { novelDtoSchema } from "@ncs/shared";
import { listOf, normalizeList } from "./api.js";

describe("normalizeList", () => {
  it("accepts {items} and bare arrays and drops invalid items", () => {
    const schema = { safeParse: (x: unknown) => (typeof x === "number" ? { success: true as const, data: x } : { success: false as const }) };
    expect(normalizeList({ items: [1, "x", 2] }, schema)).toEqual([1, 2]);
    expect(normalizeList([3], schema)).toEqual([3]);
    expect(normalizeList(null, schema)).toEqual([]);
  });
  it("listOf works with shared zod DTO schemas", () => {
    expect(listOf(novelDtoSchema).parse({ items: [{ id: "x" }] }).items).toEqual([]);
  });
});
