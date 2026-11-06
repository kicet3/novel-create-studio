import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { formatUsd, labelKo, type ConceptEntryMode, type ConceptSessionViewDto, type NovelDto } from "@ncs/shared";
import { api, errorMessage } from "../../api/client.js";
import { queryKeys } from "../../api/query-keys.js";
import { useNovelId } from "../../app/novel-context.js";
import { PageHeader } from "../../components/layout/PageHeader.js";
import { novelPath } from "../../components/layout/nav.js";
import { Badge, Button, ButtonLink, Callout, ConfirmDialog, EmptyState, QueryView, Select, StatusBadge } from "../../components/ui/index.js";
import { GoalForm } from "../home/GoalForm.js";
import { CastStepCard } from "../cast/CastStepCard.js";
import { useInvalidateNovel, useNovel } from "../novels/api.js";
import { WorkingTitleBar } from "./WorkingTitleBar.js";
import { BriefPanel } from "./BriefPanel.js";
import { ChatPanel } from "./ChatPanel.js";
import { ConceptModelPicker } from "./ConceptModelPicker.js";
import {
  useAbandonSession,
  useConceptMessages,
  useConceptSession,
  useExtendSession,
  useSessionCommand,
  useStartRevision,
  useSwitchEntryMode,
} from "./api.js";

/** `/novels/:novelId/concept` — 컨셉 대화 + 작업 중 브리프 (design/11 §4.1, 08 §9 신규 화면). */
export function ConceptPage() {
  const novelId = useNovelId();
  const novel = useNovel(novelId);
  const session = useConceptSession(novelId);
  return (
    <QueryView query={session} loadingLabel="컨셉 세션을 불러오는 중…" notReadyDescription="컨셉 모듈이 준비되면 대화를 시작할 수 있습니다.">
      {(view) => (view ? <ConceptBody novelId={novelId} novel={novel.data} view={view} /> : <NoSession novelId={novelId} novel={novel.data} />)}
    </QueryView>
  );
}

function NoSession({ novelId, novel }: { novelId: string; novel?: NovelDto }) {
  const revise = useStartRevision(novelId);
  return (
    <>
      <PageHeader title="컨셉" subtitle={novel?.title} />
      <EmptyState
        title="진행 중인 컨셉 세션이 없습니다"
        description={novel && novel.status !== "concept" ? "승인된 컨셉을 고치려면 개정 세션을 시작하세요. 기획서가 승인된 뒤의 개정은 별도 승인을 거칩니다." : undefined}
        actions={
          <Button variant="primary" loading={revise.isPending} onClick={() => revise.mutate()}>
            컨셉 고치기
          </Button>
        }
      >
        {revise.error && <span className="text-danger">{errorMessage(revise.error)}</span>}
      </EmptyState>
    </>
  );
}

function usePendingApprovalQuestion(novelId: string, approvalId: string | null) {
  return useQuery({
    queryKey: [...queryKeys.novel(novelId).inbox({ approval: approvalId }), "question-of"],
    enabled: !!approvalId,
    retry: false,
    queryFn: ({ signal }) => api.get<{ questionId?: string }>(`/novels/${novelId}/approvals/${approvalId}`, { signal }).then((a) => a.questionId ?? null),
  });
}

function useApprovedBibleExists(novelId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...queryKeys.novel(novelId).all, "bible-approved"],
    enabled,
    queryFn: ({ signal }) => api.get<unknown>(`/novels/${novelId}/bibles/approved`, { signal }).then((b) => !!b),
  });
}

/**
 * 11 §3.10 / CT-24: once the brief is approved — before the series bible is approved (onboarding /
 * planning) a revision session can start (FR-NOV-10a); afterwards concept revision is MVP-β and the
 * user is pointed at the bible, canon_change and ending_change paths.
 */
