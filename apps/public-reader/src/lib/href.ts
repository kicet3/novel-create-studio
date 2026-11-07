/** URL helpers (same paths on the server and in the browser). */
export const href = {
  list: () => "/",
  novel: (slug: string) => `/novels/${slug}`,
  episode: (slug: string, no: number, at?: "end") => `/novels/${slug}/${no}${at ? "?at=end" : ""}`,
  admin: () => "/admin",
};

export const SITE_NAME = "snowpage";
export const SITE_DESCRIPTION = "snowpage — 공개된 연재 소설을 로그인 없이 읽고, 익명으로 댓글을 남기는 곳입니다.";
