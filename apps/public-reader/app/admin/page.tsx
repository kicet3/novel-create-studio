/** /admin — 운영(댓글 숨기기·삭제, 숫자 보기). Disabled unless ADMIN_TOKEN is set; the token is entered once and kept as an httpOnly cookie. */
import type { Metadata } from "next";
import { AppHeader } from "@/src/components/AppHeader";
import { AdminPanel } from "@/src/components/AdminPanel";
import { href } from "@/src/lib/href";

export const metadata: Metadata = { title: "운영", robots: { index: false, follow: false } };

export default function AdminPage() {
  return (
    <div className="pr-page">
      <AppHeader back={href.list()} title="운영" />
      <main className="pr-main" id="main">
        <AdminPanel />
      </main>
    </div>
  );
}
