import type { ReactNode } from "react";
import { useDocumentTitle } from "../../lib/use-document-title.js";

export interface PageHeaderProps {
  title: string;
  /** One-line summary under the title (`.app-top .sub`). */
  subtitle?: ReactNode;
  /** Right side: badges / buttons. */
  actions?: ReactNode;
}

/** `.app-top`: page h1 + subtitle + actions. Also sets document.title. */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  useDocumentTitle(title);
  return (
    <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-bold">{title}</h1>
        {subtitle && <div className="text-[12.5px] text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
