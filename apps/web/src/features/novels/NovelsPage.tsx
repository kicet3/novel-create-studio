import { useState } from "react";
import { Link } from "react-router";
import { labelKo } from "@ncs/shared";
import { PageHeader } from "../../components/layout/PageHeader.js";
import { novelPath } from "../../components/layout/nav.js";
import { Badge, Button, ButtonLink, Card, Checkbox, Dialog, EmptyState, formatDateTime, QueryView, StatusBadge } from "../../components/ui/index.js";
import { CreateNovelForm } from "./CreateNovelForm.js";
import { useNovels, type NovelDto } from "./api.js";

/** 상태별 다음 화면: 컨셉 중이면 컨셉 대화, 그 외에는 작품 홈. */
function entryPath(n: NovelDto): string {
  return n.status === "concept" ? novelPath(n.id, "concept") : novelPath(n.id);
}

/** `/novels` — 작품 목록 + 새 작품 (FR-NOV-01, FR-NOV-09). */
export function NovelsPage() {
  const [archived, setArchived] = useState(false);
  const [open, setOpen] = useState(false);
  const novels = useNovels(archived);
  return (
    <>
      <PageHeader
        title="작품 목록"
        subtitle="이 설치에서 관리하는 작품"
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            새 작품 만들기
          </Button>
        }
      />
      <div className="mb-3 flex justify-end">
        <Checkbox label="보관된 작품 포함" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
      </div>
      <QueryView query={novels} loadingLabel="작품 목록을 불러오는 중…">
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState
              icon="N"
              title="아직 작품이 없습니다"
              description="새 작품을 만들면 컨셉 파트너와 대화로 장르·주인공·결말 방향을 정하는 것부터 시작합니다."
              actions={
                <>
                  <Button variant="primary" onClick={() => setOpen(true)}>
                    새 작품 만들기
                  </Button>
                  <ButtonLink to="/onboarding">처음 설정 안내</ButtonLink>
                </>
              }
            />
          ) : (
            <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 min-[521px]:grid-cols-2 min-[861px]:grid-cols-3">
              {d.items.map((n) => (
                <li key={n.id}>
                  <Card as="article" className="flex h-full flex-col gap-2">
                    <h2 className="text-[15px] font-bold">
                      <Link to={entryPath(n)} className="text-text no-underline hover:underline">
                        {n.title}
                      </Link>
                    </h2>
                    <div className="text-xs text-muted">{n.genre || "장르 미정"}</div>
                    <div className="flex flex-wrap gap-1.5">
                      <StatusBadge enum="novel_status" value={n.status} />
                      <StatusBadge enum="autonomy_level" value={n.autonomyLevel} />
                      {n.pausedAt && (
                        <Badge tone="warn" glyph>
                          일시정지
                        </Badge>
                      )}
                    </div>
                    <div className="mt-auto flex items-center justify-between pt-1 text-xs text-faint">
                      <span>
                        {labelKo("age_rating", n.ageRating)} · 수정 {formatDateTime(n.updatedAt, n.timezone)}
                      </span>
                      <ButtonLink size="sm" to={entryPath(n)} aria-label={`${n.title} 열기`}>
                        {n.status === "concept" ? "컨셉 이어 하기" : "열기"}
                      </ButtonLink>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
      <Dialog open={open} onClose={() => setOpen(false)} title="새 작품 만들기" description="작품을 만들면 컨셉 대화 화면으로 이동합니다." size="lg" footer={false}>
        <CreateNovelForm onCancel={() => setOpen(false)} />
      </Dialog>
    </>
  );
}