function ApprovedRevision({ novelId, novel }: { novelId: string; novel?: NovelDto }) {
  const early = novel?.status === "onboarding" || novel?.status === "planning";
  const bible = useApprovedBibleExists(novelId, !!novel && early);
  const revise = useStartRevision(novelId);
  if (!novel || novel.status === "concept" || novel.status === "archived" || novel.status === "completed") return null;
  if (early && bible.data === false) {
    return (
      <Callout
        tone="info"
        title="승인된 컨셉"
        actions={
          <Button size="sm" loading={revise.isPending} onClick={() => revise.mutate()}>
            컨셉 고치기
          </Button>
        }
      >
        기획서가 승인되기 전이라 컨셉을 고칠 수 있습니다. 개정 브리프가 승인되면 진행 중인 기획서 작성은 새 브리프로 다시 시작합니다.
        {revise.error && <span className="mt-1 block text-danger">{errorMessage(revise.error)}</span>}
      </Callout>
    );
  }
  if (early && bible.data === undefined) return null;
  return (
    <Callout
      tone="info"
      title="승인된 컨셉"
      actions={
        <Button size="sm" disabled title="다음 버전에서 제공">
          컨셉 고치기
        </Button>
      }
    >
      기획서가 승인된 뒤의 컨셉 개정은 다음 버전에서 제공합니다. 지금은 <Link to={novelPath(novelId, "board")}>보드의 기획서</Link>를 고치거나,{" "}
      <Link to={novelPath(novelId, "ontology")}>온톨로지에서 캐논 변경</Link>, <Link to={novelPath(novelId)}>목표의 결말 방향 변경(승인 필요)</Link>으로 바꿀 수 있습니다.
    </Callout>
  );
}

const ENTRY_MODES: ConceptEntryMode[] = ["conversation", "import", "direct_input"];

