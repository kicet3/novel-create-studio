import { describe, expect, it } from "vitest";
import { insertBlocks, readingBlocks, type ReadingBlock } from "./reader-model.js";
import {
  anchorForPage,
  estimatePageChars,
  leaveTarget,
  pageCounter,
  pageForAnchor,
  paginateBlocks,
  sentenceBoundaries,
  wordBoundaries,
  type PageItem,
  type ReaderPage,
} from "./reader-pages.js";

const para = (n: number, sentence = "가나다라마바사아자차카타파하 거너더러머버서어저처커터퍼허다. ") => {
  let s = "";
  while (s.length < n) s += sentence;
  return s.slice(0, n).trim();
};
const texts = (pages: ReaderPage[]) => pages.map((p) => p.items.map((i) => (i.type === "text" ? i.text : `[${i.type}]`)));
/** every paragraph's pieces, joined, give back the paragraph (nothing lost or duplicated) */
function rebuild(pages: ReaderPage[]): string[] {
  const out: string[] = [];
  for (const p of pages)
    for (const i of p.items) {
      if (i.type !== "text") continue;
      out[i.para] = out[i.para] === undefined ? i.text : `${out[i.para]} ${i.text}`;
    }
  return out;
}

describe("sentence / word boundaries", () => {
  it("breaks after Korean sentence endings, closing quotes and ellipses, never inside a word", () => {
    const t = '그가 말했다. "정말이야?" 그녀가 물었다… 그리고 침묵. 3.14는 숫자다!';
    const b = sentenceBoundaries(t);
    expect(b.map((e) => t.slice(0, e).trimEnd().slice(-3))).toEqual(["했다.", '야?"', "었다…", "침묵."]);
    expect(b.every((e) => /\s/.test(t[e - 1]!))).toBe(true);
    expect(sentenceBoundaries("끝.")).toEqual([]);
    expect(sentenceBoundaries("“가자.” 그가 웃었다.").length).toBe(1);
    expect(wordBoundaries("하나 둘  셋")).toEqual([3, 6]);
  });
});

describe("paginateBlocks", () => {
  it("keeps whole paragraphs together when they fit, about maxChars per page", () => {
    const blocks = readingBlocks(Array.from({ length: 12 }, () => para(150)).join("\n"));
    const pages = paginateBlocks(blocks, { maxChars: 700 });
    expect(pages.every((p) => p.chars <= 700)).toBe(true);
    expect(pages.flatMap((p) => p.items).filter((i) => i.type === "text").every((i) => (i as Extract<PageItem, { type: "text" }>).start === 0)).toBe(true);
    expect(pages.length).toBe(3); // 4 × 150 = 600 per page
    expect(rebuild(pages)).toEqual(blocks.map((b) => (b.type === "p" ? b.text : "")));
  });

  it("splits a long paragraph at sentence ends; pieces stay under the budget", () => {
    const long = para(2500);
    const pages = paginateBlocks(readingBlocks(long), { maxChars: 700 });
    expect(pages.length).toBeGreaterThanOrEqual(4);
    for (const p of pages) {
      expect(p.chars).toBeLessThanOrEqual(700);
      const t = p.items[0] as Extract<PageItem, { type: "text" }>;
      if (t.end < t.len) expect(t.text.endsWith(".")).toBe(true); // a piece ends at a sentence
    }
    expect(rebuild(pages)).toEqual([long]);
  });

  it("starts a paragraph on the next page when the page is already full enough, splits it otherwise", () => {
    const blocks = readingBlocks([para(500), para(300)].join("\n"));
    // 500/700 ≥ 60%: the 300-char paragraph moves to page 2 whole
    expect(texts(paginateBlocks(blocks, { maxChars: 700 })).map((p) => p.length)).toEqual([1, 1]);
    // 200/700 < 60%: the second paragraph is split to fill page 1
    const pages = paginateBlocks(readingBlocks([para(200), para(900)].join("\n")), { maxChars: 700 });
    expect(pages[0]!.items.length).toBe(2);
    expect((pages[0]!.items[1] as Extract<PageItem, { type: "text" }>).end).toBeLessThan(900);
  });

  it("splits a sentence longer than a page between words, and text without spaces between characters", () => {
    const words = Array.from({ length: 120 }, (_, i) => `단어${i}`).join(" ");
    const pages = paginateBlocks(readingBlocks(words), { maxChars: 100 });
    expect(pages.every((p) => p.chars <= 100)).toBe(true);
    expect(rebuild(pages)).toEqual([words]);
    for (const p of pages) for (const i of p.items) if (i.type === "text") expect(i.text).toMatch(/^단어\d+( 단어\d+)*$/); // whole words only
    const solid = "가".repeat(250);
    const sp = paginateBlocks(readingBlocks(solid), { maxChars: 100 });
    expect(sp.map((p) => p.chars)).toEqual([100, 100, 50]);
  });

  it("shrinks pages that would overflow the screen (fits callback)", () => {
    const blocks = readingBlocks(Array.from({ length: 10 }, () => para(120)).join("\n"));
    // the screen holds only 300 chars; page 0 (with the title) only 200
    const fits = (items: readonly PageItem[], page: number) => items.reduce((n, i) => n + (i.type === "text" ? i.end - i.start : 0), 0) <= (page === 0 ? 200 : 300);
    const pages = paginateBlocks(blocks, { maxChars: 1000, fits });
    expect(pages[0]!.chars).toBeLessThanOrEqual(200);
    expect(pages.slice(1).every((p) => p.chars <= 300)).toBe(true);
    expect(rebuild(pages)).toEqual(blocks.map((b) => (b.type === "p" ? b.text : "")));
  });

  it("gives illustrations their own page and never ends a page with a scene break", () => {
    const base = readingBlocks([para(300), "* * *", para(300), para(300), para(100)].join("\n"));
    const img: ReadingBlock = { type: "image", src: "/a.png", alt: "삽화" };
    const pages = paginateBlocks(insertBlocks(base, [{ afterParagraph: 2, block: img }]), { maxChars: 700 });
    const t = texts(pages);
    expect(t.find((p) => p.includes("[image]"))).toEqual(["[image]"]);
    expect(pages.every((p) => p.items[p.items.length - 1]!.type !== "break" || p.items.length === 1)).toBe(true);
    // a break that would close a page opens the next one instead
    const bp = paginateBlocks(readingBlocks([para(650), "* * *", para(100)].join("\n")), { maxChars: 700 });
    expect(texts(bp)[1]![0]).toBe("[break]");
  });

  it("handles empty input", () => {
    expect(paginateBlocks([], { maxChars: 700 })).toEqual([]);
  });
});

