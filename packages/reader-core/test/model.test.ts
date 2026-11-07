import { describe, expect, it } from "vitest";
import {
  DEFAULT_READER_SETTINGS,
  READER_SETTINGS_KEY,
  LEGACY_READER_SETTINGS_KEY,
  effectiveReaderTheme,
  headerVisible,
  loadReaderSettings,
  loadResume,
  parseReaderSettings,
  partLabel,
  readingBlocks,
  resumeKey,
  saveReaderSettings,
  saveResume,
  scrollProgress,
  scrollTopFor,
  skippedLabel,
  stepFont,
  fontPxOf,
  typographyKey,
  dimOpacity,
  BRIGHTNESS_MIN,
  READER_FONT_STEPS_PX,
  resumeAnchorFor,
  isStartAnchor,
  markHistory,
  saveHistory,
  loadHistory,
  historyKey,
  parseHistory,
  hintSeen,
  markHintSeen,
  insertBlocks,
  paragraphIndexes,
  type ReadHistory,
  type KeyValueStore,
} from "../src/model.js";


const memory = (init: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } => {
  const data = { ...init };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
};

describe("reader settings persistence", () => {
  it("defaults, round-trips and repairs invalid values", () => {
    const s = memory();
    expect(loadReaderSettings(s)).toEqual(DEFAULT_READER_SETTINGS);
    const custom = {
      ...DEFAULT_READER_SETTINGS,
      view: "page" as const,
      continuous: true,
      fontStep: 7,
      font: "system" as const,
      lineHeight: "wide" as const,
      paraSpacing: "narrow" as const,
      margin: "wide" as const,
      theme: "green" as const,
      indent: true,
      brightness: 0.55,
      keepAwake: true,
      mode: "draft" as const,
    };
    saveReaderSettings(s, custom);
    expect(loadReaderSettings(s)).toEqual(custom);
    expect(parseReaderSettings('{"fontStep":99,"brightness":0.01,"theme":"black","view":"sideways","indent":"yes","x":1}')).toEqual({
      ...DEFAULT_READER_SETTINGS,
      fontStep: READER_FONT_STEPS_PX.length - 1,
      brightness: BRIGHTNESS_MIN,
      theme: "black",
    });
    expect(parseReaderSettings('{"fontStep":-3}').fontStep).toBe(0);
    expect(parseReaderSettings("not json")).toEqual(DEFAULT_READER_SETTINGS);
    expect(parseReaderSettings("[1]")).toEqual(DEFAULT_READER_SETTINGS);
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadReaderSettings(broken)).toEqual(DEFAULT_READER_SETTINGS);
    expect(() => saveReaderSettings(broken, DEFAULT_READER_SETTINGS)).not.toThrow();
    expect(loadReaderSettings(null)).toEqual(DEFAULT_READER_SETTINGS);
    expect(Object.keys(memory({ [READER_SETTINGS_KEY]: "{}" }).data)).toEqual([READER_SETTINGS_KEY]);
  });

  it("migrates settings saved by the first reader version", () => {
    const v1 = parseReaderSettings('{"fontSize":"xl","font":"myeongjo","width":"narrow","theme":"sepia","mode":"draft"}');
    expect(v1).toMatchObject({ fontStep: 7, font: "myeongjo", margin: "wide", theme: "ivory", mode: "draft", view: "page" });
    expect(parseReaderSettings('{"theme":"dark","width":"wide","fontSize":"sm"}')).toMatchObject({ theme: "black", margin: "narrow", fontStep: 2 });
    expect(parseReaderSettings('{"theme":"light"}').theme).toBe("white");
  });

  it("페이지 넘김 is the default: settings saved before it (v1 key) keep typography but switch to pages", () => {
    expect(DEFAULT_READER_SETTINGS.view).toBe("page");
    expect(DEFAULT_READER_SETTINGS.pageChars).toBe("normal");
    const old = memory({ [LEGACY_READER_SETTINGS_KEY]: JSON.stringify({ ...DEFAULT_READER_SETTINGS, view: "scroll", fontStep: 8, theme: "black" }) });
    expect(loadReaderSettings(old)).toMatchObject({ view: "page", fontStep: 8, theme: "black" });
    // choosing 스크롤 보기 after the change is kept
    saveReaderSettings(old, { ...loadReaderSettings(old), view: "scroll" });
    expect(loadReaderSettings(old).view).toBe("scroll");
    expect(parseReaderSettings('{"pageChars":"many"}').pageChars).toBe("many");
    expect(parseReaderSettings('{"pageChars":"huge"}').pageChars).toBe("normal");
  });

  it("theme auto follows the app override, then the OS", () => {
    expect(effectiveReaderTheme("auto", null, true)).toBe("black");
    expect(effectiveReaderTheme("auto", null, false)).toBe("white");
    expect(effectiveReaderTheme("auto", "light", true)).toBe("white");
    expect(effectiveReaderTheme("auto", "dark", false)).toBe("black");
    expect(effectiveReaderTheme("ivory", "dark", true)).toBe("ivory");
  });

  it("steps the font size within bounds and maps it to px", () => {
    expect(stepFont(4, 1)).toBe(5);
    expect(stepFont(READER_FONT_STEPS_PX.length - 1, 1)).toBe(READER_FONT_STEPS_PX.length - 1);
    expect(stepFont(0, -1)).toBe(0);
    expect(fontPxOf(DEFAULT_READER_SETTINGS.fontStep)).toBe(18);
    expect(fontPxOf(Number.NaN)).toBe(18);
    expect(new Set(READER_FONT_STEPS_PX).size).toBeGreaterThanOrEqual(5);
  });

  it("typography key changes only with layout-affecting settings; dimmer opacity", () => {
    const k = typographyKey(DEFAULT_READER_SETTINGS);
    expect(typographyKey({ ...DEFAULT_READER_SETTINGS, theme: "black", brightness: 0.5, view: "page", keepAwake: true })).toBe(k);
    for (const patch of [{ fontStep: 5 }, { font: "myeongjo" as const }, { lineHeight: "wide" as const }, { paraSpacing: "wide" as const }, { margin: "wide" as const }, { indent: true }])
      expect(typographyKey({ ...DEFAULT_READER_SETTINGS, ...patch })).not.toBe(k);
    expect(dimOpacity(1)).toBe(0);
    expect(dimOpacity(0)).toBe(dimOpacity(BRIGHTNESS_MIN));
    expect(dimOpacity(0.5)).toBeGreaterThan(0);
  });
});

