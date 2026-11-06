import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { labelKo, type ConceptMessageDto, type ConceptSessionViewDto } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { Avatar, Badge, Button, Callout, Field, formatDateTime, Kbd, Spinner, Textarea } from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { usePostConceptMessage } from "./api.js";
import { fieldLabel } from "./brief-fields.js";

const AUTHOR_INITIAL = { user: "나", agent: "C", system: "S" } as const;

/** 왼쪽 대화 (11 §4.1): 메시지 기록(aria-live), 선택지 버튼, 입력창(Enter 전송 · Shift+Enter 줄바꿈). */
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
  const [draft, setDraft] = useState("");
  const [importMode, setImportMode] = useState(s.entryMode === "import" && s.userMessageCount === 0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const lastSeq = messages[messages.length - 1]?.seq;
  const thinking = s.inFlightTaskId !== null;
  const canTalk = s.status === "active";

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastSeq, thinking]);

  const lastAgent = [...messages].reverse().find((m) => m.authorKind === "agent" && !m.isSuperseded);
  const pickable = canTalk && lastAgent && lastAgent.seq === lastSeq ? lastAgent : null;

  const send = () => {
    const body = draft.trim();
    if (!body || post.isPending) return;
    post.mutate({ body, kind: importMode ? "import_text" : "text" }, { onSuccess: () => { setDraft(""); setImportMode(false); } });
  };

  const pick = (m: ConceptMessageDto, o: NonNullable<ConceptMessageDto["options"]>[number]) => {
    if (o.source === "control" && o.idx === 900) {
      inputRef.current?.focus();
      return;
    }
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
        {thinking && (
          <p role="status" className="m-0 flex items-center gap-2 text-[13px] text-muted">
            <Spinner /> 컨셉 파트너가 답을 쓰는 중…
          </p>
        )}
      </div>
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={() => setImportMode((v) => !v)} aria-pressed={importMode}>
                {importMode ? "일반 메시지로" : "붙여 넣기"}
              </Button>
              <Button type="submit" variant="primary" loading={post.isPending} disabled={!draft.trim()}>
                보내기
              </Button>
            </div>
          </form>
        )}
      </div>
    </section>
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
