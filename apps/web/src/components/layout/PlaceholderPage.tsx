import type { ReactNode } from "react";
import { PageHeader } from "./PageHeader.js";
import { EmptyState } from "../ui/EmptyState.js";
import { ReqTag } from "../ui/misc.js";

export interface PlaceholderPageProps {
  title: string;
  subtitle?: ReactNode;
  /** What this screen will do, one sentence. */
  description: ReactNode;
  /** Requirement ids covered by the screen (PRD FR-*). */
  requirements?: readonly string[];
  actions?: ReactNode;
  children?: ReactNode;
}

/** Temporary screen body until the feature is implemented under `features/<name>/`. */
export function PlaceholderPage({ title, subtitle, description, requirements, actions, children }: PlaceholderPageProps) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} />
      <EmptyState
        icon="…"
        title="이 화면은 준비 중입니다"
        description={description}
        actions={actions}
      >
        {requirements && requirements.length > 0 && (
          <span className="inline-flex flex-wrap justify-center gap-1">
            <span className="sr-only">관련 요구사항:</span>
            {requirements.map((r) => (
              <ReqTag key={r}>{r}</ReqTag>
            ))}
          </span>
        )}
      </EmptyState>
      {children}
    </>
  );
}
