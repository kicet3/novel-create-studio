/** JSON shapes of the reader server API (/api/…), shared with the SPA (type-only). */
export interface SessionDto {
  reader: { nickname: string } | null;
  /** double-submit CSRF token (also in the `ncs_csrf` cookie): send it as `X-CSRF-Token` on POST/PUT/DELETE */
  csrf: string;
}

export interface NovelStatsDto {
  likes: number;
  liked: boolean;
  rating: { average: number | null; count: number; mine: number | null };
}

export interface EpisodeStatsDto {
  likes: number;
  liked: boolean;
  comments: number;
}

export interface CommentDto {
  id: number;
  /** null when deleted / hidden (placeholder kept so its replies stay readable) */
  nickname: string | null;
  /** plain text (render as text, never as HTML); null when deleted / hidden */
  body: string | null;
  createdAt: string;
  state: "visible" | "deleted" | "hidden";
  mine: boolean;
  replies: CommentDto[];
}

export interface CommentListDto {
  items: CommentDto[];
  total: number;
}

export interface AdminCommentDto {
  id: number;
  slug: string;
  episodeNo: number;
  parentId: number | null;
  nickname: string;
  body: string;
  createdAt: string;
  deleted: boolean;
  hidden: boolean;
  /** the episode is no longer in the published snapshot (comments are not served to readers) */
  unpublished: boolean;
}

export interface AdminOverviewDto {
  readers: number;
  comments: number;
  hiddenComments: number;
  novelLikes: number;
  episodeLikes: number;
  ratings: number;
  recent: AdminCommentDto[];
}

export interface ApiErrorDto {
  error: { code: string; message: string };
}
