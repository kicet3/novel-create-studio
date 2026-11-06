import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { Link } from "react-router";
import { labelKo, type HitlQuestionView, type ReworkFrom } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { novelPath } from "../../components/layout/nav.js";
import {
  Badge,
  Button,
  Callout,
  Card,
  Chip,
  ChoiceGroup,
  ConfirmDialog,
  Field,
  formatDateTime,
  formatRelative,
  Kbd,
  StatusBadge,
  Textarea,
  CHOICE_INPUT,
} from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { approvalOf, useAnswerQuestion, useResolveLateAnswer } from "./api.js";
import { useAutopilot } from "../autopilot/api.js";
import { useNovel } from "../novels/api.js";

/** 설계 추가 0014: "자동 승인 예정 HH:MM" / "자동 승인됨" / "자동 응답" / "사람 확인 필요" (완전 자율) */
function AutoProvenance({ novelId, view, approval, timezone }: { novelId: string; view: HitlQuestionView; approval: ReturnType<typeof approvalOf>; timezone?: string }) {
  const novel = useNovel(novelId);
  const full = novel.data?.autonomyLevel === "full_auto";
  const ap = useAutopilot(novelId, { enabled: full && !!approval && approval.status === "pending" });
  if ((approval as { autoDecided?: boolean } | null)?.autoDecided) return <Badge tone="violet">자동 승인됨</Badge>;
  if (!approval && view.resolutionSource === "auto_answer") return <Badge tone="violet">자동 응답</Badge>;
  if (!approval || approval.status !== "pending" || !full) return null;
  const held = (approval.payload as { autopilot?: { heldReason?: string } } | null)?.autopilot?.heldReason;
  if (held) return <Badge tone="warn" title={held}>사람 확인 필요</Badge>;
  const at = ap.data?.scheduled.find((x) => x.approvalId === approval.id)?.at;
  if (at) return <Badge tone="violet">자동 승인 예정 {formatDateTime(at, timezone)}</Badge>;
  return ap.data?.active && ap.data.waitingHuman.every((w) => w.approvalId !== approval.id) ? <Badge tone="violet">자동 승인 대기</Badge> : null;
}

/** Imperative key handling so the page-level shortcut handler can drive the open question. */
export interface QuestionDetailHandle {
  /** returns true when the key was handled */
  handleKey(key: string): boolean;
}

const REWORK_APPROVALS = new Set(["episode", "arc"]);
const REWORK_OPTIONS = (["outline", "draft", "polish"] as const).map((v) => ({ value: v, label: labelKo("rework_from", v) }));

type Pending =
  | { kind: "answer"; optionIds: string[]; text: string }
  | { kind: "approve"; note: string }
  | { kind: "reject"; note: string; reworkFrom: ReworkFrom | null };

/** approvals reviewed on the 구성 screen */
const STRUCTURE_APPROVALS = new Set(["story_structure", "arc_plan"]);

