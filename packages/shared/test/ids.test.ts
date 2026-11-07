import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CROCKFORD_ALPHABET,
  ID_PREFIXES,
  ID_PREFIX_LIST,
  assertId,
  idPatternFor,
  isId,
  isUlid,
  monotonicUlidFactory,
  newId,
  parseId,
  ulid,
  ulidTime,
} from "../src/ids.js";

describe("ulid", () => {
  it("is 26 Crockford base32 chars", () => {
    for (let i = 0; i < 200; i++) {
      const u = ulid();
      expect(u).toHaveLength(26);
      expect(isUlid(u)).toBe(true);
      for (const ch of u) expect(CROCKFORD_ALPHABET).toContain(ch);
    }
  });

  it("encodes and decodes the timestamp", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 48 - 1 }), (ms) => {
        const f = monotonicUlidFactory();
        expect(ulidTime(f(ms))).toBe(ms);
      }),
    );
  });

  it("is monotonic within the same millisecond", () => {
    const f = monotonicUlidFactory(() => 1_700_000_000_000);
    const ids = Array.from({ length: 1000 }, () => f());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sorts by time across milliseconds", () => {
    const f = monotonicUlidFactory();
    const a = f(1000);
    const b = f(2000);
    expect(a < b).toBe(true);
  });

  it("rejects out-of-range time", () => {
    const f = monotonicUlidFactory();
    expect(() => f(-1)).toThrow(RangeError);
    expect(() => f(2 ** 48)).toThrow(RangeError);
  });
});

describe("prefixed ids", () => {
  it("lists all 00 §5.1 prefixes (incl. concept)", () => {
    expect(ID_PREFIX_LIST).toHaveLength(74); // + rvs/rvm/rvp/ean (revision chat, 0018), img (imaging, 0005), chr/cds/csi (cast, 0006), sst/spt (story structure, 0008), woi (world, 0012)
    for (const p of ["nov", "cns", "cnm", "cbf", "nfr", "ase", "rcp", "hck", "exp"]) expect(ID_PREFIXES).toHaveProperty(p);
    for (const p of ID_PREFIX_LIST) expect(p).toMatch(/^[a-z]{3}$/);
  });

  it("round-trips newId/parseId for every prefix", () => {
    for (const p of ID_PREFIX_LIST) {
      const id = newId(p, 1_700_000_000_123);
      expect(id.startsWith(`${p}_`)).toBe(true);
      expect(new RegExp(idPatternFor(p)).test(id)).toBe(true);
      const parsed = parseId(id);
      expect(parsed).not.toBeNull();
      expect(parsed!.prefix).toBe(p);
      expect(parsed!.type).toBe(ID_PREFIXES[p]);
      expect(parsed!.timestampMs).toBe(1_700_000_000_123);
      expect(isId(id, p)).toBe(true);
    }
  });

  it("rejects malformed ids", () => {
    const bad = [
      "",
      "nov",
      "nov_",
      "nov_01JCXZ8Q4M7R2V5K9T3B6N1H0", // 25 chars
      "nov_01JCXZ8Q4M7R2V5K9T3B6N1H0DX", // 27 chars
      "nov_01JCXZ8Q4M7R2V5K9T3B6N1H0I", // I not allowed
      "nov_01jcxz8q4m7r2v5k9t3b6n1h0d", // lower case
      "zzz_01JCXZ8Q4M7R2V5K9T3B6N1H0D", // unknown prefix
      "NOV_01JCXZ8Q4M7R2V5K9T3B6N1H0D",
      42,
      null,
    ];
    for (const b of bad) {
      expect(parseId(b)).toBeNull();
      expect(isId(b)).toBe(false);
    }
    expect(isId("epi_01JCXZ8Q4M7R2V5K9T3B6N1H0D", "epi")).toBe(true);
    expect(isId("epi_01JCXZ8Q4M7R2V5K9T3B6N1H0D", "nov")).toBe(false);
    expect(() => assertId("epi_01JCXZ8Q4M7R2V5K9T3B6N1H0D", "nov")).toThrow(TypeError);
  });

  it("throws for unknown prefix in newId", () => {
    expect(() => newId("zzz" as never)).toThrow(TypeError);
  });
});
