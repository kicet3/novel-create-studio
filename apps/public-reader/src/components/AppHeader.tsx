/** compact sticky header: back link or the site name (server-safe); PC adds the site name + nav on the right */
import Link from "next/link";
import type { ReactNode } from "react";
import { href, SITE_NAME } from "../lib/href";
import { Icon } from "./ui";

export function AppHeader({ back, title, current }: { back?: string; title?: ReactNode; current?: "list" }) {
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
      {/* PC only (hidden below 1024px) */}
      <nav className="pr-nav" aria-label="사이트">
        <Link href={href.list()} aria-current={current === "list" ? "page" : undefined}>
          작품 목록
        </Link>
      </nav>
    </header>
  );
}
