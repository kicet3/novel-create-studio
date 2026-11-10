import { useMemo, useState } from "react";
import { planRetitle, type RetitleItem } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { Badge, Button, Callout, Checkbox, Dialog, StatusBadge, Textarea } from "../../components/ui/index.js";
import { useApplyRetitle, useProposeRetitle, useRetitle } from "./api.js";

/** published 화 the author ticked must be confirmed (readers see the new title) */
export function retitleNeedsConfirm(include: ReadonlySet<number>): boolean {
  return include.size > 0;
}

/**
 * the before → after with the author's choice of published 화: renumbering depends on it (a kept published 화 that
 * does not fit the 묶음 leaves it, and the 묶음 restarts at (1) after it)
 */
export function retitlePreview(
  units: ReadonlyArray<{ title: string; from: number; to: number }>,
  items: readonly RetitleItem[],
  include: ReadonlySet<number>,
): RetitleItem[] {
  return planRetitle(
    units,
    items.map((i) => ({ episodeNo: i.episodeNo, status: i.status, title: i.before })),
    include,
  ) as RetitleItem[];
}

/** summary line of a (recomputed) proposal: how many 화 change / are kept published / already fit */
export function retitleSummary(items: readonly RetitleItem[]): { rename: number; keptPublished: number; unchanged: number } {
  let rename = 0;
  let keptPublished = 0;
  let unchanged = 0;
  for (const i of items) {
    if (i.willRename) rename++;
    else if (i.excluded) keptPublished++;
    else unchanged++;
  }
  return { rename, keptPublished, unchanged };
}

/** published 화 that keep their title while the 묶음 they sat in is renamed (the 묶음 restarts at (1) after them) */
export function retitleSplitWarnings(items: readonly RetitleItem[]): string[] {
  const out: string[] = [];
  for (const i of items) {
    if (!i.excluded) continue;
    const next = items.find((x) => x.episodeNo === i.episodeNo + 1);
    if (next?.willRename && next.unitPartNo === 1 && next.unitTitle) {
      out.push(`${i.episodeNo}화는 공개 제목 「${i.before ?? ""}」을 유지해 묶음에서 빠지고, 「${next.unitTitle}」은 ${next.episodeNo}화부터 (1)로 시작합니다.`);
    } else {
      out.push(`${i.episodeNo}화는 공개 제목 「${i.before ?? ""}」을 유지해 새 묶음에서 빠집니다.`);
    }
  }
  return out;
}

/**
 * 설계 추가 0023: [제목 정리] — the plot's 화 grouped into story episodes (에피소드 묶음) titled "묶음 제목 (1)(2)".
 * The AI proposes (plan_arc retitle); the author sees before → after and applies. Published 화 keep their title unless
 * ticked here (with a confirmation, like a retcon: readers see the change). Applying switches the novel to the
 * story-episode title mode.
 */