describe("이어 읽기 (resume)", () => {
  it("remembers the last episode and anchor per novel", () => {
    const s = memory();
    saveResume(s, "nov_a", { episodeNo: 3, mode: "approved", ratio: 0.123456, anchor: { para: 12, offset: 0.333333 }, at: 10 });
    saveResume(s, "nov_b", { episodeNo: 7, mode: "draft", ratio: 2, anchor: null, at: 20 });
    expect(loadResume(s, "nov_a")).toEqual({ episodeNo: 3, mode: "approved", ratio: 0.1235, anchor: { para: 12, offset: 0.3333 }, at: 10 });
    expect(loadResume(s, "nov_b")).toEqual({ episodeNo: 7, mode: "draft", ratio: 1, anchor: null, at: 20 });
    expect(loadResume(s, "nov_c")).toBeNull();
    s.setItem(resumeKey("nov_d"), '{"episodeNo":0}');
    expect(loadResume(s, "nov_d")).toBeNull();
    s.setItem(resumeKey("nov_e"), "{oops");
    expect(loadResume(s, "nov_e")).toBeNull();
    // v1 record (ratio only) and a broken anchor
    s.setItem(resumeKey("nov_f"), '{"episodeNo":2,"mode":"approved","ratio":0.4,"at":1}');
    expect(loadResume(s, "nov_f")).toMatchObject({ episodeNo: 2, ratio: 0.4, anchor: null });
    s.setItem(resumeKey("nov_g"), '{"episodeNo":2,"ratio":0.4,"anchor":{"para":-1}}');
    expect(loadResume(s, "nov_g")?.anchor).toBeNull();
    // first-viewer anchor counted scene breaks / images (`block`): not comparable → ratio fallback
    s.setItem(resumeKey("nov_h"), '{"episodeNo":2,"ratio":0.4,"anchor":{"block":12,"offset":0.5}}');
    expect(loadResume(s, "nov_h")).toMatchObject({ ratio: 0.4, anchor: null });
  });

  it("opens at the saved anchor only for the same episode and text mode", () => {
    const r = { episodeNo: 3, mode: "approved" as const, ratio: 0.4, anchor: { para: 9, offset: 0.5 }, at: 1 };
    expect(resumeAnchorFor(r, 3, "approved", false)).toEqual({ para: 9, offset: 0.5 });
    expect(resumeAnchorFor(r, 4, "approved", false)).toBeNull();
    expect(resumeAnchorFor(r, 3, "draft", false)).toBeNull();
    expect(resumeAnchorFor(null, 3, "approved", true)).toBeNull();
    // finished: reopening starts over, unless 이어 읽기 was asked for explicitly
    const done = { ...r, ratio: 0.99 };
    expect(resumeAnchorFor(done, 3, "approved", false)).toBeNull();
    expect(resumeAnchorFor(done, 3, "approved", true)).toEqual(r.anchor);
    // v1 record: fall back to the ratio
    expect(resumeAnchorFor({ ...r, anchor: null }, 3, "approved", false)).toBe("ratio");
    expect(resumeAnchorFor({ ...r, anchor: null, ratio: 0 }, 3, "approved", false)).toBeNull();
    expect(isStartAnchor(null)).toBe(true);
    expect(isStartAnchor({ para: 0, offset: 0 })).toBe(true);
    expect(isStartAnchor({ para: 0, offset: 0.2 })).toBe(false);
  });
});

