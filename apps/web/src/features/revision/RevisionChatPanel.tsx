import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { labelKo, type RevisionChatView, type RevisionMessageDto, type RevisionProposalDto } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { Avatar, Badge, Button, Callout, Checkbox, Field, Input, Kbd, Select, Spinner, Textarea, formatDateTime } from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { atBottom } from "../concept/chat-scroll.js";
import { showLiveReply, useReplyStream } from "../concept/reply-stream.js";
import { diffChars } from "../manuscript/diff.js";
import {
  revisionChatKey,
  revisionStreamPath,
  useCloseRevisionChat,
  useDecideRevisionProposal,
  usePostRevisionMessage,
  useRevisionChat,
  useRewriteFromChat,
  useStopRevisionTurn,
} from "./api.js";
import { anchorFromRange, clipQuote, selectionOffsets, type PassageAnchor } from "./selection.js";

const INITIAL = { user: "나", agent: "편", system: "S" } as const;

/**
 * 화별 수정 대화 (설계 추가 0018): 왼쪽 본문에서 구간을 고르면 [이 부분 묻기], 오른쪽에서 편집자와 여러 턴 대화합니다.
 * 제안(본문 수정·설정 변경·영향 범위)은 하나씩 [적용]/[거절]합니다. 한 번에 한 턴만(답 쓰는 중에는 보내기 잠금).
 */
export function RevisionChat({ novelId, episodeNo, content, timezone }: { novelId: string; episodeNo: number; content: { versionId: string; text: string } | null; timezone?: string }) {
  const chat = useRevisionChat(novelId, episodeNo);
  const [anchor, setAnchor] = useState<PassageAnchor | null>(null);
  const [pending, setPending] = useState<PassageAnchor | null>(null);
  const textRef = useRef<HTMLDivElement>(null);

  const capture = () => {
    if (!content || !textRef.current) return;
    const off = selectionOffsets(textRef.current, window.getSelection());
    setPending(off ? anchorFromRange(content.text, content.versionId, off.start, off.end) : null);
  };

  if (chat.error) return <Callout tone="danger">{errorMessage(chat.error)}</Callout>;
  if (!chat.data) return <p className="m-0 flex items-center gap-2 text-[13px] text-muted"><Spinner /> 수정 대화를 불러오는 중…</p>;
  const view = chat.data;

  return (
    <div className="grid grid-cols-1 gap-3 min-[1300px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section aria-label="본문" className="min-w-0 rounded-[10px] border border-border bg-surface shadow-card">
        <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-[12.5px]">
          {pending ? (
            <>
              <span className="min-w-0 flex-1 truncate text-muted">“{clipQuote(pending.quote, 60)}”</span>
              <Button
                size="sm"
                variant="primary"
                disabled={!view.canChat}
                onClick={() => {
                  setAnchor(pending);
                  setPending(null);
                  window.getSelection()?.removeAllRanges();
                }}
              >
                이 부분 묻기
              </Button>
            </>
          ) : (
            <span className="text-faint">이상한 부분을 드래그해 고르면 [이 부분 묻기]가 나옵니다.</span>
          )}
        </div>
        {content ? (
          <div ref={textRef} onMouseUp={capture} onKeyUp={capture} className="max-h-[70dvh] overflow-y-auto whitespace-pre-wrap px-4 py-3 text-[14.5px] leading-[1.85]" data-testid="revision-text">
            {content.text}
          </div>
        ) : (
          <p className="m-0 p-4 text-[13px] text-muted">아직 원고가 없습니다.</p>
        )}
      </section>
      <ChatColumn novelId={novelId} episodeNo={episodeNo} view={view} anchor={anchor} clearAnchor={() => setAnchor(null)} timezone={timezone} />
    </div>
  );
}

