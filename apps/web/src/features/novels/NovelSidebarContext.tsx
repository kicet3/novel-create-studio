import { labelKo } from "@ncs/shared";
import { useInboxSummary } from "../inbox/api.js";
import { useNovel } from "./api.js";

/**
 * Sidebar context box for `/novels/:novelId/*` (title + genre/status). Intended for
 * `NovelLayout`'s `<Sidebar context={…}>` (app/layouts.tsx — wiring requested from the integrator).
 */
export function NovelSidebarContext({ novelId }: { novelId: string }) {
  const n = useNovel(novelId);
  if (!n.data) {
    return (
      <>
        <b className="block text-[13px]">현재 작품</b>
        <span className="text-muted">{n.isError ? "작품을 불러오지 못했습니다" : "불러오는 중…"}</span>
      </>
    );
  }
  return (
    <>
      <b className="flex min-w-0 items-center gap-1.5 text-[13px]" title={n.data.title}>
        <span className="truncate">{n.data.title}</span>
        {n.data.titleSource !== "user" && (
          <span className="shrink-0 rounded-[4px] bg-info-soft px-1 text-[10.5px] font-semibold text-info">{n.data.titleSource === "auto" ? "가제" : "임시"}</span>
        )}
      </b>
      <span className="text-muted">
        {n.data.genre || labelKo("novel_status", n.data.status)}
        {n.data.pausedAt ? " · 일시정지" : ""}
      </span>
    </>
  );
}

/** Open question + pending approval count for the 인박스 nav item (`<SidebarNavItem count={…}>`). */
export function useInboxNavCount(novelId: string): number | undefined {
  const s = useInboxSummary(novelId, false);
  return s.data ? s.data.open + s.data.pending : undefined;
}