describe("read history", () => {
  it("marks opened / read episodes; read is never downgraded", () => {
    let h: ReadHistory = {};
    h = markHistory(h, 3, "open");
    h = markHistory(h, 2, "read");
    const same = markHistory(h, 2, "open");
    expect(same).toBe(h);
    expect(markHistory(h, 3, "open")).toBe(h);
    h = markHistory(h, 3, "read");
    expect(h).toEqual({ 2: "read", 3: "read" });
  });

  it("persists per novel and ignores garbage", () => {
    const s = memory();
    saveHistory(s, "nov_a", { 1: "read", 2: "open" });
    expect(loadHistory(s, "nov_a")).toEqual({ 1: "read", 2: "open" });
    expect(loadHistory(s, "nov_b")).toEqual({});
    s.setItem(historyKey("nov_c"), '{"1":"read","x":"read","0":"read","4":"done","5":"open"}');
    expect(loadHistory(s, "nov_c")).toEqual({ 1: "read", 5: "open" });
    expect(parseHistory("[]")).toEqual({});
    expect(parseHistory("{oops")).toEqual({});
  });

  it("first-time hints are remembered per view", () => {
    const s = memory();
    expect(hintSeen(s, "page")).toBe(false);
    markHintSeen(s, "page");
    expect(hintSeen(s, "page")).toBe(true);
    expect(hintSeen(s, "scroll")).toBe(false);
    expect(hintSeen(null, "scroll")).toBe(true); // no storage: never nag
  });
});

describe("progress", () => {
  it("maps scroll position to 0..1 and back", () => {
    expect(scrollProgress(0, 3000, 800)).toBe(0);
    expect(scrollProgress(1100, 3000, 800)).toBe(0.5);
    expect(scrollProgress(5000, 3000, 800)).toBe(1);
    expect(scrollProgress(0, 600, 800)).toBe(1); // fits the screen
    expect(scrollTopFor(0.5, 3000, 800)).toBe(1100);
    expect(scrollTopFor(Number.NaN, 3000, 800)).toBe(0);
  });

  it("hides the header when scrolling down and shows it when scrolling up or near the top", () => {
    expect(headerVisible(0, 40, true)).toBe(true);
    expect(headerVisible(200, 300, true)).toBe(false);
    expect(headerVisible(300, 250, false)).toBe(true);
    expect(headerVisible(300, 302, false)).toBe(false); // jitter keeps the state
  });
});

describe("readingBlocks", () => {
  it("turns lines into paragraphs and break lines into single scene breaks", () => {
    expect(readingBlocks("가\n\n나\n\n* * *\n\n* * *\n다\n* * *\n")).toEqual([
      { type: "p", text: "가" },
      { type: "p", text: "나" },
      { type: "break" },
      { type: "p", text: "다" },
    ]);
    expect(readingBlocks("* * *\n가")).toEqual([{ type: "p", text: "가" }]);
    expect(readingBlocks("")).toEqual([]);
  });

  it("leaves room for illustrations between paragraphs (insertBlocks)", () => {
    const blocks = readingBlocks("가\n나\n* * *\n다");
    const img = (n: string) => ({ type: "image" as const, src: `/${n}.png`, alt: n });
    expect(insertBlocks(blocks, [])).toEqual(blocks);
    expect(insertBlocks(blocks, [{ afterParagraph: 2, block: img("b") }, { afterParagraph: 0, block: img("a") }, { afterParagraph: 9, block: img("z") }]).map((b) => (b.type === "p" ? b.text : b.type === "image" ? b.alt : "|"))).toEqual(["a", "가", "나", "b", "|", "다", "z"]);
    // saved positions count paragraphs only: inserting images keeps every paragraph's index
    const withImages = insertBlocks(blocks, [{ afterParagraph: 0, block: img("a") }, { afterParagraph: 2, block: img("b") }]);
    const textIdx = (bs: typeof blocks) => paragraphIndexes(bs).filter((n) => n !== null);
    expect(textIdx(withImages)).toEqual(textIdx(blocks));
    expect(paragraphIndexes(withImages)).toEqual([null, 0, 1, null, null, 2]);
  });
});

describe("skippedLabel", () => {
  it("names the episodes 이전화/다음화 jumps over", () => {
    expect(skippedLabel([])).toBeNull();
    expect(skippedLabel(undefined)).toBeNull();
    expect(skippedLabel([4])).toBe("4화");
    expect(skippedLabel([6, 4])).toBe("4·6화");
    expect(skippedLabel([4, 5, 6, 7])).toBe("4–7화");
    expect(skippedLabel([4, 6, 9, 11, 12])).toBe("4·6·9화 등 5개 화");
  });
});
