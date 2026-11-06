import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string(),
  database: z.enum(["pass", "warn", "fail"]),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
