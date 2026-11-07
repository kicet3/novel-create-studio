/** within this many px of the bottom counts as "reading the latest" (the log keeps following new content) */
export const PIN_THRESHOLD_PX = 80;
export const atBottom = (scrollHeight: number, scrollTop: number, clientHeight: number): boolean =>
  scrollHeight - scrollTop - clientHeight <= PIN_THRESHOLD_PX;
