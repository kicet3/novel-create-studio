import { describe, expect, it } from "vitest";
import { sourceRows } from "./web-sources.js";

describe("sourceRows (출처 각주)", () => {
  it("keeps http(s) links once, labels by title or host, caps the list", () => {
    const at = "2026-11-06T00:00:00Z";
    const rows = sourceRows([
      { url: "https://www.encykorea.aks.ac.kr/Article/E0060135", title: "포도대장", retrievedAt: at },
      { url: "https://www.encykorea.aks.ac.kr/Article/E0060135", title: "중복", retrievedAt: at },
      { url: "javascript:alert(1)", title: "x", retrievedAt: at },
      { url: "not a url", title: null, retrievedAt: at },
      { url: "https://en.wikipedia.org/wiki/Podocheong", title: null, retrievedAt: at },
      { url: "http://kbmaeil.com/a", title: "kbmaeil.com", retrievedAt: at },
    ]);
    expect(rows).toEqual([
      { url: "https://www.encykorea.aks.ac.kr/Article/E0060135", label: "포도대장", host: "encykorea.aks.ac.kr" },
      { url: "https://en.wikipedia.org/wiki/Podocheong", label: "en.wikipedia.org", host: "en.wikipedia.org" },
      { url: "http://kbmaeil.com/a", label: "kbmaeil.com", host: "kbmaeil.com" },
    ]);
    expect(sourceRows(Array.from({ length: 12 }, (_, i) => ({ url: `https://s${i}.example/`, title: null, retrievedAt: at })), 5)).toHaveLength(5);
    expect(sourceRows(null)).toEqual([]);
  });
});
