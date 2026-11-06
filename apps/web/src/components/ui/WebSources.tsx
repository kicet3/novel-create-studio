import type { LlmWebSource } from "@ncs/shared";
import { cx } from "../../lib/cx.js";
import { sourceRows } from "./web-sources.js";

/**
 * 설계 추가 0011: 각주 "출처" — 웹 검색으로 얻은 자료(컨셉 답변, 세계관 후보 등). 새 창, referrer 없음.
 */
export function WebSources({ sources, className, title = "출처" }: { sources: readonly LlmWebSource[] | null | undefined; className?: string; title?: string }) {
  const rows = sourceRows(sources);
  if (!rows.length) return null;
  return (
    <div className={cx("text-[11.5px] leading-snug text-muted", className)} aria-label={title}>
      <span className="font-semibold">{title}</span>
      <ol className="m-0 mt-0.5 list-decimal pl-4">
        {rows.map((r) => (
          <li key={r.url} className="[overflow-wrap:anywhere]">
            <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-muted underline decoration-dotted hover:text-text">
              {r.label}
            </a>
            {r.label !== r.host && <span className="text-faint"> · {r.host}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