function ConceptBody({ novelId, novel, view }: { novelId: string; novel?: NovelDto; view: ConceptSessionViewDto }) {
  const s = view.session;
  const messages = useConceptMessages(novelId, s.id, s.inFlightTaskId !== null);
  const cmd = useSessionCommand(novelId, s.id);
  const extend = useExtendSession(novelId, s.id);
  const switchMode = useSwitchEntryMode(novelId, s.id);
  const abandon = useAbandonSession(novelId, s.id);
  const approvalQ = usePendingApprovalQuestion(novelId, s.pendingApprovalId);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  // the agent may rename the working title on any turn: refresh the novel when a new message arrives
  const invalidateNovel = useInvalidateNovel(novelId);
  const lastSeq = messages.data?.[messages.data.length - 1]?.seq;
  useEffect(() => {
    if (lastSeq !== undefined) void invalidateNovel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSeq]);

  const jump = (id: string) => {
    setHighlight(id);
    const el = document.getElementById(`msg-${id}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.focus({ preventScroll: true });
  };

  const turnsLeft = view.turns.limit - view.turns.used;
  const nearLimit = view.turns.used >= view.turns.softWarning;
  const budgetLeft = view.budget.limitMicros - view.budget.spentMicros;
  const err = cmd.error ?? extend.error ?? switchMode.error ?? abandon.error;

  return (
    <>
      <PageHeader
        title="컨셉"
        subtitle={
          <>
            {s.purpose === "revision" ? "컨셉 개정 · " : ""}
            {view.stageLabel} · 턴 {view.turns.used}/{view.turns.limit} · 비용 {formatUsd(view.budget.spentMicros)} / {formatUsd(view.budget.limitMicros)}
          </>
        }
        actions={
          <>
            {(s.status === "active" || s.status === "paused") && !s.llmDisabled && <ConceptModelPicker novelId={novelId} busy={s.inFlightTaskId !== null} />}
            <StatusBadge enum="concept_session_status" value={s.status} />
            {s.status === "active" && (
              <Button onClick={() => cmd.mutate("pause")} loading={cmd.isPending && cmd.variables === "pause"}>
                잠시 멈추기
              </Button>
            )}
            {s.status === "paused" && (
              <Button onClick={() => cmd.mutate("resume")} loading={cmd.isPending && cmd.variables === "resume"}>
                이어 하기
              </Button>
            )}
            {(s.status === "active" || s.status === "paused") && (
              <Button variant="primary" disabled={!view.canSubmit} onClick={() => setConfirmSubmit(true)} title={view.canSubmit ? undefined : "필수 항목을 확정하고 막힌 항목을 해결하세요."}>
                승인 요청
              </Button>
            )}
          </>
        }
      />
      <div className="flex flex-col gap-3">
        <WorkingTitleBar novelId={novelId} novel={novel} view={view} />
        {err && <Callout tone="danger">{errorMessage(err)}</Callout>}
        {cmd.isSuccess && cmd.variables === "submit" && s.status === "active" && (
          <Callout tone="info">브리프 점검을 시작했습니다. 점검이 끝나면 인박스에 승인 요청이 올라옵니다.</Callout>
        )}
        {s.status === "awaiting_approval" && (
          <Callout
            tone="warn"
            title="컨셉 브리프 승인 대기"
            actions={
              <ButtonLink variant="primary" size="sm" to={novelPath(novelId, approvalQ.data ? `inbox/${approvalQ.data}` : "inbox")}>
                인박스에서 승인·반려
              </ButtonLink>
            }
          >
            브리프를 검토하고 승인하면 작품의 장르·연령 등급·타깃이 정해지고 연재 목표를 정하는 단계로 넘어갑니다.
          </Callout>
        )}
        {s.status === "paused" && (
          <Callout tone="warn" title="세션이 멈춰 있습니다">
            사유: {s.pauseReason ? labelKo("concept_pause_reason", s.pauseReason) : "—"}.
            {s.pauseReason === "budget_limit" && (
              <Button size="sm" className="ml-2" loading={extend.isPending} onClick={() => extend.mutate({ budgetMicros: view.budget.limitMicros * 2 })}>
                비용 상한 2배로 올리기
              </Button>
            )}
          </Callout>
        )}
        {s.status === "active" && nearLimit && (
          <Callout
            tone="warn"
            title={`남은 턴 ${Math.max(0, turnsLeft)}회`}
            actions={
              view.turns.extensionsLeft > 0 ? (
                <Button size="sm" loading={extend.isPending} onClick={() => extend.mutate({ turns: true })}>
                  턴 상한 올리기
                </Button>
              ) : undefined
            }
          >
            상한에 가까워지면 지금까지 내용으로 정리해 승인 요청하는 것을 권합니다. 남은 비용 {formatUsd(Math.max(0, budgetLeft))}.
          </Callout>
        )}
        {s.llmDisabled && <Callout tone="info">LLM 없이 진행 중입니다. 정해진 질문 순서대로 묻고, 브리프는 직접 고칠 수 있습니다.</Callout>}
        {s.status === "approved" && <ApprovedRevision novelId={novelId} novel={novel} />}
        {s.status === "approved" && novel?.status === "onboarding" && (
          <>
            <Callout tone="ok" title="컨셉이 승인됐습니다">
              다음은 캐릭터 설정 단계입니다. 주인공과 서브 주인공을 정해 캐스트를 확정한 뒤, 아래 연재 목표를 저장하면 기획서 작성이 시작됩니다.
            </Callout>
            <CastStepCard novelId={novelId} title="1. 캐릭터 설정 (필수)" />
            <GoalForm novelId={novelId} title="2. 연재 목표" />
          </>
        )}

        <div className="grid grid-cols-1 gap-3 min-[861px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <QueryView query={messages} compact>
            {(msgs) => <ChatPanel novelId={novelId} view={view} messages={msgs} timezone={novel?.timezone} highlightId={highlight} />}
          </QueryView>
          <BriefPanel novelId={novelId} view={view} onJumpToMessage={jump} />
        </div>

        {(s.status === "active" || s.status === "paused") && (
          <details className="rounded-[10px] border border-border bg-surface px-4 py-3 text-[13px]">
            <summary className="cursor-pointer font-semibold">진행 방식 바꾸기</summary>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-muted">
                시작 방법
                <Select value={s.entryMode} onChange={(e) => switchMode.mutate(e.target.value as ConceptEntryMode)} disabled={switchMode.isPending}>
                  {ENTRY_MODES.map((m) => (
                    <option key={m} value={m}>
                      {labelKo("concept_entry_mode", m)}
                    </option>
                  ))}
                </Select>
              </label>
              <Button variant="danger" onClick={() => setConfirmRestart(true)}>
                처음부터 다시
              </Button>
              <Badge>질문 세트 {s.questionSetVersion}</Badge>
            </div>
          </details>
        )}
      </div>

      <ConfirmDialog
        open={confirmSubmit}
        title="컨셉 브리프 승인을 요청할까요?"
        description="유사성·연령 등급·실존 인물 점검을 거친 뒤 인박스에 승인 요청이 올라옵니다. 점검 중에는 대화를 이어 갈 수 없습니다."
        confirmLabel="승인 요청"
        busy={cmd.isPending}
        onCancel={() => setConfirmSubmit(false)}
        onConfirm={() => cmd.mutate("submit", { onSettled: () => setConfirmSubmit(false) })}
      />
      <ConfirmDialog
        open={confirmRestart}
        title="처음부터 다시 시작할까요?"
        description="지금 세션은 중단 기록으로 남고 새 세션이 열립니다. 지금까지의 브리프는 이어지지 않습니다."
        danger
        confirmLabel="처음부터 다시"
        busy={abandon.isPending}
        onCancel={() => setConfirmRestart(false)}
        onConfirm={() => abandon.mutate(true, { onSettled: () => setConfirmRestart(false) })}
      />
    </>
  );
}