function ChatColumn({ novelId, episodeNo, view, anchor, clearAnchor, timezone }: { novelId: string; episodeNo: number; view: RevisionChatView; anchor: PassageAnchor | null; clearAnchor: () => void; timezone?: string }) {
  const post = usePostRevisionMessage(novelId, episodeNo);
  const stop = useStopRevisionTurn(novelId, episodeNo);
  const taskId = view.turn?.taskId ?? null;
  const live = useReplyStream(revisionStreamPath(novelId, episodeNo), taskId, revisionChatKey(novelId, episodeNo));
  const [draft, setDraft] = useState("");
  const [panel, setPanel] = useState<"none" | "close" | "rewrite">("none");
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messages = view.messages;
  const ids = useMemo(() => new Set(messages.map((m) => m.id)), [messages]);
  const thinking = !!view.turn;
  const liveVisible = showLiveReply(live, ids, thinking);
  const busy = thinking || post.isPending || live.phase === "streaming" || liveVisible;
  const lastSeq = messages[messages.length - 1]?.seq;
  const proposalsBy = useMemo(() => {
    const m = new Map<string, RevisionProposalDto[]>();
    for (const p of view.proposals) m.set(p.messageId, [...(m.get(p.messageId) ?? []), p]);
    return m;
  }, [view.proposals]);

  // scroll pinning (same as the concept chat): follow only while the reader is at the bottom
  const pinned = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const toBottom = () => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinned.current = true;
    setUnseen(false);
  };
  const onScroll = () => {
    const el = logRef.current;
    if (!el) return;
    pinned.current = atBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
    if (pinned.current) setUnseen(false);
  };
  useEffect(() => {
    if (pinned.current) toBottom();
    else setUnseen(true);
  }, [lastSeq, thinking, live.text, liveVisible, view.proposals.length]);
  useEffect(() => {
    if (anchor) inputRef.current?.focus({ preventScroll: true });
  }, [anchor]);

  const send = (text = draft) => {
    const body = text.trim();
    if (!body || busy || !view.canChat) return;
    post.mutate(
      { body, ...(anchor ? { anchor } : {}) },
      {
        onSuccess: () => {
          setDraft("");
          clearAnchor();
          toBottom();
        },
      },
    );
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const lastAgent = [...messages].reverse().find((m) => m.authorKind === "agent");
  const canPick = !busy && view.canChat && lastAgent && lastAgent.seq === lastSeq;

  return (
    <section aria-labelledby="revision-chat-title" className="flex min-h-[420px] min-w-0 flex-col self-start rounded-[10px] border border-border bg-surface shadow-card min-[1300px]:sticky min-[1300px]:top-4 min-[1300px]:max-h-[calc(100dvh-2rem)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <h2 id="revision-chat-title" className="m-0 text-[13.5px] font-bold">
          {view.episode.episodeNo}화 수정 대화
        </h2>
        {view.session && <Badge tone={view.session.status === "active" ? "accent" : "neutral"}>{view.session.outcome ? labelKo("revision_chat_outcome", view.session.outcome) : labelKo("revision_chat_session_status", view.session.status)}</Badge>}
      </div>
      {view.notice && <p className="m-0 border-b border-border bg-warn-soft px-4 py-1.5 text-[12.5px] text-warn">{view.notice}</p>}
      <div ref={logRef} onScroll={onScroll} role="log" aria-live="polite" aria-label="수정 대화 기록" tabIndex={0} className="flex max-h-[60dvh] min-h-[260px] flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 min-[1300px]:max-h-none min-[1300px]:min-h-0">
        {messages.length === 0 && (
          <p className="m-0 text-[13px] text-muted">이상한 부분을 고르거나 자유롭게 물어보세요. 예: “왜 여기서 서린이 먼저 말을 걸어?”, “이 설정이 앞 화와 다른 것 같아.”</p>
        )}
        {messages.map((m) => (
          <Bubble
            key={m.id}
            m={m}
            timezone={timezone}
            proposals={proposalsBy.get(m.id) ?? []}
            novelId={novelId}
            episodeNo={episodeNo}
            view={view}
            onPick={canPick && lastAgent?.id === m.id ? (o) => send(o) : undefined}
          />
        ))}
        {liveVisible && (
          <div className="flex gap-2" aria-hidden="true">
            <Avatar initials={INITIAL.agent} />
            <div className="max-w-[85%] whitespace-pre-wrap rounded-[10px] bg-surface-2 px-3 py-2 text-[13.5px] leading-relaxed">{live.text}</div>
          </div>
        )}
        {thinking && !liveVisible && (
          <p className="m-0 flex items-center gap-2 text-[13px] text-muted">
            <Spinner /> {view.turn?.waitingReason ?? "답 쓰는 중…"}
          </p>
        )}
      </div>
      {unseen && (
        <div className="relative">
          <Button size="sm" className="absolute -top-10 left-1/2 -translate-x-1/2 shadow-card" onClick={toBottom}>
            새 메시지 ↓
          </Button>
        </div>
      )}
      <p role="status" className="sr-only">
        {thinking ? "편집자가 답을 쓰고 있습니다." : ""}
      </p>
      <div className="border-t border-border p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="flex flex-col gap-2"
        >
          {anchor && (
            <div className="flex items-center gap-2 rounded-md bg-accent-soft px-2 py-1 text-[12.5px] text-accent">
              <span className="min-w-0 flex-1 truncate">고른 부분: “{clipQuote(anchor.quote, 70)}”</span>
              <button type="button" className="font-semibold" onClick={clearAnchor} aria-label="고른 부분 지우기">
                ×
              </button>
            </div>
          )}
          <Field
            label="메시지"
            hint={
              busy ? (
                <>답 쓰는 중… 입력은 계속할 수 있고, 답이 끝나면 보낼 수 있습니다.</>
              ) : (
                <>
                  <Kbd>Enter</Kbd> 전송 · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> 줄바꿈
                </>
              )
            }
          >
            <Textarea ref={inputRef} rows={2} value={draft} disabled={!view.canChat} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} placeholder={anchor ? "이 부분이 왜 이렇게 됐는지, 어떻게 바꾸고 싶은지 적어 주세요" : "궁금한 점이나 고치고 싶은 방향을 적어 주세요"} />
          </Field>
          {post.error && <Callout tone="danger">{errorMessage(post.error)}</Callout>}
          {stop.error && <Callout tone="danger">{errorMessage(stop.error)}</Callout>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="ghost" disabled={!view.session || busy} aria-pressed={panel === "close"} onClick={() => setPanel(panel === "close" ? "none" : "close")}>
                고치지 않고 끝내기
              </Button>
              <Button size="sm" variant="ghost" disabled={!["approved", "awaiting_approval"].includes(view.episode.status)} aria-pressed={panel === "rewrite"} onClick={() => setPanel(panel === "rewrite" ? "none" : "rewrite")}>
                전체 다시 쓰기
              </Button>
            </div>
            <div className="flex items-center gap-2">
              {thinking && (
                <Button variant="ghost" size="sm" loading={stop.isPending} onClick={() => stop.mutate()}>
                  답변 멈추기
                </Button>
              )}
              <Button type="submit" variant="primary" loading={post.isPending} disabled={!draft.trim() || busy || !view.canChat}>
                {busy && !post.isPending ? "답 쓰는 중…" : "보내기"}
              </Button>
            </div>
          </div>
        </form>
        {panel === "close" && <ClosePanel novelId={novelId} episodeNo={episodeNo} changed={view.session?.outcome === "patched" || view.session?.outcome === "setting_changed"} onDone={() => setPanel("none")} />}
        {panel === "rewrite" && <RewritePanel novelId={novelId} episodeNo={episodeNo} onDone={() => setPanel("none")} />}
      </div>
    </section>
  );
}

