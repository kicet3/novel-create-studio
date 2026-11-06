import { errorMessage } from "../../api/client.js";
import { novelPath } from "../../components/layout/nav.js";
import { Badge, ButtonLink, Card, InlineStatus, type Tone } from "../../components/ui/index.js";
import { useStructure } from "./api.js";
import { rangeLabel, STRUCTURE_STEP_LABEL, structureStep, type StructureStep } from "./tree.js";

const TONE: Record<StructureStep, Tone> = {
  cast_incomplete: "warn",
  blocked: "neutral",
  create: "accent",
  generating: "info",
  draft: "violet",
  awaiting_approval: "warn",
  approved: "ok",
  reapproval: "warn",
};

const HINT: Record<StructureStep, string> = {
  cast_incomplete: "캐릭터 필수 항목을 채우고 확정해야 전체 구성을 만들 수 있습니다.",
  blocked: "기획서를 승인하면 전체 구성을 만들 수 있습니다.",
  create: "결말과 1~4부를 정하는 전체 구성을 만드세요.",
  generating: "AI가 결말과 1~4부를 설계하고 있습니다.",
  draft: "구성 초안을 검토하고 승인하세요.",
  awaiting_approval: "결말과 1~4부를 검토하고 승인하세요. 승인 전에는 플롯 계획을 시작하지 않습니다.",
  approved: "승인된 구성대로 플롯과 화를 계획합니다.",
  reapproval: "승인 뒤 바뀐 내용이 있어 다시 승인해야 합니다.",
};

/** 작품 홈의 전체 구성 단계 카드(CastStepCard와 같은 형식). */
export function StructureStepCard({ novelId, title = "전체 구성" }: { novelId: string; title?: string }) {
  const q = useStructure(novelId);
  const v = q.data;
  const step = v ? structureStep(v) : null;
  return (
    <Card title={title} actions={step ? <Badge tone={TONE[step]} glyph>{STRUCTURE_STEP_LABEL[step]}</Badge> : undefined}>
      {!v || !step ? (
        q.error ? <InlineStatus tone="danger">{errorMessage(q.error)}</InlineStatus> : <InlineStatus>불러오는 중…</InlineStatus>
      ) : (
        <div className="flex flex-col gap-2 text-[13px]">
          <p className="m-0 text-muted">{HINT[step]}</p>
          {v.structure && (
            <p className="m-0">
              {[...v.structure.parts]
                .sort((a, b) => a.ord - b.ord)
                .map((p) => `${p.ord}부 ${rangeLabel(p.plannedEpisodeFrom, p.plannedEpisodeTo)}`)
                .join(" · ")}
              {v.plots.length > 0 && <span className="text-muted"> — 플롯 {v.plots.filter((p) => p.status !== "cancelled").length}개</span>}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {step === "cast_incomplete" && (
              <ButtonLink to={novelPath(novelId, "cast")} size="sm" variant="primary">
                캐릭터 보완하기
              </ButtonLink>
            )}
            <ButtonLink to={novelPath(novelId, "structure")} size="sm" variant={step === "create" || step === "awaiting_approval" || step === "reapproval" ? "primary" : "default"}>
              {step === "create" ? "전체 구성 만들기" : "구성 화면 열기"}
            </ButtonLink>
          </div>
        </div>
      )}
    </Card>
  );
}
