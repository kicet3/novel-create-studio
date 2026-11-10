/** position of the open view: a tiny external store the bars subscribe to (the text never re-renders on scroll). */
import { useSyncExternalStore } from "react";
import type { ReadingAnchor } from "@ncs/reader-core/model";

export interface ProgressState {
  episodeNo: number;
  ratio: number;
  page: number;
  pageCount: number;
}
export function createProgressStore() {
  let state: ProgressState = { episodeNo: 0, ratio: 0, page: 0, pageCount: 0 };
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<ProgressState>) {
      const next = { ...state, ...patch };
      if (next.episodeNo === state.episodeNo && next.ratio === state.ratio && next.page === state.page && next.pageCount === state.pageCount) return;
      state = next;
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
  };
}
export type ProgressStore = ReturnType<typeof createProgressStore>;
export const useProgress = (store: ProgressStore) => useSyncExternalStore(store.subscribe, store.get, store.get);

/** what the bars can ask of the current view */
export interface ViewHandle {
  seek(ratio: number): void;
  step(dir: "prev" | "next"): void;
}

export interface ViewEvents {
  /** center tap: toggle the bars */
  onMenu(): void;
  /** the reader scrolled / turned a page: hide the bars */
  onScrolled(): void;
  /** debounced position for 이어 읽기 */
  onPosition(episodeNo: number, anchor: ReadingAnchor, ratio: number): void;
  /** the end of an episode was reached (읽음) */
  onFinished(episodeNo: number): void;
  /** 다음 화 이어 보기: the episode under the reading line changed */
  onVisibleEpisode(episodeNo: number): void;
  /** page view: turning past the first / last page */
  onLeave(dir: "prev" | "next"): void;
}

/** initial position of a view: anchor, a ratio (older resume records) or the start */
/** `at: "end"`: 페이지 넘김 entered backwards from the next episode → its last text page */
export type InitialPosition = { anchor: ReadingAnchor } | { ratio: number } | { at: "end" } | null;
