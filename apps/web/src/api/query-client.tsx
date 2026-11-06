import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DEFAULTS } from "@ncs/shared";
import { isApiRequestError } from "./client.js";

/**
 * MVP-α has no WebSocket push (08 §9.1): every query refetches on window focus,
 * and live screens (inbox, board) poll with `refetchInterval: POLL_INTERVAL_MS`.
 */
export const POLL_INTERVAL_MS = DEFAULTS["ui.poll_interval_seconds"] * 1000;
/** Slower poll for ambient status (health banner, sidebar counts). */
export const AMBIENT_POLL_INTERVAL_MS = 30_000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 2_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        refetchIntervalInBackground: false,
        // 4xx are not transient (404 = other novel / missing, T-4); retry only network and 5xx.
        retry: (failureCount, error) => {
          if (isApiRequestError(error) && error.isClientError) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
