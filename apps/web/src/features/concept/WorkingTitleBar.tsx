import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ConceptSessionViewDto, NovelDto } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { Badge, Button } from "../../components/ui/index.js";
import { Input } from "../../components/ui/Field.js";
import { cx } from "../../lib/cx.js";
import { useChooseTitle, useRefreshTitleSuggestions } from "./api.js";

const SOURCE_BADGE = {
  provisional: { tone: "neutral", text: "제목 미정" },
  auto: { tone: "info", text: "가제 · 미리 보기" },
  user: { tone: "ok", text: "확정" },
} as const;

const HINT = {
  provisional: "이야기를 조금 나누면 컨셉 파트너가 추천 제목을 3~5개 골라 드립니다. 직접 입력해도 됩니다.",
  auto: "아직 정하지 않은 가제입니다. 아래 추천 제목을 고르거나 고쳐서 정하세요.",
  user: "직접 정한 제목입니다. 컨셉 대화가 제목을 바꾸지 않습니다. 브리프를 승인해도 그대로 유지됩니다.",
} as const;

type Suggestions = ConceptSessionViewDto["titleSuggestions"];
const EMPTY: Suggestions = { items: [], generatedAt: null, refreshing: false, error: null, canRefresh: false };

/**
 * 작품 제목 영역 (설계 추가): 새 작품은 제목 없이 시작하고, 컨셉 대화가 추천 제목 3~5개를 올립니다.
 * 추천을 누르면 바로 그 제목으로 정하고(title_source=user), [고쳐 쓰기]·[직접 입력]으로 고친 뒤 저장할 수 있습니다.
 * 고르기 전까지 작품 제목은 가제(미리 보기)입니다. [다른 추천 받기]는 새 추천을 만듭니다.
 */
export function WorkingTitleBar({ novelId, novel, view }: { novelId: string; novel?: NovelDto; view: ConceptSessionViewDto }) {
  const sessionId = view.session.id;
  const choose = useChooseTitle(novelId, sessionId);
  const refresh = useRefreshTitleSuggestions(novelId, sessionId);
  const sug = view.titleSuggestions ?? EMPTY;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const prevGen = useRef(sug.generatedAt);
  const [flash, setFlash] = useState(false);

  // briefly highlight when a new set of suggestions arrives
  useEffect(() => {
    if (prevGen.current !== null && sug.generatedAt && prevGen.current !== sug.generatedAt) {
      setFlash(true);
      const id = window.setTimeout(() => setFlash(false), 2400);
      prevGen.current = sug.generatedAt;
      return () => window.clearTimeout(id);
    }
    prevGen.current = sug.generatedAt;
  }, [sug.generatedAt]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!novel) return null;
  const src = novel.titleSource;
  const badge = SOURCE_BADGE[src];

  const startEdit = (initial: string) => {
    setDraft(initial);
    choose.reset();
    setEditing(true);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = draft.trim();
    if (!t) return;
    choose.mutate(t, { onSuccess: () => setEditing(false) });
  };
  const refreshing = sug.refreshing || refresh.isPending;
  const error = choose.error ?? refresh.error;
  // choosing a title edits the brief, which would withdraw a pending approval request (server refuses it)
  const locked = view.session.status === "awaiting_approval";

  return (
    <section
      aria-label="작품 제목"
      className={cx(
        "rounded-[10px] border bg-surface px-4 py-3 shadow-card transition-colors duration-700 motion-reduce:transition-none",
        flash ? "border-accent bg-accent-soft" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold text-muted">작품 제목</span>
            <Badge tone={badge.tone}>{badge.text}</Badge>
          </div>
          <p className={cx("mt-0.5 truncate text-[17px] font-bold", src === "user" ? "text-text" : "text-faint")} aria-live="polite" title={novel.title}>
            {novel.title}
          </p>
          <p className="mt-0.5 text-[12px] text-muted">{locked ? "승인을 기다리는 중에는 제목을 바꿀 수 없습니다. 승인 요청을 취소하거나 승인한 뒤에 바꾸세요." : HINT[src]}</p>
        </div>
        {!editing && !locked && (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" onClick={() => startEdit(src === "provisional" ? "" : novel.title)}>
              {src === "user" ? "제목 바꾸기" : "직접 입력"}
            </Button>
          </div>
        )}
      </div>

      {editing && (
        <form onSubmit={submit} className="mt-2 flex flex-wrap items-center gap-2">
          <label htmlFor="novel-title-input" className="sr-only">
            작품 제목
          </label>
          <Input
            id="novel-title-input"
            ref={inputRef}
            value={draft}
            maxLength={200}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
            placeholder="원하는 제목을 입력하세요"
            className="min-w-[200px] flex-1"
          />
          <Button type="submit" variant="primary" size="sm" loading={choose.isPending} disabled={!draft.trim()}>
            이 제목으로 저장
          </Button>
          <Button type="button" size="sm" onClick={() => setEditing(false)}>
            취소
          </Button>
        </form>
      )}

      {(sug.items.length > 0 || sug.canRefresh || refreshing) && (
        <div className="mt-3 border-t border-border pt-2.5">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] font-semibold text-muted">추천 제목{sug.items.length ? ` ${sug.items.length}개` : ""}</span>
            <Button size="sm" variant="ghost" loading={refreshing} disabled={locked || (!sug.canRefresh && !refreshing)} onClick={() => refresh.mutate()}>
              {refreshing ? "추천 만드는 중…" : sug.items.length ? "다른 추천 받기" : "추천 받기"}
            </Button>
          </div>
          {sug.items.length > 0 ? (
            <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 min-[521px]:grid-cols-2 min-[1101px]:grid-cols-3" aria-label="추천 제목">
              {sug.items.map((s) => {
                const chosen = src === "user" && s.title === novel.title;
                return (
                  <li key={s.title} className={cx("flex flex-col gap-1 rounded-lg border px-3 py-2", chosen ? "border-ok bg-ok-soft" : "border-border bg-surface-2")}>
                    <button
                      type="button"
                      className="text-left text-[14px] font-bold text-text hover:underline disabled:cursor-default disabled:no-underline"
                      onClick={() => choose.mutate(s.title)}
                      disabled={choose.isPending || chosen || locked}
                      aria-label={`‘${s.title}’(으)로 제목 정하기`}
                    >
                      {s.title}
                    </button>
                    {s.reason && <span className="text-[12px] text-muted">{s.reason}</span>}
                    <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-0.5">
                      {chosen ? (
                        <Badge tone="ok" glyph>
                          선택됨
                        </Badge>
                      ) : locked ? null : (
                        <Button size="sm" variant="primary" loading={choose.isPending && choose.variables === s.title} onClick={() => choose.mutate(s.title)}>
                          이 제목으로
                        </Button>
                      )}
                      {!locked && (
                        <Button size="sm" variant="ghost" onClick={() => startEdit(s.title)}>
                          고쳐 쓰기
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="m-0 text-[12px] text-muted">{refreshing ? "지금까지 나눈 이야기로 제목을 고르고 있습니다." : "지금까지 나눈 이야기로 추천 제목을 받아 볼 수 있습니다."}</p>
          )}
          {sug.error && !refreshing && <p className="mt-1.5 text-[12px] text-danger">{sug.error}</p>}
        </div>
      )}
      {error && <p className="mt-1.5 text-[12px] text-danger">{errorMessage(error)}</p>}
    </section>
  );
}
