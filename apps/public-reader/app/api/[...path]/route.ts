/**
 * snowpage API — every endpoint goes through src/server/api.ts (anonymous reactions + admin; no login / signup).
 * Always dynamic, never cached.
 */
import { getReaderApi } from "@/src/server/instance";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const { path } = await ctx.params;
  return getReaderApi().handle(req, path);
}

export { handle as GET, handle as POST, handle as PUT, handle as DELETE };
