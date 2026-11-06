/**
 * ProviderCall state machine (04 §6.2, provider_call_status). Pure.
 * P1 (create) → prepared · P2 prepared→sent · P3 sent→responded · P4 sent→failed · P5 sent→unknown
 * P6 prepared→abandoned · P7 unknown→responded_late
 */
import type { ProviderCallStatus } from "@ncs/shared";
import { InvalidTransitionError } from "../../../platform/index.js";

export interface ProviderCallTransition {
  id: "P2" | "P3" | "P4" | "P5" | "P6" | "P7";
  from: readonly ProviderCallStatus[];
  to: ProviderCallStatus;
}

export const PROVIDER_CALL_TRANSITIONS: readonly ProviderCallTransition[] = [
  { id: "P2", from: ["prepared"], to: "sent" },
  { id: "P3", from: ["sent"], to: "responded" },
  { id: "P4", from: ["sent"], to: "failed" },
  { id: "P5", from: ["sent"], to: "unknown" },
  { id: "P6", from: ["prepared"], to: "abandoned" },
  { id: "P7", from: ["unknown"], to: "responded_late" },
];

export function providerCallTransition(id: ProviderCallTransition["id"]): ProviderCallTransition {
  return PROVIDER_CALL_TRANSITIONS.find((t) => t.id === id)!;
}

/** throws InvalidTransitionError when `from → to` is not in the table */
export function assertProviderCallTransition(from: ProviderCallStatus, to: ProviderCallStatus): ProviderCallTransition {
  const t = PROVIDER_CALL_TRANSITIONS.find((x) => x.to === to && x.from.includes(from));
  if (!t) throw new InvalidTransitionError("provider_call", from, to);
  return t;
}

/** RU-2: only these statuses are reused on rerun (RU-5: failed/unknown never). */
export const REUSABLE_STATUSES: readonly ProviderCallStatus[] = ["responded", "responded_late"];
