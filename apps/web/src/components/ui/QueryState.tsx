import type { ReactNode } from "react";
import { errorMessage, isApiRequestError } from "../../api/client.js";
import { Button } from "./Button.js";
import { Callout } from "./Callout.js";
import { EmptyState } from "./EmptyState.js";
import { InlineStatus } from "./misc.js";

/** True when the server answered 501 `not_implemented` (module still a placeholder, CONVENTIONS §4). */
export function isNotImplemented(e: unknown): boolean {
  return isApiRequestError(e) && (e.status === 501 || e.code === "not_implemented");
}

/** True when the API route does not exist yet (server's catch-all 404 "API 경로를 찾을 수 없습니다."). */
export function isMissingRoute(e: unknown): boolean {
  return isApiRequestError(e) && e.status === 404 && e.message.startsWith("API 경로");
}

/** Not implemented (501) or route missing — both shown as "준비 중". */
export function isUnavailable(e: unknown): boolean {
  return isNotImplemented(e) || isMissingRoute(e);
}

export interface NotReadyProps {
  title?: ReactNode;
  description?: ReactNode;
  compact?: boolean;
}

/** "준비 중" state for features whose server module is not implemented yet. */
export function NotReady({ title = "준비 중입니다", description, compact = false }: NotReadyProps) {
  if (compact) {
    return (
      <p role="status" className="m-0 text-[13px] text-muted">
        <span aria-hidden="true">… </span>
        {title}
        {description && <span className="text-faint"> · {description}</span>}
      </p>
    );
  }
  return (
    <EmptyState
      icon="…"
      title={title}
      description={description ?? "서버의 해당 기능이 아직 준비되지 않았습니다. 준비되면 이 자리에 표시됩니다."}
    />
  );
}

/** Error callout with retry, or "준비 중" for 501. */
export function QueryError({
  error,
  onRetry,
  retrying,
  compact = false,
  notReadyDescription,
}: {
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  compact?: boolean;
  notReadyDescription?: ReactNode;
}) {
  if (isUnavailable(error)) return <NotReady compact={compact} description={notReadyDescription} />;
  if (compact) return <InlineStatus tone="danger">{errorMessage(error)}</InlineStatus>;
  return (
    <Callout
      tone="danger"
      title="불러오지 못했습니다"
      actions={
        onRetry && (
          <Button size="sm" onClick={onRetry} loading={retrying}>
            다시 시도
          </Button>
        )
      }
    >
      <span className="text-muted">{errorMessage(error)}</span>
    </Callout>
  );
}

/** Minimal shape of a TanStack Query result used by QueryView. */
export interface QueryLike<T> {
  data: T | undefined;
  error: unknown;
  isPending: boolean;
  isFetching?: boolean;
  refetch?: () => unknown;
}

/**
 * Render a query: loading line → error / 준비 중 → children(data).
 * Keeps showing stale data when a background refetch fails.
 */
export function QueryView<T>({
  query,
  children,
  loadingLabel = "불러오는 중…",
  compact = false,
  notReadyDescription,
}: {
  query: QueryLike<T>;
  children: (data: T) => ReactNode;
  loadingLabel?: string;
  compact?: boolean;
  notReadyDescription?: ReactNode;
}) {
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.error) {
    return (
      <QueryError
        error={query.error}
        compact={compact}
        notReadyDescription={notReadyDescription}
        onRetry={query.refetch ? () => void query.refetch?.() : undefined}
        retrying={query.isFetching}
      />
    );
  }
  return <InlineStatus>{loadingLabel}</InlineStatus>;
}
