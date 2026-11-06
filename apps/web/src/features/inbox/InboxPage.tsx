import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { labelKo, type HitlApprovalDto, type HitlQuestionDto } from "@ncs/shared";
import { useNovelId } from "../../app/novel-context.js";
import { PageHeader } from "../../components/layout/PageHeader.js";
import { novelPath } from "../../components/layout/nav.js";
import { Badge, Button, Checkbox, Dialog, EmptyState, formatRelative, Kbd, QueryView, Split, StatusBadge } from "../../components/ui/index.js";
import { errorMessage } from "../../api/client.js";
import { cx } from "../../lib/cx.js";
import { useNovel } from "../novels/api.js";
import { CLOSED_STATUSES, OPEN_STATUSES, useEntityBacklog, useInboxSummary, usePendingApprovals, useQuestions, useQuestionView, useResolveEntityBacklog } from "./api.js";
import { QuestionDetail, type QuestionDetailHandle } from "./QuestionDetail.js";

interface Group {
  key: string;
  title: string;
  items: HitlQuestionDto[];
}

function groupQuestions(open: HitlQuestionDto[], closed: HitlQuestionDto[]): Group[] {
  const byDeadline = (a: HitlQuestionDto, b: HitlQuestionDto) =>
    (a.deadlineAt ? Date.parse(a.deadlineAt) : Infinity) - (b.deadlineAt ? Date.parse(b.deadlineAt) : Infinity) || a.displayNo - b.displayNo;
  const groups: Group[] = [
    { key: "blocking", title: "대기 · 차단형", items: open.filter((q) => q.grade === "blocking" && q.questionType !== "approve_reject").sort(byDeadline) },
    { key: "approval", title: "승인 요청", items: open.filter((q) => q.questionType === "approve_reject").sort(byDeadline) },
    { key: "non_blocking", title: "비차단형", items: open.filter((q) => q.grade === "non_blocking" && q.questionType !== "approve_reject").sort(byDeadline) },
    { key: "informational", title: "정보성", items: open.filter((q) => q.grade === "informational") },
    { key: "closed", title: "답변 완료", items: [...closed].sort((a, b) => b.displayNo - a.displayNo) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** Text-entry targets disable single-key shortcuts (08 §9.9). */
function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !["radio", "checkbox", "button", "submit", "reset"].includes(el.type);
  return false;
}

/**
 * `/novels/:novelId/inbox[/:questionId]` — 인박스 (08 §9.1·9.9, FR-UI-03, NFR-ACC-01).
 * 키보드: j/k 항목 이동 · 1~9 선택지 · Enter 제출 · a 승인 · r 반려 · ? 도움말. 5초 폴링.
 */
export function InboxPage() {
  const novelId = useNovelId();
  const { questionId } = useParams();
  const navigate = useNavigate();
  const novel = useNovel(novelId);
  const [showClosed, setShowClosed] = useState(false);
  const [help, setHelp] = useState(false);
  const summary = useInboxSummary(novelId);
  const open = useQuestions(novelId, OPEN_STATUSES);
  const closed = useQuestions(novelId, showClosed ? CLOSED_STATUSES : []);
  const approvals = usePendingApprovals(novelId);
  const view = useQuestionView(novelId, questionId);
  const detailRef = useRef<QuestionDetailHandle>(null);
  const tz = novel.data?.timezone;
  // 설계 추가 0015: entity questions the resolver agent can clean up
  const cleanup = useResolveEntityBacklog(novelId);
  const backlog = useEntityBacklog(novelId);
  const resolvable = backlog.data?.openQuestions ?? 0;

  const approvalByQ = useMemo(() => {
    const m = new Map<string, HitlApprovalDto>();
    for (const a of approvals.data?.items ?? []) m.set(a.questionId, a);
    return m;
  }, [approvals.data]);

  const groups = useMemo(
    () => groupQuestions(open.data?.items ?? [], showClosed ? (closed.data?.items ?? []) : []),
    [open.data, closed.data, showClosed],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const select = useCallback(
    (id: string, focusItem = false) => {
      void navigate(novelPath(novelId, `inbox/${id}`), { replace: true });
      if (focusItem) requestAnimationFrame(() => document.getElementById(`q-item-${id}`)?.focus());
    },
    [navigate, novelId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (document.querySelector("dialog[open]")) return;
      if (isTyping(e.target)) return;
      const key = e.key;
      if (key === "?") {
        e.preventDefault();
        setHelp(true);
        return;
      }
      if (key === "j" || key === "k") {
        if (flat.length === 0) return;
        e.preventDefault();
        const idx = flat.findIndex((q) => q.id === questionId);
        const next = key === "j" ? Math.min(flat.length - 1, idx + 1) : Math.max(0, idx < 0 ? 0 : idx - 1);
        const target = flat[next];
        if (target) select(target.id, true);
        return;
      }
      if (key === "Enter" && e.target instanceof HTMLElement && (e.target.closest("button, a") || e.target.getAttribute("role") === "button")) return;
      if (detailRef.current?.handleKey(key)) e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [flat, questionId, select]);

  const s = summary.data;
  return (
    <>
      <PageHeader
        title="인박스"
        subtitle="질문과 승인 요청 · 메신저와 같은 질문을 여기서도 답할 수 있습니다"
        actions={
          <>
            {novel.data && <StatusBadge enum="autonomy_level" value={novel.data.autonomyLevel} />}
            {resolvable > 0 && (
              <Button
                size="sm"
                loading={cleanup.isPending}
                title="열린 엔티티 판별·중복 질문을 판정 에이전트가 문맥으로 판단해 처리합니다. 확신이 낮은 질문은 그대로 남깁니다."
                onClick={() => cleanup.mutate()}
              >
                에이전트가 정리 ({resolvable})
              </Button>
            )}
            <button type="button" className="text-xs text-muted underline" onClick={() => setHelp(true)}>
              단축키 <Kbd>?</Kbd>
            </button>
          </>
        }
      />
      {s && (
        <div className="mb-3 flex flex-wrap items-center gap-2" aria-label="인박스 요약">
          <Badge tone={s.blocking > 0 ? "danger" : "neutral"} glyph>
            차단형 {s.blocking}
          </Badge>
          <Badge tone={s.nonBlocking > 0 ? "warn" : "neutral"} glyph>
            비차단형 {s.nonBlocking}
          </Badge>
          <Badge tone="info" glyph>
            정보성 {s.informational}
          </Badge>
          <Badge tone={s.approvals > 0 ? "warn" : "neutral"} glyph>
            승인 요청 {s.approvals}
          </Badge>
          {s.lateAnswers > 0 && (
            <Badge tone="warn" glyph>
              늦은 답변 {s.lateAnswers}
            </Badge>
          )}
          {s.earliestDeadlineAt && <span className="text-xs text-muted">가장 이른 마감 {formatRelative(s.earliestDeadlineAt)}</span>}
          {(s.agentResolved ?? 0) > 0 && (
            <span className="text-xs text-muted">
              에이전트가 처리한 질문 {s.agentResolved}건(7일) · <Link to={novelPath(novelId, "audit?actionPrefix=question.agent_resolved")}>감사 타임라인 보기</Link>
            </span>
          )}
          {cleanup.isSuccess && <span className="text-xs text-muted">{cleanup.data.created ? "정리 작업을 시작했습니다." : "이미 정리 작업이 진행 중입니다."}</span>}
          {cleanup.error && <span className="text-xs text-danger">{errorMessage(cleanup.error)}</span>}
          <Checkbox className="ml-auto" label="답변 완료 보기" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
        </div>
      )}
      <QueryView query={open} loadingLabel="질문을 불러오는 중…" notReadyDescription="질문·승인 모듈이 준비되면 여기에 표시됩니다.">
        {() => (
          <Split className="min-[861px]:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
            <nav aria-label="질문 목록" className="flex min-w-0 flex-col gap-3">
              {groups.length === 0 ? (
                <EmptyState icon="✓" title="답할 질문이 없습니다" description="에이전트가 질문하거나 승인을 요청하면 여기에 표시됩니다." />
              ) : (
                groups.map((g) => (
                  <section key={g.key} aria-labelledby={`grp-${g.key}`}>
                    <h2 id={`grp-${g.key}`} className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-bold text-muted">
                      {g.title} <span className="tabular">{g.items.length}</span>
                    </h2>
                    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                      {g.items.map((q) => (
                        <li key={q.id}>
                          <QuestionItem novelId={novelId} q={q} active={q.id === questionId} approval={approvalByQ.get(q.id)} />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </nav>
            <div className="min-w-0">
              {!questionId ? (
                <EmptyState
                  icon="?"
                  title="질문을 고르세요"
                  description={
                    <>
                      목록에서 질문을 고르거나 <Kbd>j</Kbd>/<Kbd>k</Kbd>로 이동하세요.
                    </>
                  }
                />
              ) : (
                <QueryView query={view} loadingLabel="질문을 불러오는 중…">
                  {(v) => <QuestionDetail key={v.questionId} ref={detailRef} novelId={novelId} view={v} timezone={tz} />}
                </QueryView>
              )}
            </div>
          </Split>
        )}
      </QueryView>
      <Dialog open={help} onClose={() => setHelp(false)} title="인박스 단축키" description="문자 입력란에 포커스가 있으면 단일 문자 단축키는 꺼집니다.">
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          {[
            [["j", "k"], "다음 / 이전 질문"],
            [["1", "…", "9"], "선택지 고르기"],
            [["Enter"], "답변 제출(확인 단계 있음)"],
            [["Ctrl", "Enter"], "입력란에서 제출"],
            [["a"], "승인"],
            [["r"], "반려 — 다시 할 단계 → 사유 순으로 이동"],
            [["Esc"], "대화 상자 닫기"],
            [["?"], "이 도움말"],
          ].map(([keys, desc]) => (
            <div key={String(desc)} className="contents">
              <dt className="flex gap-1">
                {(keys as string[]).map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dt>
              <dd className="m-0">{desc as string}</dd>
            </div>
          ))}
        </dl>
      </Dialog>
    </>
  );
}

function QuestionItem({ novelId, q, active, approval }: { novelId: string; q: HitlQuestionDto; active: boolean; approval?: HitlApprovalDto }) {
  return (
    <Link
      id={`q-item-${q.id}`}
      to={novelPath(novelId, `inbox/${q.id}`)}
      replace
      aria-current={active ? "true" : undefined}
      className={cx(
        "block rounded-lg border px-3 py-2 text-[13px] text-text no-underline",
        active ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-surface-2",
        q.grade === "blocking" && "border-l-[3px] border-l-danger",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <b className="tabular text-xs text-muted">Q-{q.displayNo}</b>
        <StatusBadge enum="question_grade" value={q.grade} />
        {approval && <Badge tone="accent">{labelKo("approval_type", approval.approvalType)}</Badge>}
        {q.status === "pending" && <Badge>발송 대기</Badge>}
        {CLOSED_STATUSES.includes(q.status) && <StatusBadge enum="question_status" value={q.status} />}
      </div>
      <div className="mt-0.5 font-semibold">{q.title}</div>
      <div className="text-xs text-muted">
        {labelKo("question_type", q.questionType)}
        {q.deadlineAt && ` · 마감 ${formatRelative(q.deadlineAt)}`}
      </div>
    </Link>
  );
}
