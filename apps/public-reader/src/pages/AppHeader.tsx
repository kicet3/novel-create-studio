/** compact sticky header: back / site name, account button */
import type { ReactNode } from "react";
import { SITE_NAME } from "../lib/hooks.js";
import { href, Link } from "../lib/router.js";
import { useSession } from "../lib/session.js";
import { Icon } from "../components/ui.js";

export function AppHeader({ back, title }: { back?: string; title?: ReactNode }) {
  const s = useSession();
  return (
    <header className="pr-header">
      {back ? (
        <Link to={back} className="pr-icon-btn" aria-label="뒤로">
          <Icon name="back" />
        </Link>
      ) : (
        <Link to={href.list()} className="pr-brand">
          {SITE_NAME}
        </Link>
      )}
      <span className="pr-header-title">{title}</span>
      {s.available &&
        (s.nickname ? (
          <button type="button" className="pr-account" onClick={() => window.confirm(`${s.nickname}님, 로그아웃할까요?`) && void s.logout()}>
            <Icon name="user" size={18} />
            <span>{s.nickname}</span>
          </button>
        ) : (
          <button type="button" className="pr-account" onClick={() => s.requireLogin()}>
            로그인
          </button>
        ))}
    </header>
  );
}
