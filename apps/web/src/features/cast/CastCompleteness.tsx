import { useState } from "react";
import { Link } from "react-router";
import { labelKo, type CastView } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { novelPath } from "../../components/layout/nav.js";
import { Badge, Button, Card, Checkbox } from "../../components/ui/index.js";
import { useRequestCastDraft } from "./api.js";
import { completenessRows, completenessSummary, plotCompletenessSummary } from "./completeness.js";

/**
 * 구성 전 캐릭터 완성도 체크리스트: 인물마다 빠진 필수 항목 칩, [빈 항목 AI로 채우기](fillMissing, 고른 인물).
 * AI는 빈 칸만 채우고 사용자가 정한 값은 바꾸지 않습니다. 제안은 수락하거나 확정해야 완성도에 들어갑니다.
 */
export function CastCompleteness({ novelId, view }: { novelId: string; view: CastView }) {
  const c = view.completeness;
  const rows = completenessRows(c);
  const fillable = rows.filter((r) => r.fillable);
  const [picked, setPicked] = useState<string[] | null>(null);
  const selected = picked ?? fillable.map((r) => r.characterId);
  const fill = useRequestCastDraft(novelId);
  const busy = !!view.draftTask;
  if (view.items.length === 0) return null;
  const plotRows = completenessRows(view.plotCompleteness);
  const arcTitle = (arcId: string | null) => view.items.find((c) => c.introducedArcId === arcId)?.firstAppearanceArcTitle ?? null;
  return (
    <>
    <Card
      title="구성 전 캐릭터 체크리스트"
      actions={c.complete ? <Badge tone="ok" glyph>충족</Badge> : <Badge tone="warn" glyph>보완 필요</Badge>}
    >
      <div className="flex flex-col gap-2 text-[13px]">
        <p className="m-0 text-muted">{completenessSummary(c)}</p>
        {c.complete && (
          <p className="m-0">
            <Link to={novelPath(novelId, "structure")}>구성 화면으로 가기</Link>
          </p>
        )}
        {rows.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {rows.map((r) => (
              <li key={r.characterId} className="flex flex-col gap-1 rounded-lg border border-border px-2.5 py-2 min-[700px]:flex-row min-[700px]:items-start min-[700px]:gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 min-[700px]:w-56 min-[700px]:flex-none">
                  {r.fillable ? (
                    <Checkbox
                      label={r.name}
                      checked={selected.includes(r.characterId)}
                      onChange={(e) => setPicked(e.target.checked ? [...selected, r.characterId] : selected.filter((x) => x !== r.characterId))}
                    />
                  ) : (
                    <b>{r.name}</b>
                  )}
                  <Badge tone="neutral">{labelKo("character_role", r.role)}</Badge>
                  {r.introducedArcId && <Badge tone="info">플롯에서 등장</Badge>}
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                  {r.missing.map((m) => (
                    <Badge key={m} tone="warn">
                      {m}
                    </Badge>
                  ))}
                  {r.unconfirmed && <Badge tone="violet">확정 전</Badge>}
                  <Link to={novelPath(novelId, `cast/${r.characterId}`)} className="ml-1 text-xs">
                    편집
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
        {fillable.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="primary"
                loading={fill.isPending || busy}
                disabled={busy || selected.length === 0}
                onClick={() => fill.mutate({ fillMissing: true, includeAntagonist: false, characterIds: selected })}
              >
                {busy ? "AI가 채우는 중…" : `빈 항목 AI로 채우기 (${selected.length}명)`}
              </Button>
            </div>
            <p className="m-0 text-xs text-muted">AI는 빈 칸만 채우고 직접 쓴 값은 바꾸지 않습니다. AI 제안은 수락하거나 캐스트를 확정해야 반영됩니다.</p>
          </div>
        )}
        {fill.error && (
          <p className="m-0 text-xs text-danger" role="alert">
            {errorMessage(fill.error)}
          </p>
        )}
      </div>
    </Card>
    {plotRows.length > 0 && (
      <Card title="플롯에서 새로 등장한 인물" actions={<Badge tone="warn" glyph>확인 필요</Badge>}>
        <div className="flex flex-col gap-2 text-[13px]">
          <p className="m-0 text-muted">{plotCompletenessSummary(view.plotCompleteness)}</p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {plotRows.map((r) => (
              <li key={r.characterId} className="flex flex-col gap-1 rounded-lg border border-border px-2.5 py-2 min-[700px]:flex-row min-[700px]:items-start min-[700px]:gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 min-[700px]:w-56 min-[700px]:flex-none">
                  <b>{r.name}</b>
                  <Badge tone="neutral">{labelKo("character_role", r.role)}</Badge>
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                  {arcTitle(r.introducedArcId) && <span className="text-xs text-muted">「{arcTitle(r.introducedArcId)}」 플롯</span>}
                  {r.missing.map((m) => (
                    <Badge key={m} tone="warn">
                      {m} 비어 있음
                    </Badge>
                  ))}
                  {r.unconfirmed && <Badge tone="violet">AI 제안 수락 전</Badge>}
                  <Link to={novelPath(novelId, `cast/${r.characterId}`)} className="ml-1 text-xs">
                    확인하기
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Card>
    )}
    </>
  );
}