describe("anchor ↔ page", () => {
  const blocks = readingBlocks(Array.from({ length: 8 }, (_, i) => para(400 + i * 50)).join("\n"));

  it("the anchor of a page maps back to that page", () => {
    const pages = paginateBlocks(blocks, { maxChars: 700 });
    for (let p = 0; p < pages.length; p++) expect(pageForAnchor(pages, anchorForPage(pages, p))).toBe(p);
    expect(anchorForPage(pages, 0)).toEqual({ para: 0, offset: 0 });
    expect(pageForAnchor(pages, { para: 99, offset: 0.5 })).toBe(pages.length - 1);
    expect(pageForAnchor(pages, { para: 7, offset: 1 })).toBe(pages.length - 1);
  });

  it("keeps the place when the page size changes (font size / 글자 수)", () => {
    const small = paginateBlocks(blocks, { maxChars: 400 });
    const big = paginateBlocks(blocks, { maxChars: 1000 });
    const p = 5;
    const a = anchorForPage(small, p);
    const q = pageForAnchor(big, a);
    const onPage = big[q]!.items.filter((i): i is Extract<PageItem, { type: "text" }> => i.type === "text");
    // the anchored character is on the new page
    const at = Math.round(a.offset * onPage.find((i) => i.para === a.para)!.len);
    expect(onPage.some((i) => i.para === a.para && i.start <= at && (at < i.end || i.end === i.len))).toBe(true);
  });

  it("an illustration page anchors to the text after it", () => {
    const img: ReadingBlock = { type: "image", src: "/a.png", alt: "" };
    const pages = paginateBlocks(insertBlocks(readingBlocks(`${para(100)}\n${para(100)}`), [{ afterParagraph: 1, block: img }]), { maxChars: 700 });
    expect(pages.map((p) => p.items[0]!.type)).toEqual(["text", "image", "text"]);
    expect(anchorForPage(pages, 1)).toEqual({ para: 1, offset: 0 });
    expect(pageForAnchor(pages, { para: 1, offset: 0 })).toBe(2);
  });
});

describe("episode edges", () => {
  it("counts text pages and labels the end card", () => {
    expect(pageCounter(0, 13)).toBe("1 / 12");
    expect(pageCounter(11, 13)).toBe("12 / 12");
    expect(pageCounter(12, 13)).toBe("끝");
  });

  it("past the end card opens the next episode at page 1; back from page 1 opens the previous at its last page", () => {
    const ep = { prev: { episodeNo: 3 }, next: { episodeNo: 5 } };
    expect(leaveTarget("next", ep)).toEqual({ episodeNo: 5, at: "start" });
    expect(leaveTarget("prev", ep)).toEqual({ episodeNo: 3, at: "end" });
    expect(leaveTarget("next", { prev: null, next: null })).toBeNull(); // latest episode: stay on the end card
    expect(leaveTarget("prev", { next: { episodeNo: 2 } })).toBeNull();
    expect(leaveTarget("next", undefined)).toBeNull();
  });

  it("estimates a conservative page size from the font and screen", () => {
    const phone = estimatePageChars({ width: 346, height: 740, fontPx: 18, lineHeight: 1.85 });
    expect(phone).toBeGreaterThan(200);
    expect(phone).toBeLessThan(500);
    expect(estimatePageChars({ width: 346, height: 740, fontPx: 27, lineHeight: 2.1 })).toBeLessThan(phone);
  });
});
