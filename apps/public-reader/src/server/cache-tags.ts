/**
 * Next data-cache tags shared by the cached reads (cached.ts) and the on-demand revalidate endpoint (api.ts).
 * Kept free of `server-only` so api.ts stays testable outside Next.
 */
export const CONTENT_TAG = "snowpage-content";
