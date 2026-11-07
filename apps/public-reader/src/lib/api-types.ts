/**
 * JSON shapes of the snowpage API (app/api/**), shared by the route handlers and the client components (type-only).
 * Everything is anonymous: there are no accounts. A visitor id (httpOnly cookie) and the ip hash are server-side
 * only and never appear in any response.
 */
export interface SessionDto {
  /** double-submit CSRF token (also in an httpOnly cookie): send it as `X-CSRF-Token` on POST / PUT / DELETE */
  csrf: string;
  /** false: anonymous writes are switched off on this deployment (IP_HASH_SECRET missing) */
  writable: boolean;
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
  /** written by this browser (visitor cookie) — may delete it */
  mine: boolean;
  /** mine and held for review (banned word): only the author sees it */
  pending: boolean;
  replies: CommentDto[];
}

export interface CommentListDto {
  items: CommentDto[];
  total: number;
}

export interface NewCommentRequest {
  body: string;
  nickname?: string | null;
  parentId?: number | null;
  /** honeypot: must stay empty (hidden field) */
  website?: string;
}

export interface AdminSessionDto {
  /** ADMIN_TOKEN is configured on this deployment */
  enabled: boolean;
  authed: boolean;
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
  heldReason: string | null;
  /** the episode is no longer published (its comments are not served to readers) */
  unpublished: boolean;
}

export interface AdminOverviewDto {
  visitors: number;
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
