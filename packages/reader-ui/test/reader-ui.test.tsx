/** @ncs/reader-ui — shared viewer pieces render the same markup for both apps; effects never return expression values. */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_READER_SETTINGS } from "@ncs/reader-core/model";
import { EndCard, EpisodeHeading, ReaderSettingsPanel, ReadingArticle, TocDrawerItem, createProgressStore } from "../src/index.js";

const src = fileURLToPath(new URL("../src/", import.meta.url));

describe("reader-ui sources", () => {
  it("effects use block bodies (scrollTo may return a Promise that React would call as cleanup)", () => {
    const offenders = readdirSync(src)
      .filter((f) => /\.tsx?$/.test(f))
      .flatMap((f) =>
        readFileSync(src + f, "utf8")
          .split("\n")
          .map((line, i) => ({ f, i: i + 1, line }))
          .filter(({ line }) => /use(Layout)?Effect\(\s*\(\)\s*=>\s*[^{\s]/.test(line)),
      )
      .map(({ f, i, line }) => `${f}:${i} ${line.trim()}`);
    expect(offenders).toEqual([]);
  });

  it("no app imports (data / routing stay in apps/web and apps/public-reader)", () => {
    for (const f of readdirSync(src).filter((x) => /\.tsx?$/.test(x))) {
      const text = readFileSync(src + f, "utf8");
      expect(text, f).not.toMatch(/from "(react-router|next\/|@tanstack|@ncs\/shared)/);
    }
  });
});

describe("text pieces", () => {
  it("article: paragraphs carry data-p, scene breaks are separators, empty text says so", () => {
    const html = renderToStaticMarkup(<ReadingArticle blocks={[{ type: "p", text: "가" }, { type: "break" }, { type: "p", text: "<b>나</b>" }]} header={<EpisodeHeading episodeNo={3} title="제목" />} />);
    expect(html).toContain('data-p="0"');
    expect(html).toContain('data-p="1"');
    expect(html).toContain('role="separator"');
    expect(html).toContain("&lt;b&gt;나&lt;/b&gt;");
    expect(html).toContain("3화");
    expect(renderToStaticMarkup(<ReadingArticle blocks={[]} header={null} />)).toContain("본문이 비어 있습니다");
  });

  it("end card: next button or latest notice, skipped warning, app extras", () => {
    const noop = () => undefined;
    const withNext = renderToStaticMarkup(<EndCard episodeNo={2} title="둘" next={{ episodeNo: 3, title: "셋" }} prev={{ episodeNo: 1, title: null }} paged onGo={noop} onOpenToc={noop} skipped="4화" extra={<span>EXTRA</span>} />);
    expect(withNext).toContain("다음 화 보기");
    expect(withNext).toContain("3화 · 셋");
    expect(withNext).toContain("한 번 더 넘기면");
    expect(withNext).toContain("4화는 아직");
    expect(withNext).toContain("EXTRA");
    const latest = renderToStaticMarkup(<EndCard episodeNo={2} title={null} next={null} prev={null} onGo={noop} onOpenToc={noop} moreLater />);
    expect(latest).toContain("지금 읽을 수 있는 최신 화입니다");
    expect(latest).toContain("다음 화는 아직 읽을 수 없습니다");
    expect(latest).toMatch(/<button[^>]*disabled=""[^>]*>.*이전 화/);
  });

  it("목차 drawer row: current / read / opened marks", () => {
    const noop = () => undefined;
    expect(renderToStaticMarkup(<TocDrawerItem episodeNo={1} title="첫" charCount={12345} current state={undefined} onJump={noop} />)).toContain("보는 중");
    expect(renderToStaticMarkup(<TocDrawerItem episodeNo={1} title="" charCount={1} current={false} state="read" onJump={noop} />)).toMatch(/제목 없음.*읽음/);
    expect(renderToStaticMarkup(<TocDrawerItem episodeNo={1} title="첫" charCount={1} current={false} state="open" onJump={noop} note="초안" />)).toMatch(/· 초안.*읽는 중/);
  });
});

describe("보기 설정 panel options", () => {
  const noop = () => undefined;
  it("studio: 원고 범위 row, no 글꼴 row", () => {
    const html = renderToStaticMarkup(<ReaderSettingsPanel settings={DEFAULT_READER_SETTINGS} onChange={noop} viewer={false} />);
    expect(html).toContain("원고 범위");
    expect(html).not.toContain("글꼴");
  });
  it("snowpage: 글꼴 row, no 원고 범위", () => {
    const html = renderToStaticMarkup(<ReaderSettingsPanel settings={DEFAULT_READER_SETTINGS} onChange={noop} viewer={false} showMode={false} showFont />);
    expect(html).toContain("글꼴");
    expect(html).toContain("명조");
    expect(html).not.toContain("원고 범위");
  });
});

describe("progress store", () => {
  it("notifies only on change", () => {
    const s = createProgressStore();
    let n = 0;
    s.subscribe(() => void n++);
    s.set({ episodeNo: 1, ratio: 0.5 });
    s.set({ episodeNo: 1, ratio: 0.5 });
    s.set({ page: 2 });
    expect(n).toBe(2);
    expect(s.get()).toEqual({ episodeNo: 1, ratio: 0.5, page: 2, pageCount: 0 });
  });
});
