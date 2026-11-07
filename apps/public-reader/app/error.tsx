"use client";
import { Message } from "@/src/components/ui";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="pr-page">
      <main className="pr-main" id="main">
        <h1 className="pr-h1">잠시 문제가 생겼습니다</h1>
        <Message tone="danger">작품을 불러오지 못했습니다. 잠시 뒤에 다시 해 주세요.</Message>
        <button type="button" className="pr-btn" onClick={() => reset()}>
          다시 시도
        </button>
      </main>
    </div>
  );
}
