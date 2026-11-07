/** compact sticky header: back link or the site name (server-safe) */
import Link from "next/link";
import type { ReactNode } from "react";
import { href, SITE_NAME } from "../lib/href";
import { Icon } from "./ui";

export function AppHeader({ back, title }: { back?: string; title?: ReactNode }) {
  return (
    <header className="pr-header">
      {back ? (
        <Link href={back} className="pr-icon-btn" aria-label="뒤로">
          <Icon name="back" />
        </Link>
      ) : (
        <Link href={href.list()} className="pr-brand">
          {SITE_NAME}
        </Link>
      )}
      <span className="pr-header-title">{title}</span>
    </header>
  );
}