function Bubble({
  m,
  timezone,
  proposals,
  novelId,
  episodeNo,
  view,
  onPick,
}: {
  m: RevisionMessageDto;
  timezone?: string;
  proposals: RevisionProposalDto[];
  novelId: string;
  episodeNo: number;
  view: RevisionChatView;
  onPick?: (option: string) => void;
}) {
  const mine = m.authorKind === "user";
  if (m.authorKind === "system") return <p className="m-0 text-center text-[12px] text-faint">{m.body}</p>;
  return (
    <div className={cx("flex gap-2", mine && "flex-row-reverse")}>
      <Avatar initials={INITIAL[m.authorKind]} label={labelKo("revision_chat_author", m.authorKind)} />
      <div className={cx("flex min-w-0 max-w-[88%] flex-col gap-1.5", mine && "items-end")}>
        <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
          <span className="font-semibold text-muted">{labelKo("revision_chat_author", m.authorKind)}</span> · {formatDateTime(m.createdAt, timezone)}
          {m.diagnosisKind && <Badge tone={m.diagnosisKind === "explanation_only" ? "neutral" : m.diagnosisKind === "style" ? "info" : "warn"}>{labelKo("revision_diagnosis_kind", m.diagnosisKind)}</Badge>}
        </div>
        {m.anchor && <blockquote className="m-0 border-l-2 border-accent pl-2 text-[12.5px] text-muted">“{clipQuote(m.anchor.quote, 160)}”</blockquote>}
        <div className={cx("whitespace-pre-wrap rounded-[10px] px-3 py-2 text-[13.5px] leading-relaxed", mine ? "bg-accent-soft" : "bg-surface-2")}>{m.body}</div>
        {m.sources && m.sources.length > 0 && (
          <ul className="m-0 flex list-none flex-wrap gap-1 p-0 text-[11.5px]" aria-label="근거">
            {m.sources.map((s, i) => (
              <li key={i}>
                <Badge tone={s.kind === "none" ? "warn" : "neutral"} title={s.quote ?? undefined}>
                  {SOURCE_LABEL[s.kind] ?? s.kind}
                  {s.quote ? `: ${clipQuote(s.quote, 24)}` : ""}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {m.question && (
          <div className="flex flex-col gap-1">
            <p className="m-0 text-[13px] font-semibold">{m.question.text}</p>
            {m.question.options.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {m.question.options.map((o) => (
                  <Button key={o} size="sm" disabled={!onPick} onClick={() => onPick?.(o)}>
                    {o}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
        {proposals.map((p) => (
          <ProposalCard key={p.id} p={p} novelId={novelId} episodeNo={episodeNo} view={view} />
        ))}
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  outline: "아웃라인",
  plan: "화 계획",
  fact: "설정 사실",
  setup: "떡밥",
  cast: "캐스트",
  world: "세계관",
  prompt_input: "생성 입력",
  previous_episode: "이전 화",
  author_note: "작가 메모",
  none: "근거 없음",
};

function statusTone(s: RevisionProposalDto["status"]) {
  return s === "accepted" || s === "applied" ? "ok" : s === "stale" || s === "awaiting_approval" ? "warn" : s === "rejected" ? "neutral" : "accent";
}

function ProposalCard({ p, novelId, episodeNo, view }: { p: RevisionProposalDto; novelId: string; episodeNo: number; view: RevisionChatView }) {
  const decide = useDecideRevisionProposal(novelId, episodeNo);
  const patches = ((p.payload.patches as Array<{ quote: string; replacement: string; reason: string }> | undefined) ?? []).map((x, i) => ({ ...x, i }));
  const [selected, setSelected] = useState<Set<number>>(() => new Set(patches.map((x) => x.i)));
  const pending = p.status === "pending";
  const header = (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
      <span className="font-semibold">{labelKo("revision_proposal_kind", p.kind)}</span>
      <Badge tone={statusTone(p.status)}>{labelKo("revision_proposal_status", p.status)}</Badge>
    </div>
  );
  const actions = pending && (
    <div className="flex flex-wrap items-center gap-2">
      {p.kind !== "impact_note" ? (
        <Button
          size="sm"
          variant="primary"
          loading={decide.isPending}
          disabled={(p.kind === "text_patch" && (!selected.size || !view.canPatch))}
          onClick={() => decide.mutate({ id: p.id, decision: "accepted", ...(p.kind === "text_patch" ? { patchIdx: [...selected] } : {}) })}
        >
          적용
        </Button>
      ) : (
        <Button size="sm" loading={decide.isPending} onClick={() => decide.mutate({ id: p.id, decision: "accepted" })}>
          확인
        </Button>
      )}
      {p.kind !== "impact_note" && (
        <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, decision: "rejected" })}>
          거절
        </Button>
      )}
      {decide.error && <span className="text-[12px] text-danger">{errorMessage(decide.error)}</span>}
    </div>
  );
  return (
    <div className="flex w-full flex-col gap-2 rounded-[10px] border border-border bg-surface px-3 py-2" data-testid={`proposal-${p.kind}`}>
      {header}
      {p.kind === "text_patch" && (
        <>
          {patches.map((x) => (
            <div key={x.i} className="flex flex-col gap-1 text-[13px]">
              {patches.length > 1 && pending && (
                <Checkbox
                  label={`수정 ${x.i + 1}`}
                  checked={selected.has(x.i)}
                  onChange={(e) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(x.i);
                      else n.delete(x.i);
                      return n;
                    })
                  }
                />
              )}
              <PatchDiff quote={x.quote} replacement={x.replacement} />
              {x.reason && <p className="m-0 text-[12px] text-muted">{x.reason}</p>}
            </div>
          ))}
          {pending && view.patchWarning && <p className="m-0 text-[12px] text-warn">{view.patchWarning}</p>}
          {p.status === "stale" && <p className="m-0 text-[12px] text-warn">{String(p.payload.staleReason ?? "원고가 바뀌어 적용하지 않았습니다.")} 다시 물어 새 제안을 받으세요.</p>}
          {p.resultVersionId && (
            <Link className="text-[12.5px] underline" to={`/novels/${novelId}/episodes/${episodeNo}?mode=diff&v=${p.resultVersionId}`}>
              바뀐 부분 비교 보기
            </Link>
          )}
        </>
      )}
      {p.kind === "setting_change" && (
        <div className="flex flex-col gap-1 text-[13px]">
          <p className="m-0">
            <span className="text-muted line-through">{String(p.payload.oldValue ?? "")}</span> → <strong>{String(p.payload.newValue ?? "")}</strong>
          </p>
          {typeof p.payload.reason === "string" && p.payload.reason && <p className="m-0 text-[12px] text-muted">{p.payload.reason}</p>}
          {pending && p.payload.needsApproval === true && <p className="m-0 text-[12px] text-warn">승인된 설정이라 적용하면 인박스 승인을 거쳐 바뀝니다. 다른 화 본문은 자동으로 고치지 않습니다.</p>}
          {p.status === "awaiting_approval" && p.approvalId && (
            <Link className="text-[12.5px] underline" to={`/novels/${novelId}/inbox`}>
              인박스에서 승인하기
            </Link>
          )}
        </div>
      )}
      {p.kind === "impact_note" && (
        <div className="flex flex-col gap-1 text-[13px]">
          <p className="m-0 text-muted">같은 설정이 나오는 다른 화입니다. 자동으로 고치지 않으니 필요하면 그 화의 대화를 열어 확인하세요.</p>
          {((p.payload.items as Array<{ episodeNo: number; title: string | null }> | undefined) ?? []).length === 0 ? (
            <p className="m-0 text-[12px] text-faint">다른 화에서 찾지 못했습니다.</p>
          ) : (
            <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
              {((p.payload.items as Array<{ episodeNo: number; title: string | null }>) ?? []).map((it) => (
                <li key={it.episodeNo}>
                  <Link className="text-[12.5px] underline" to={`/novels/${novelId}/episodes/${it.episodeNo}?mode=chat`}>
                    {it.episodeNo}화{it.title ? ` ${it.title}` : ""} 대화 열기
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {actions}
    </div>
  );
}

function PatchDiff({ quote, replacement }: { quote: string; replacement: string }) {
  const segs = useMemo(() => diffChars(quote, replacement), [quote, replacement]);
  return (
    <div className="whitespace-pre-wrap rounded-md bg-surface-2 px-2 py-1.5 text-[13px] leading-relaxed">
      {segs.map((s, i) =>
        s.op === "equal" ? (
          <span key={i}>{s.text}</span>
        ) : s.op === "delete" ? (
          <del key={i} className="bg-danger-soft text-danger">
            {s.text}
          </del>
        ) : (
          <ins key={i} className="bg-ok-soft text-ok no-underline">
            {s.text}
          </ins>
        ),
      )}
    </div>
  );
}

function ClosePanel({ novelId, episodeNo, changed, onDone }: { novelId: string; episodeNo: number; changed: boolean; onDone: () => void }) {
  const close = useCloseRevisionChat(novelId, episodeNo);
  // after a patch / setting change the passage was not "kept as intended": no note by default, and it needs explicit text
  const [saveNote, setSaveNote] = useState(!changed);
  const [note, setNote] = useState("");
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-border p-2">
      <Checkbox label="작가 메모로 남기기 (작가 확인: 의도대로 둠)" hint="뒤 화를 쓸 때 이 메모를 지킵니다." checked={saveNote} onChange={(e) => setSaveNote(e.target.checked)} />
      {saveNote && <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={changed ? "무엇을 의도대로 두는지 적어 주세요" : "무엇을 의도대로 두는지 (비우면 고른 부분을 적습니다)"} maxLength={2000} />}
      {close.error && <Callout tone="danger">{errorMessage(close.error)}</Callout>}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" loading={close.isPending} disabled={changed && saveNote && !note.trim()} onClick={() => close.mutate({ saveNote, ...(note.trim() ? { note: note.trim() } : {}) }, { onSuccess: onDone })}>
          끝내기
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          취소
        </Button>
      </div>
    </div>
  );
}

function RewritePanel({ novelId, episodeNo, onDone }: { novelId: string; episodeNo: number; onDone: () => void }) {
  const rewrite = useRewriteFromChat(novelId, episodeNo);
  const [note, setNote] = useState("");
  const [from, setFrom] = useState<"outline" | "draft" | "polish">("draft");
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-border p-2">
      <p className="m-0 text-[12.5px] text-muted">화 전체를 다시 씁니다(기존 수정 요청·반려 흐름). 대화 내용은 남습니다.</p>
      <Field label="다시 쓸 이유">
        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="예: 서린의 등장을 다음 화로 미루고 긴장감을 높여 주세요" />
      </Field>
      <Field label="어디서부터">
        <Select value={from} onChange={(e) => setFrom(e.target.value as typeof from)}>
          <option value="outline">{labelKo("rework_from", "outline")}</option>
          <option value="draft">{labelKo("rework_from", "draft")}</option>
          <option value="polish">{labelKo("rework_from", "polish")}</option>
        </Select>
      </Field>
      {rewrite.error && <Callout tone="danger">{errorMessage(rewrite.error)}</Callout>}
      <div className="flex gap-2">
        <Button size="sm" variant="danger" loading={rewrite.isPending} disabled={!note.trim()} onClick={() => rewrite.mutate({ decisionNote: note.trim(), reworkFrom: from }, { onSuccess: onDone })}>
          전체 다시 쓰기
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          취소
        </Button>
      </div>
    </div>
  );
}
