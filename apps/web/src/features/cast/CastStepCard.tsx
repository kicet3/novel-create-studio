import { Link } from "react-router";
import { errorMessage } from "../../api/client.js";
import { novelPath } from "../../components/layout/nav.js";
import { Badge, ButtonLink, Card, InlineStatus } from "../../components/ui/index.js";
import { useCast } from "./api.js";

/** 작품 홈(설정 마무리)의 캐릭터 설정 단계 카드: 상태 요약 + 캐릭터 화면으로 가는 링크. */
export function CastStepCard({ novelId, title = "캐릭터 설정 (필수)" }: { novelId: string; title?: string }) {
  const cast = useCast(novelId);
  const v = cast.data;
  return (
    <Card
      title={title}
      actions={v ? v.confirmed ? <Badge tone="ok" glyph>확정됨</Badge> : <Badge tone="warn" glyph>확정 필요</Badge> : undefined}
    >
      {!v ? (
        cast.error ? <InlineStatus tone="danger">{errorMessage(cast.error)}</InlineStatus> : <InlineStatus>불러오는 중…</InlineStatus>
      ) : (
        <div className="flex flex-col gap-2 text-[13px]">
          <p className="m-0">
            주인공 {v.counts.protagonist}명 · 서브 주인공 {v.counts.subProtagonist}명 · 기타 {v.counts.other}명
            {v.items.length > 0 && (
              <span className="text-muted"> — {v.items.slice(0, 5).map((c) => c.name).join(", ")}{v.items.length > 5 ? " 외" : ""}</span>
            )}
          </p>
          {!v.confirmed && (
            <p className="m-0 text-muted">
              주인공 1명을 정하고 캐스트를 확정해야 연재 목표를 저장할 수 있습니다.{v.blockers[0] ? ` (${v.blockers[0]})` : ""}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <ButtonLink to={novelPath(novelId, "cast")} variant={v.confirmed ? "default" : "primary"} size="sm">
              {v.confirmed ? "캐릭터 보기" : "캐릭터 설정하기"}
            </ButtonLink>
            {!v.confirmed && v.items.length === 0 && (
              <Link to={novelPath(novelId, "cast")} className="self-center text-xs">
                AI 초안으로 시작하기
              </Link>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
