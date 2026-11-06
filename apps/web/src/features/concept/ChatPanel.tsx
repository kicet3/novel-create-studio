import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { labelKo, type ConceptMessageDto, type ConceptSessionViewDto } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { Avatar, Badge, Button, Callout, Field, formatDateTime, Kbd, Spinner, Textarea } from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { usePostConceptMessage, useStopTurn } from "./api.js";
import { fieldLabel } from "./brief-fields.js";
import { showLiveReply, useConceptReplyStream } from "./reply-stream.js";

const AUTHOR_INITIAL = { user: "나", agent: "C", system: "S" } as const;

/**
 * 왼쪽 대화 (11 §4.1): 메시지 기록(aria-live), 선택지 버튼, 입력창(Enter 전송 · Shift+Enter 줄바꿈).
 * 설계 추가: 답변 작성 중(inFlightTaskId · 전송 대기 · 스트림 진행)에는 보내기·Enter·선택지를 막고(입력은 계속 가능 —
 * 쓰던 초안을 잃지 않게), 답변은 SSE로 실시간 표시합니다. [답변 멈추기]는 진행 중인 턴을 취소합니다.
 */
export function ChatPanel({
  novelId,
  view,
  messages,
  timezone,
  highlightId,
}: {
  novelId: string;
  view: ConceptSessionViewDto;
  messages: ConceptMessageDto[];
  timezone?: string;
  highlightId?: string | null;
}) {
  const s = view.session;
  const post = usePostConceptMessage(novelId, s.id);
  const stop = useStopTurn(novelId, s.id);
  const live = useConceptReplyStream(novelId, s.id, s.inFlightTaskId);
  const [draft, setDraft] = useState("");
  const [importMode, setImportMode] = useState(s.entryMode === "import" && s.userMessageCount === 0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const lastSeq = messages[messages.length - 1]?.seq;
  const thinking = s.inFlightTaskId !== null;
  const canTalk = s.status === "active";
  const messageIds = useMemo(() => new Set(messages.map((m) => m.id)), [messages]);
  const liveVisible = showLiveReply(live, messageIds, thinking);
  /** one turn at a time: no sending while the partner is writing (the server also answers 409 concept_turn_in_flight) */
  const busy = thinking || post.isPending || live.phase === "streaming" || liveVisible;

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    // follow the growing live reply only while the reader is already at the bottom
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120 || !liveVisible) el.scrollTop = el.scrollHeight;
  }, [lastSeq, thinking, live.text, liveVisible]);

  const lastAgent = [...messages].reverse().find((m) => m.authorKind === "agent" && !m.isSuperseded);
  const pickable = canTalk && !busy && lastAgent && lastAgent.seq === lastSeq ? lastAgent : null;

  const send = () => {
    const body = draft.trim();
    if (!body || busy) return;
    post.mutate({ body, kind: importMode ? "import_text" : "text" }, { onSuccess: () => { setDraft(""); setImportMode(false); } });
  };

  const pick = (m: ConceptMessageDto, o: NonNullable<ConceptMessageDto["options"]>[number]) => {
    if (o.source === "control" && o.idx === 900) {
      inputRef.current?.focus();
      return;
    }
    if (busy) return;
    post.mutate({ body: o.label, kind: "option_pick", optionValue: o.value, pickedIdx: o.idx });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !importMode) {
      e.preventDefault();
      send();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  };

  return (
    <section aria-labelledby="chat-title" className="flex min-h-[420px] min-w-0 flex-col self-start rounded-[10px] border border-border bg-surface shadow-card max-[860px]:w-full min-[861px]:sticky min-[861px]:top-4 min-[861px]:max-h-[calc(100dvh-2rem)]">
      <h2 id="chat-title" className="border-b border-border px-4 py-2.5 text-[13.5px] font-bold">
        컨셉 대화
      </h2>
      <div ref={logRef} role="log" aria-live="polite" aria-label="대화 기록" tabIndex={0} className="flex max-h-[60dvh] min-h-[280px] flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 min-[861px]:max-h-none min-[861px]:min-h-0">
        {messages.length === 0 && <p className="m-0 text-[13px] text-muted">컨셉 파트너가 첫 질문을 준비하고 있습니다.</p>}
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} timezone={timezone} highlight={m.id === highlightId} pickable={pickable?.id === m.id && !post.isPending} onPick={(o) => pick(m, o)} />
        ))}
        {liveVisible && <LiveReplyBubble text={live.text} />}
        {thinking && !liveVisible && (
          <p className="m-0 flex items-center gap-2 text-[13px] text-muted">
            <Spinner /> 컨셉 파트너가 답을 쓰는 중…
          </p>
        )}
      </div>
      {/* screen readers: one announcement per turn state, not per token (the final message is read by the log) */}
      <p role="status" className="sr-only">
        {thinking ? "컨셉 파트너가 답변을 작성하고 있습니다. 답변이 끝나면 메시지를 보낼 수 있습니다." : ""}
      </p>
      <div className="border-t border-border p-3">
        {!canTalk ? (
          <p className="m-0 text-[13px] text-muted">세션이 {labelKo("concept_session_status", s.status)} 상태라 메시지를 보낼 수 없습니다.</p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
            className="flex flex-col gap-2"
          >
            <Field
              label={importMode ? "기존 컨셉 붙여 넣기" : "메시지"}
              hint={
                importMode ? (
                  <>
                    써 둔 기획 메모를 그대로 붙여 넣으세요. <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> 전송
                  </>
                ) : busy ? (
                  <>답변 작성 중… 입력은 계속할 수 있고, 답변이 끝나면 보낼 수 있습니다.</>
                ) : (
                  <>
                    <Kbd>Enter</Kbd> 전송 · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> 줄바꿈
                  </>
                )
              }
            >
              <Textarea ref={inputRef} rows={importMode ? 8 : 2} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} placeholder={importMode ? "기획 메모, 시놉시스…" : "답하거나 원하는 방향을 자유롭게 적으세요"} />
            </Field>
            {post.error && <Callout tone="danger">{errorMessage(post.error)}</Callout>}
            {stop.error && <Callout tone="danger">{errorMessage(stop.error)}</Callout>}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={() => setImportMode((v) => !v)} aria-pressed={importMode}>
                {importMode ? "일반 메시지로" : "붙여 넣기"}
              </Button>
              <div className="flex items-center gap-2">
                {thinking && (
                  <Button variant="ghost" loading={stop.isPending} onClick={() => stop.mutate()}>
                    답변 멈추기
                  </Button>
                )}
                <Button type="submit" variant="primary" loading={post.isPending} disabled={!draft.trim() || busy} title={busy && !post.isPending ? "답변 작성 중에는 보낼 수 없습니다." : undefined}>
                  {busy && !post.isPending ? "답변 작성 중…" : "보내기"}
                </Button>
              </div>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

/** the agent's reply while it is being written (display only; replaced by the persisted message) */
function LiveReplyBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-2" aria-hidden="true" data-testid="live-reply">
      <Avatar initials={AUTHOR_INITIAL.agent} />
      <div className="flex min-w-0 max-w-[85%] flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-[11.5px] text-faint">
          <span className="font-semibold text-muted">{labelKo("concept_message_author", "agent")}</span> · <Spinner /> 작성 중…
        </div>
        <div className="whitespace-pre-wrap rounded-[10px] bg-surface-2 px-3 py-2 text-[13.5px] leading-relaxed">
          {text}
          <span className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse bg-muted align-[-0.15em]" />
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  m,
  timezone,
  highlight,
  pickable,
  onPick,
}: {
  m: ConceptMessageDto;
  timezone?: string;
  highlight: boolean;
  pickable: boolean;
  onPick: (o: NonNullable<ConceptMessageDto["options"]>[number]) => void;
}) {
  const mine = m.authorKind === "user";
  const options = m.options ?? [];
  return (
    <div id={`msg-${m.id}`} tabIndex={-1} className={cx("flex gap-2 rounded-lg focus:outline-2 focus:outline-accent", mine && "flex-row-reverse", highlight && "outline-2 outline-warn")}>
      <Avatar initials={AUTHOR_INITIAL[m.authorKind]} className={cx(mine ? "bg-surface-2 text-text" : m.authorKind === "system" ? "bg-faint" : undefined)} />
      <div className={cx("flex min-w-0 max-w-[85%] flex-col gap-1.5", mine && "items-end")}>
        <div className="text-[11.5px] text-faint">
          <span className="font-semibold text-muted">{labelKo("concept_message_author", m.authorKind)}</span> · {formatDateTime(m.createdAt, timezone)}
          {m.kind === "import_text" && <Badge className="ml-1">붙여 넣기</Badge>}
          {m.isSuperseded && <Badge className="ml-1">이전 제안</Badge>}
        </div>
        <div className={cx("whitespace-pre-wrap rounded-[10px] px-3 py-2 text-[13.5px] leading-relaxed", mine ? "bg-accent-soft" : "bg-surface-2", m.kind === "notice" && "border border-dashed border-border bg-transparent text-muted")}>
          {m.kind === "option_pick" && m.pickedIdx !== null ? <b>선택: </b> : null}
          {m.body}
        </div>
        {options.length > 0 && (
          <div role="group" aria-label="선택지" className="flex flex-wrap gap-1.5">
            {options.map((o) => (
              <Button
                key={`${o.idx}-${o.value}`}
                size="sm"
                variant={o.is_recommended ? "primary" : o.source === "control" ? "ghost" : "default"}
                disabled={!pickable}
                aria-pressed={m.pickedIdx === o.idx || undefined}
                title={o.rationale}
                onClick={() => onPick(o)}
              >
                {o.label}
                {o.is_recommended && <span className="sr-only">(추천)</span>}
              </Button>
            ))}
          </div>
        )}
        {m.slotUpdates.length > 0 && (
          <div className="flex flex-wrap gap-1 text-[11.5px] text-muted">
            <span>브리프 반영:</span>
            {m.slotUpdates.map((u, i) => (
              <Badge key={i} tone={u.slot_state === "confirmed" ? "ok" : "violet"}>
                {fieldLabel(u.field_path)} · {labelKo("concept_slot_state", u.slot_state)}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
