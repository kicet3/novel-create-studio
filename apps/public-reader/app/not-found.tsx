import Link from "next/link";
import { AppHeader } from "@/src/components/AppHeader";
import { Message } from "@/src/components/ui";
import { href } from "@/src/lib/href";

export default function NotFound() {
  return (
    <div className="pr-page">
      <AppHeader />
      <main className="pr-main" id="main">
        <h1 className="pr-h1">찾을 수 없습니다</h1>
        <Message>공개되지 않았거나 없는 페이지입니다.</Message>
        <Link className="pr-btn" href={href.list()}>
          작품 목록으로
        </Link>
      </main>
    </div>
  );
}