export function RetitleDialog({ novelId, arcId, title, onClose }: { novelId: string; arcId: string; title: string; onClose: () => void }) {
  const view = useRetitle(novelId, arcId);
  const propose = useProposeRetitle(novelId);
  const apply = useApplyRetitle(novelId);
  const [include, setInclude] = useState<Set<number>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [redo, setRedo] = useState<string | null>(null);
  const v = view.data;
  const proposal = v?.proposal ?? null;
  const items = useMemo(() => (proposal ? retitlePreview(proposal.units, proposal.items, include) : []), [proposal, include]);
  const sum = retitleSummary(items);
  const warnings = retitleSplitWarnings(items);
  const needsConfirm = retitleNeedsConfirm(include);
  const toggle = (no: number) =>
    setInclude((cur) => {
      const next = new Set(cur);
      if (next.has(no)) next.delete(no);
      else next.add(no);
      return next;
    });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`「${title}」 제목 정리`}
      description="이 플롯의 화를 에피소드 묶음으로 나눠 「묶음 제목 (1)」「묶음 제목 (2)」처럼 제목을 맞춥니다. 적용하기 전에는 아무것도 바뀌지 않습니다."
      footer={false}
    >
      <div className="flex flex-col gap-3 text-[13px]">
        {view.error && <Callout tone="danger">{errorMessage(view.error)}</Callout>}
        {v?.lastError && !v.task && <Callout tone="danger">{v.lastError}</Callout>}
        {!proposal && (
          <div className="flex flex-col gap-2">
            {v?.task ? (
              <p className="m-0 text-muted" role="status">
                AI가 화의 계획·아웃라인을 읽고 묶음을 제안하는 중입니다…
              </p>
            ) : (
              <p className="m-0 text-muted">AI가 각 화의 계획·아웃라인·지금 제목을 읽고, 같은 이야기가 이어지는 화를 묶어 제목을 제안합니다.</p>
            )}
            <div>
              <Button variant="primary" loading={propose.isPending || !!v?.task} disabled={!!v?.task} onClick={() => propose.mutate({ arcId })}>
                제안 만들기
              </Button>
            </div>
            {propose.error && (
              <p className="m-0 text-xs text-danger" role="alert">
                {errorMessage(propose.error)}
              </p>
            )}
          </div>
        )}
        {proposal && (
          <>
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="에피소드 묶음">
              {proposal.units.map((u) => (
                <li key={`${u.from}-${u.to}`}>
                  <Badge tone="info">
                    {u.title} · {u.from === u.to ? `${u.from}화` : `${u.from}~${u.to}화`}
                  </Badge>
                </li>
              ))}
            </ul>
            <ul className="m-0 flex max-h-[50vh] list-none flex-col divide-y divide-border overflow-auto rounded-md border border-border p-0">
              {items.map((i) => (
                <li key={i.episodeNo} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5">
                  <span className="tabular w-10 font-semibold">{i.episodeNo}화</span>
                  <StatusBadge enum="episode_status" value={i.status} />
                  <span className="min-w-0 flex-1 break-words">
                    <span className={i.unchanged || i.excluded ? "" : "text-muted line-through"}>{i.before ?? "(제목 없음)"}</span>
                    {!i.unchanged && (
                      <>
                        {" → "}
                        <b className={i.excluded ? "text-muted" : ""}>{i.after}</b>
                      </>
                    )}
                  </span>
                  {i.unchanged && !i.excluded && <Badge tone="neutral">그대로</Badge>}
                  {i.excluded && <Badge tone="warn">공개 제목 유지</Badge>}
                  {i.published && (i.excluded || include.has(i.episodeNo)) && (
                    <Checkbox label="공개된 화 제목도 바꾸기" checked={include.has(i.episodeNo)} onChange={() => toggle(i.episodeNo)} />
                  )}
                </li>
              ))}
            </ul>
            {warnings.length > 0 && (
              <Callout tone="warn">
                {warnings.map((w) => (
                  <p key={w} className="m-0">
                    {w}
                  </p>
                ))}
              </Callout>
            )}
            <p className="m-0 text-muted">
              바뀌는 화 {sum.rename}개{sum.keptPublished ? ` · 공개되어 제목을 유지하는 화 ${sum.keptPublished}개` : ""}
              {sum.unchanged ? ` · 이미 같은 제목 ${sum.unchanged}개` : ""}. 적용하면 앞으로 이 작품은 에피소드 묶음 제목 방식으로 화를 계획합니다.
            </p>
            {needsConfirm && (
              <Callout tone="warn">
                <Checkbox
                  label="공개된 화의 제목이 바뀌는 것을 확인했습니다"
                  hint="독자에게 이미 보인 제목이 바뀝니다(공개 사이트도 다음 동기화 때 바뀝니다). 리트콘처럼 신중하게 고르세요."
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
              </Callout>
            )}
            {apply.error && (
              <p className="m-0 text-xs text-danger" role="alert">
                {errorMessage(apply.error)}
              </p>
            )}
            {redo !== null && (
              <div className="flex flex-col gap-1.5">
                <Textarea rows={2} maxLength={2000} value={redo} onChange={(e) => setRedo(e.target.value)} placeholder="예: 6~8화는 한 묶음으로, 제목은 더 짧게 해 주세요." autoFocus />
                <div className="flex justify-end gap-2">
                  <Button onClick={() => setRedo(null)}>취소</Button>
                  <Button
                    variant="primary"
                    loading={apply.isPending || propose.isPending}
                    onClick={() =>
                      apply.mutate(
                        { arcId, body: { approvalId: proposal.approvalId, reject: true, note: redo.trim() || "다른 묶음으로 다시 제안해 주세요." } },
                        {
                          onSuccess: () => {
                            setRedo(null);
                            setInclude(new Set());
                            setConfirmed(false);
                            propose.mutate({ arcId, note: redo });
                          },
                        },
                      )
                    }
                  >
                    반려하고 다시 제안
                  </Button>
                </div>
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                loading={apply.isPending}
                onClick={() => apply.mutate({ arcId, body: { approvalId: proposal.approvalId, reject: true } }, { onSuccess: onClose })}
              >
                반려
              </Button>
              {redo === null && <Button onClick={() => setRedo("")}>다시 제안</Button>}
              <Button onClick={onClose}>닫기</Button>
              <Button
                variant="primary"
                loading={apply.isPending}
                disabled={needsConfirm && !confirmed}
                onClick={() =>
                  apply.mutate(
                    { arcId, body: { approvalId: proposal.approvalId, includePublishedEpisodeNos: [...include], confirmPublishedRename: needsConfirm && confirmed } },
                    { onSuccess: onClose },
                  )
                }
              >
                적용
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