export const QuestionDetail = forwardRef<QuestionDetailHandle, { novelId: string; view: HitlQuestionView; timezone?: string }>(function QuestionDetail(
  { novelId, view, timezone },
  ref,
) {
  const answer = useAnswerQuestion(novelId);
  const late = useResolveLateAnswer(novelId);
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [rework, setRework] = useState<ReworkFrom | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const rejectRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const optionsRef = useRef<HTMLFieldSetElement>(null);

  const approval = approvalOf(view);
  const isApproval = view.questionType === "approve_reject";
  // arc_plan requested while the plot's new characters were not accepted yet: no "추천안: 승인", point to the cast screen
  const castIncomplete = !!approval && approval.status === "pending" && (approval.payload as { castIncomplete?: boolean } | null)?.castIncomplete === true;
  const isMulti = view.questionType === "multi_choice";
  const answerable = (view.status === "open" || view.status === "pending") && view.grade !== "informational";
  const allowText = view.allowFreeText || view.questionType === "free_text";
  const showRework = !!approval && REWORK_APPROVALS.has(approval.approvalType);

  const toggle = (optionId: string) => {
    setSelected((cur) => (isMulti ? (cur.includes(optionId) ? cur.filter((x) => x !== optionId) : [...cur, optionId]) : [optionId]));
    setFormError(null);
  };

  const startAnswer = () => {
    if (selected.length === 0 && !text.trim()) {
      setFormError("선택지를 고르거나 답을 입력하세요.");
      return;
    }
    setPending({ kind: "answer", optionIds: selected, text: text.trim() });
  };

  const startReject = () => {
    setRejecting(true);
    requestAnimationFrame(() => {
      const first = rejectRef.current?.querySelector<HTMLInputElement>("input[type=radio]");
      (first ?? noteRef.current)?.focus();
    });
  };

  const submitReject = () => {
    if (!note.trim()) {
      setFormError("반려 사유를 입력하세요.");
      noteRef.current?.focus();
      return;
    }
    setPending({ kind: "reject", note: note.trim(), reworkFrom: showRework ? (rework ?? "draft") : null });
  };

  useImperativeHandle(ref, () => ({
    handleKey(key: string) {
      if (!answerable || pending) return false;
      if (!isApproval && /^[1-9]$/.test(key)) {
        const opt = view.options[Number(key) - 1];
        if (!opt) return false;
        toggle(opt.optionId);
        optionsRef.current?.querySelector<HTMLInputElement>(`input[value="${opt.optionId}"]`)?.focus();
        return true;
      }
      if (key === "Enter" && !isApproval) {
        startAnswer();
        return true;
      }
      if (isApproval && key === "a") {
        setPending({ kind: "approve", note: "" });
        return true;
      }
      if (isApproval && key === "r") {
        startReject();
        return true;
      }
      return false;
    },
  }));

  const confirm = () => {
    if (!pending) return;
    const body =
      pending.kind === "answer"
        ? { optionIds: pending.optionIds.length ? pending.optionIds : undefined, text: pending.text || undefined }
        : pending.kind === "approve"
          ? { approval: { decision: "approved" as const, decisionNote: pending.note || undefined } }
          : { approval: { decision: "rejected" as const, decisionNote: pending.note, reworkFrom: pending.reworkFrom ?? undefined } };
    answer.mutate(
      { questionId: view.questionId, status: view.status, body },
      {
        onSuccess: () => {
          setPending(null);
          setRejecting(false);
          setSelected([]);
          setText("");
          setNote("");
        },
        onError: () => setPending(null),
      },
    );
  };

  const optionLabel = (id: string) => view.options.find((o) => o.optionId === id)?.label ?? id;

  return (
    <article aria-labelledby="q-title" className="flex flex-col gap-3">
      <Card>
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <Chip>{view.displayNo}</Chip>
          <StatusBadge enum="question_grade" value={view.grade} />
          <Badge>{labelKo("question_type", view.questionType)}</Badge>
          <Badge tone="neutral">{labelKo("question_topic", view.topic)}</Badge>
          {approval && <Badge tone="accent">{labelKo("approval_type", approval.approvalType as never)} 승인</Badge>}
          <StatusBadge enum="question_status" value={view.status} />
          <AutoProvenance novelId={novelId} view={view} approval={approval} timezone={timezone} />
        </div>
        <h2 id="q-title" tabIndex={-1} className="text-[16px] font-bold focus:outline-none">
          {view.title}
        </h2>
        {view.deadline && (
          <p className="m-0 mt-1 text-xs text-muted">
            마감 {view.deadline.wallClock} ({formatRelative(view.deadline.at)}) · {view.deadline.afterLabel}
          </p>
        )}
        {view.targetLabel && <p className="m-0 mt-1 text-xs text-faint">대상: {view.targetLabel}</p>}
        {approval && STRUCTURE_APPROVALS.has(approval.approvalType) && (
          <p className="m-0 mt-1 text-xs">
            <Link to={novelPath(novelId, "structure")}>구성 화면에서 보기</Link>
            {approval.approvalType === "story_structure" && <span className="text-muted"> — 결말과 1~4부를 펼쳐 보고 고친 뒤 승인할 수 있습니다.</span>}
            {approval.approvalType === "arc_plan" && (
              <>
                {" · "}
                <Link to={novelPath(novelId, "cast")}>캐릭터 화면에서 보기</Link>
              </>
            )}
          </p>
        )}
        {castIncomplete && (
          <Callout tone="warn" title="새 인물을 먼저 확인하세요" className="mt-2">
            이 플롯에 새로 등장하는 인물의 빈 항목을 채우고 캐릭터 화면에서 AI 제안을 수락해야 승인할 수 있습니다. 이미 수락했다면 승인해도 됩니다.
          </Callout>
        )}
        <div className="mt-3 whitespace-pre-wrap text-[13.5px] leading-relaxed">{view.body}</div>
        {view.preview.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {view.preview.map((p, i) => (
              <blockquote key={i} className="m-0 rounded-md border-l-[3px] border-border bg-surface-2 px-3 py-2 text-[13px]">
                <b className="block text-xs text-muted">{p.label}</b>
                <span className="whitespace-pre-wrap">{p.text}</span>
              </blockquote>
            ))}
          </div>
        )}
      </Card>

      {((view.recommendation && !castIncomplete) || view.gradeReason || view.blockingBasisLabel) && (
        <Card title="추천안·근거" headingLevel={3}>
          {view.recommendation && !castIncomplete && (
            <div className="text-[13px]">
              <b>추천안: {view.recommendation.label}</b>
              {view.recommendation.rationale && <p className="m-0 mt-1 text-muted">{view.recommendation.rationale}</p>}
            </div>
          )}
          {(view.gradeReason || view.blockingBasisLabel) && (
            <p className="m-0 mt-2 text-xs text-muted">
              등급 판정 근거: {[view.blockingBasisLabel, view.gradeReason].filter(Boolean).join(" · ")}
            </p>
          )}
        </Card>
      )}

      {answerable && !isApproval && (
        <Card title="답하기" headingLevel={3}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              startAnswer();
            }}
          >
            {view.options.length > 0 && (
              <fieldset ref={optionsRef} className="m-0 border-0 p-0">
                <legend className="mb-1.5 text-[12.5px] font-semibold text-muted">{isMulti ? "선택지 (여러 개 가능)" : "선택지"}</legend>
                <div className="flex flex-col gap-2">
                  {view.options.map((o, i) => {
                    const checked = selected.includes(o.optionId);
                    return (
                      <label
                        key={o.optionId}
                        className={cx(
                          "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                          checked ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-surface-2",
                        )}
                      >
                        <input
                          type={isMulti ? "checkbox" : "radio"}
                          name={`q-${view.questionId}`}
                          value={o.optionId}
                          checked={checked}
                          onChange={() => toggle(o.optionId)}
                          className={CHOICE_INPUT}
                        />
                        <span className="flex-1">
                          {o.label} {o.isRecommended && <Badge tone="accent">추천안</Badge>}
                        </span>
                        {i < 9 && <Kbd>{i + 1}</Kbd>}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}
            {allowText && (
              <Field label={view.options.length > 0 ? "선택지 밖 서술형 답" : "답변"} hint="Ctrl+Enter로 제출 · 서술형 답은 해석 확인 후 반영됩니다.">
                <Textarea
                  rows={3}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setFormError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault();
                      startAnswer();
                    }
                  }}
                />
              </Field>
            )}
            {formError && <Callout tone="danger">{formError}</Callout>}
            {answer.error && <Callout tone="danger">{errorMessage(answer.error)}</Callout>}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {view.options.some((o) => o.isRecommended) && (
                <Button
                  onClick={() => {
                    const rec = view.options.find((o) => o.isRecommended);
                    if (rec) setPending({ kind: "answer", optionIds: [rec.optionId], text: "" });
                  }}
                >
                  추천안으로 답하기
                </Button>
              )}
              <Button type="submit" variant="primary" loading={answer.isPending}>
                답변 제출 <Kbd className="ml-1">Enter</Kbd>
              </Button>
            </div>
          </form>
        </Card>
      )}

      {answerable && isApproval && (
        <Card title="승인 결정" headingLevel={3}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => setPending({ kind: "approve", note: "" })}>
                승인 <Kbd className="ml-1">a</Kbd>
              </Button>
              <Button variant="danger" onClick={startReject} aria-expanded={rejecting}>
                반려 <Kbd className="ml-1">r</Kbd>
              </Button>
            </div>
            {rejecting && (
              <div ref={rejectRef} className="flex flex-col gap-3 rounded-lg border border-border p-3">
                {showRework && (
                  <ChoiceGroup legend="어디부터 다시 할까요?" name={`rework-${view.questionId}`} value={rework} onChange={setRework} options={REWORK_OPTIONS} columns={3} />
                )}
                <Field label="반려 사유" required hint="Ctrl+Enter로 제출">
                  <Textarea
                    ref={noteRef}
                    rows={3}
                    value={note}
                    onChange={(e) => {
                      setNote(e.target.value);
                      setFormError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        submitReject();
                      }
                    }}
                  />
                </Field>
                <div className="flex justify-end gap-2">
                  <Button onClick={() => setRejecting(false)}>취소</Button>
                  <Button variant="danger" onClick={submitReject}>
                    반려 제출
                  </Button>
                </div>
              </div>
            )}
            {formError && <Callout tone="danger">{formError}</Callout>}
            {answer.error && <Callout tone="danger">{errorMessage(answer.error)}</Callout>}
          </div>
        </Card>
      )}

      {answer.data && (
        <Callout tone={answer.data.disposition === "accepted" ? "ok" : "warn"} title={`답변 ${labelKo("answer_disposition", answer.data.disposition)}`}>
          {answer.data.disposition === "accepted"
            ? "답변을 받았습니다. 반영 결과는 아래 ‘답변 반영 기록’에 표시됩니다."
            : answer.data.disposition === "late"
              ? "마감 후 도착한 답변입니다. 반영 여부를 선택해야 할 수 있습니다."
              : "이미 같은 답변이 있습니다."}
        </Callout>
      )}

      {view.answers.length > 0 && (
        <Card title="받은 답변" headingLevel={3}>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
            {view.answers.map((a) => (
              <li key={a.id} className="rounded-md border border-border px-3 py-2">
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  <StatusBadge enum="answer_disposition" value={a.disposition} />
                  {formatDateTime(a.receivedAt, timezone)}
                  {a.lateResolution && <Badge>{labelKo("late_answer_resolution", a.lateResolution)}</Badge>}
                  {a.autoAnswered && <Badge tone="violet">{approval ? "자동 승인" : "자동 응답"}</Badge>}
                </div>
                <div className="mt-1">
                  {a.payload.decision && (
                    <b>
                      {a.payload.decision === "approved" ? "승인" : "반려"}
                      {a.payload.rework_from ? ` · ${labelKo("rework_from", a.payload.rework_from)}` : ""}
                    </b>
                  )}
                  {!a.payload.decision && a.payload.selected_idx.length > 0 && <span>{a.payload.selected_idx.map((i) => optionLabel(String(i))).join(", ")}</span>}
                  {(a.payload.text || a.payload.decision_note) && <p className="m-0 mt-1 whitespace-pre-wrap">“{a.payload.text ?? a.payload.decision_note}”</p>}
                </div>
                {a.disposition === "late" && a.lateResolution === "pending_user_choice" && (
                  <Button size="sm" className="mt-2" loading={late.isPending} onClick={() => late.mutate(a.id)}>
                    늦은 답변 무시
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {late.error && <Callout tone="danger" className="mt-2">{errorMessage(late.error)}</Callout>}
        </Card>
      )}

      {view.reflection && (
        <Card title="답변 반영 기록" headingLevel={3} actions={<StatusBadge enum="reflection_status" value={view.reflection.status} />}>
          {view.reflection.notAppliedReason && <p className="m-0 mb-2 text-[13px] text-muted">반영하지 않은 이유: {view.reflection.notAppliedReason}</p>}
          {view.reflection.items.length === 0 ? (
            <p className="m-0 text-[13px] text-muted">변경 항목이 없습니다.</p>
          ) : (
            <ul className="m-0 list-disc pl-4 text-[13px]">
              {view.reflection.items.map((it, i) => (
                <li key={i}>
                  <Badge>{labelKo("reflection_change_kind", it.changeKind)}</Badge> {it.summary}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {view.grade === "informational" && <p className="m-0 text-xs text-muted">정보성 알림입니다. 답할 필요가 없습니다.</p>}
      <p className="m-0 text-xs text-faint">
        <Link to={novelPath(novelId, "audit")}>감사 타임라인</Link>에서 이 질문의 전체 이력을 볼 수 있습니다.
      </p>

      <ConfirmDialog
        open={pending !== null}
        title={
          pending?.kind === "approve" ? `${view.displayNo}을(를) 승인할까요?` : pending?.kind === "reject" ? `${view.displayNo}을(를) 반려할까요?` : `${view.displayNo}에 답할까요?`
        }
        danger={pending?.kind === "reject"}
        confirmLabel={pending?.kind === "approve" ? "승인" : pending?.kind === "reject" ? "반려" : "제출"}
        busy={answer.isPending}
        onCancel={() => setPending(null)}
        onConfirm={confirm}
      >
        {pending?.kind === "answer" && (
          <div className="text-[13px]">
            {pending.optionIds.length > 0 && <p className="m-0">선택: {pending.optionIds.map(optionLabel).join(", ")}</p>}
            {pending.text && <p className="m-0 mt-1 whitespace-pre-wrap">답변: “{pending.text}”</p>}
          </div>
        )}
        {pending?.kind === "approve" && (
          <Field label="메모(선택)">
            <Textarea rows={2} value={pending.note} onChange={(e) => setPending({ kind: "approve", note: e.target.value })} />
          </Field>
        )}
        {pending?.kind === "reject" && (
          <div className="text-[13px]">
            {pending.reworkFrom && <p className="m-0">다시 할 단계: {labelKo("rework_from", pending.reworkFrom)}</p>}
            <p className="m-0 mt-1 whitespace-pre-wrap">사유: “{pending.note}”</p>
          </div>
        )}
      </ConfirmDialog>
    </article>
  );
});
