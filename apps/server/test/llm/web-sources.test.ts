/** 설계 추가 0011: the model's "출처:" trailer is cut out of the output and becomes the citations (pure). */
import { describe, expect, it } from "vitest";
import { cutSourceTrailer, extractSourceTrailers } from "../../src/modules/llm/domain/web-sources.js";
import { applySourceTrailers } from "../../src/modules/llm/application/gateway.js";

const AT = "2026-11-06T00:00:00.000Z";

describe("source trailers", () => {
  it("cuts a trailing list (markdown links, bare URLs, numbered) and keeps the body", () => {
    const s = "포도대장은 종2품이었어요.\n\n출처:\n- [한국민족문화대백과 '포도청'](https://encykorea.aks.ac.kr/Article/E0060140)\n2. 위키백과 — https://ko.wikipedia.org/wiki/포도청.\n";
    expect(cutSourceTrailer(s)).toEqual({
      text: "포도대장은 종2품이었어요.",
      links: [
        { url: "https://encykorea.aks.ac.kr/Article/E0060140", title: "한국민족문화대백과 '포도청'" },
        { url: "https://ko.wikipedia.org/wiki/포도청", title: "위키백과" },
      ],
    });
  });

  it("leaves text alone when the tail after the heading is not a pure link list, or there is no heading", () => {
    const prose = "출처:\n이 설정은 제가 지어낸 것입니다.";
    expect(cutSourceTrailer(prose)).toEqual({ text: prose, links: [] });
    expect(cutSourceTrailer("링크 https://a.example 가 본문에 있어요")).toEqual({ text: "링크 https://a.example 가 본문에 있어요", links: [] });
  });

  it("walks object outputs (inline 'Sources: [a](u), [b](u)' form too) and dedupes", () => {
    const out = extractSourceTrailers(
      {
        reply_text: "답입니다.\n\nSources: [A](https://a.example/1), [B](https://b.example/2)",
        questions: [{ ask_text: "질문?\n\n출처:\n- [A](https://a.example/1)" }],
        n: 3,
      },
      AT,
    );
    expect(out.value).toEqual({ reply_text: "답입니다.", questions: [{ ask_text: "질문?" }], n: 3 });
    expect(out.citations).toEqual([
      { url: "https://a.example/1", title: "A", retrievedAt: AT },
      { url: "https://b.example/2", title: "B", retrievedAt: AT },
    ]);
  });

  it("gateway rule: trailer wins; without one only provider-cited sources stay, result lists move to `results`", () => {
    const res = (object: unknown, kind: "cited" | "results") => ({
      ok: true as const,
      object,
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1 },
      raw: null,
      webSearch: {
        status: "used" as const,
        requests: 1,
        citations: [
          { url: "https://r.example/1", title: "R", retrievedAt: AT },
          { url: "https://t.example/x", title: null, retrievedAt: AT },
        ],
        citationsKind: kind,
      },
    });
    const obj = { kind: "object" as const, schemaName: "X", jsonSchema: {} };
    const withTrailer = applySourceTrailers(res({ reply_text: "본문\n\n출처:\n- [T](https://t.example/x)" }, "results"), obj, AT);
    expect(withTrailer.object).toEqual({ reply_text: "본문" });
    expect(withTrailer.webSearch!.citations).toEqual([{ url: "https://t.example/x", title: "T", retrievedAt: AT }]);
    expect(withTrailer.webSearch!.results!.map((c) => c.url)).toEqual(["https://r.example/1"]);
    const resultsOnly = applySourceTrailers(res({ reply_text: "검색했지만 쓰지 않았어요" }, "results"), obj, AT);
    expect(resultsOnly.webSearch!.citations).toEqual([]);
    const cited = applySourceTrailers(res({ reply_text: "API 인용" }, "cited"), obj, AT);
    expect(cited.webSearch!.citations.map((c) => c.url)).toEqual(["https://r.example/1", "https://t.example/x"]);
  });

  it("a trailer link the call never saw (made up, or planted in a result page) never becomes a source (review fix)", () => {
    const res = (object: unknown, kind: "cited" | "results") => ({
      ok: true as const,
      object,
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1 },
      raw: null,
      webSearch: { status: "used" as const, requests: 1, citations: [{ url: "https://ko.wikipedia.org/wiki/%ED%8F%AC%EB%8F%84%EC%B2%AD", title: "포도청", retrievedAt: AT }], citationsKind: kind },
    });
    const obj = { kind: "object" as const, schemaName: "X", jsonSchema: {} };
    // the real result (written decoded, with a trailing slash) stays; the invented one is dropped
    const mixed = applySourceTrailers(res({ reply_text: "본문\n\n출처:\n- [위키](https://ko.wikipedia.org/wiki/포도청/)\n- [가짜](https://invented.example/fake)" }, "results"), obj, AT);
    expect(mixed.object).toEqual({ reply_text: "본문" });
    expect(mixed.webSearch!.citations.map((c) => c.url)).toEqual(["https://ko.wikipedia.org/wiki/%ED%8F%AC%EB%8F%84%EC%B2%AD"]);
    // only invented links: CLI-style result lists give no source at all; provider-cited lists stay as cited
    const fake = "본문\n\n출처:\n- [가짜](https://evil.example/?q=brief)";
    const onlyFake = applySourceTrailers(res({ reply_text: fake }, "results"), obj, AT);
    expect(onlyFake.object).toEqual({ reply_text: "본문" });
    expect(onlyFake.webSearch!.citations).toEqual([]);
    expect(applySourceTrailers(res({ reply_text: fake }, "cited"), obj, AT).webSearch!.citations.map((c) => c.url)).toEqual(["https://ko.wikipedia.org/wiki/%ED%8F%AC%EB%8F%84%EC%B2%AD"]);
  });
});
