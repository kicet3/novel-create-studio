/** image_generations status transitions (pure). Anything not in the table is an InvalidTransitionError. */
import type { ImageGenerationStatus } from "@ncs/shared";

export interface ImageTransition {
  id: string;
  from: ImageGenerationStatus[];
  to: ImageGenerationStatus;
}

export const IMAGE_TRANSITIONS = {
  /** the worker picked the request up */
  start: { id: "IG1", from: ["queued"], to: "running" },
  succeed: { id: "IG2", from: ["running"], to: "succeeded" },
  fail: { id: "IG3", from: ["queued", "running"], to: "failed" },
  cancel: { id: "IG4", from: ["queued", "running"], to: "cancelled" },
} as const satisfies Record<string, ImageTransition>;

export const FINAL_STATUSES: readonly ImageGenerationStatus[] = ["succeeded", "failed", "cancelled"];
export const OPEN_STATUSES: ImageGenerationStatus[] = ["queued", "running"];
