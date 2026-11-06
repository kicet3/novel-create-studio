import { useQuery } from "@tanstack/react-query";
import { healthResponseSchema, type HealthResponse } from "@ncs/shared";
import { api } from "./client.js";
import { AMBIENT_POLL_INTERVAL_MS } from "./query-client.js";
import { queryKeys } from "./query-keys.js";

export function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return api.get("/health", { schema: healthResponseSchema, signal });
}

/** `GET /api/health`, polled for the global status banner. */
export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => fetchHealth(signal),
    refetchInterval: AMBIENT_POLL_INTERVAL_MS,
    retry: false,
  });
}
