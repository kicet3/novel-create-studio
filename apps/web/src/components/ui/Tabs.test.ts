import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tabs } from "./Tabs.js";

// Regression: tab strips (떡밥 목록/리포트, 기한 필터 …) showed their own vertical + horizontal scrollbars wherever
// scrollbars are always visible. The strip is `overflow-x: auto` (so overflow-y computes to auto) and the tabs used
// `-mb-px` to overlap a `border-b`, sticking out 1px below the scroll box → scrollHeight = clientHeight + 1.
describe("Tabs strip", () => {
  const html = renderToStaticMarkup(
    createElement(Tabs<"a" | "b">, {
      label: "보기",
      value: "a",
      items: [
        { value: "a", label: "목록" },
        { value: "b", label: "리포트" },
      ],
    }),
  );
  const classOf = (re: RegExp) => html.match(re)?.[1]?.split(/\s+/) ?? [];

  it("scrolls sideways only and keeps nothing below its padding box", () => {
    const list = classOf(/role="tablist"[^>]*class="([^"]*)"/);
    expect(list).toContain("overflow-x-auto");
    expect(list).toContain("overflow-y-hidden");
    // the baseline must not be a border the tabs overlap
    expect(list.some((c) => /^border-b/.test(c))).toBe(false);
  });

  it("tabs have no negative margin that would overflow the strip", () => {
    const tabs = [...html.matchAll(/role="tab"[^>]*class="([^"]*)"/g)].map((m) => m[1]!.split(/\s+/));
    expect(tabs).toHaveLength(2);
    for (const cls of tabs) expect(cls.some((c) => /^-m[btyl]?-/.test(c))).toBe(false);
  });
});
