import { useState } from "react";
import { ENUMS, labelKo, type ReworkFrom } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { Button, Callout, Checkbox, ChoiceGroup, ConfirmDialog, Dialog, Field, Spinner, Textarea } from "../../components/ui/index.js";
import { useDeleteManuscript, useEpisodeDeletePreview, usePublish, useRevisionRequest, useUnpublish, type EpisodeDeletePreviewDto, type EpisodeDto } from "./api.js";

const REWORK_HINT: Record<string, string> = {
  outline: "아웃라인을 다시 짜고 초고부터 새로 씁니다.",
  draft: "아웃라인은 두고 초고부터 다시 씁니다.",
  polish: "내용은 두고 문장·분량만 다듬습니다.",
};

/** E11: approved (not yet published) → revising with rework_from (FR-HIL-04). */
export function RevisionDialog({ novelId, episode, open, onClose }: { novelId: string; episode: EpisodeDto; open: boolean; onClose: () => void }) {
  const [reworkFrom, setReworkFrom] = useState<ReworkFrom | null>(null);
  const [note, setNote] = useState("");
  const m = useRevisionRequest(novelId, episode.episodeNo);
  const close = () => {
    m.reset();
    onClose();
  };
  const valid = !!reworkFrom && note.trim().length > 0;
  return (
    <Dialog
      open={open}
      onClose={close}
      title={`${episode.episodeNo}화 수정 요청`}
      description="승인된 화를 다시 작업합니다. 어디서부터 다시 할지 먼저 고르고 사유를 적으세요."
      footer={
        <>
          <Button onClick={close} disabled={m.isPending}>
            취소
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={m.isPending}
            onClick={() => reworkFrom && m.mutate({ reworkFrom, decisionNote: note.trim() }, { onSuccess: close })}
          >
            수정 요청
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <ChoiceGroup
          legend="다시 시작할 단계"
          name="rework-from"
          value={reworkFrom}
          onChange={setReworkFrom}
          columns={1}
          options={ENUMS.rework_from.map((v) => ({ value: v, label: labelKo("rework_from", v), description: REWORK_HINT[v] }))}
        />
        <Field label="사유" required hint="작가 에이전트에게 그대로 전달됩니다.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} maxLength={4000} />
        </Field>
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
      </div>
    </Dialog>
  );
}

/** E14: published → approved, with "외부 미공개" confirmation (FR-MAN-03). */
export function UnpublishDialog({ novelId, episode, open, onClose }: { novelId: string; episode: EpisodeDto; open: boolean; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const m = useUnpublish(novelId, episode.episodeNo);
  const close = () => {
    m.reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={`${episode.episodeNo}화 공개 취소`}
      description="공개 기록을 되돌려 승인 상태로 돌아갑니다. 외부 플랫폼에 이미 올린 화라면 취소하지 말고 설정 변경(레트콘)으로 처리하세요."
      footer={
        <>
          <Button onClick={close} disabled={m.isPending}>
            닫기
          </Button>
          <Button
            variant="danger"
            disabled={!confirmed || reason.trim().length === 0}
            loading={m.isPending}
            onClick={() => m.mutate({ reason: reason.trim(), confirmedNotPublishedExternally: true }, { onSuccess: close })}
          >
            공개 취소
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="사유" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={2000} />
        </Field>
        <Checkbox label="이 화를 외부 플랫폼에 올리지 않았음을 확인합니다." checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
      </div>
    </Dialog>
  );
}

/** [화 삭제]: every manuscript version is dropped and the episode returns to `planned`; the server unwinds facts / mentions / issues / beats / recaps. */
export function DeleteManuscriptDialog({ novelId, episode, open, onClose }: { novelId: string; episode: EpisodeDto; open: boolean; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [externalConfirmed, setExternalConfirmed] = useState(false);
  const [rewriteNow, setRewriteNow] = useState(false);
  const published = episode.status === "published";
  const preview = useEpisodeDeletePreview(novelId, episode.episodeNo, open);
  const m = useDeleteManuscript(novelId, episode.episodeNo);
  const close = () => {
    m.reset();
    onClose();
  };
  const valid = reason.trim().length > 0 && (!published || externalConfirmed);
  const submit = () =>
    m.mutate(
      { reason: reason.trim(), holdRewrite: !rewriteNow, ...(published ? { confirmedNotPublishedExternally: true } : {}) },
      // the screen re-renders from the invalidated episode query (now `planned`)
      { onSuccess: close },
    );
  return (
    <Dialog
      open={open}
      onClose={close}
      title={`${episode.episodeNo}화 원고를 삭제할까요?`}
      description="이 화의 모든 원고 버전과 장면, 이 화에서 뽑은 사실(후보는 기각, 승인된 사실은 철회)·언급·관련 이슈·복선 비트·요약·수정 대화가 정리되고 화는 '계획됨'으로 돌아갑니다. 공개된 화였다면 공개 사이트에서도 내려갑니다. 이 화에 진행 중인 작업은 취소되고, 삭제된 화는 멈춤 상태로 남아 다시 시작하기 전까지 쓰지 않습니다."
      footer={
        <>
          <Button onClick={close} disabled={m.isPending}>
            취소
          </Button>
          <Button variant="danger" disabled={!valid} loading={m.isPending} onClick={submit}>
            삭제
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <DeletePreview preview={preview.data} loading={preview.isPending} error={preview.error} />
        <Field label="삭제 사유" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} autoFocus />
        </Field>
        {published && (
          <Checkbox
            label="다른 플랫폼(카카오페이지·네이버 등)에 올린 적이 없음을 확인합니다"
            hint="외부에 이미 올린 화라면 삭제하지 말고 설정 변경(레트콘)으로 처리해 주세요."
            checked={externalConfirmed}
            onChange={(e) => setExternalConfirmed(e.target.checked)}
          />
        )}
        <Checkbox label="삭제 후 바로 다시 쓰기" hint="끄면(기본) 삭제된 화는 멈춤 상태로 남고, 화 화면의 [다시 시작]을 누르기 전까지 쓰지 않습니다." checked={rewriteNow} onChange={(e) => setRewriteNow(e.target.checked)} />
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
      </div>
    </Dialog>
  );
}

/** Compact "what gets cleaned up" counts for the delete dialog; the preview failing does not block the delete. */
function DeletePreview({ preview, loading, error }: { preview: EpisodeDeletePreviewDto | undefined; loading: boolean; error: unknown }) {
  if (preview) {
    const n = (v: number) => v.toLocaleString("ko-KR");
    const rows: Array<[string, string]> = [
      ["원고 버전", n(preview.versionCount)],
      ["사실", `후보 ${n(preview.facts.candidate)} / 승인 ${n(preview.facts.approved)} / 공개확정 ${n(preview.facts.publishedLocked)}`],
      ["언급", n(preview.mentionCount)],
      ["이슈", n(preview.issueCount)],
      ["복선 비트", n(preview.setupBeatCount)],
      ["요약", n(preview.recapCount)],
      ["수정 대화", n(preview.revisionSessionCount)],
      ["진행 중 작업", n(preview.activeTaskCount)],
      ["대기 승인", n(preview.pendingApprovalCount)],
      ["대기 질문", n(preview.pendingQuestionCount)],
    ];
    return (
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs" aria-label="삭제 대상">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-semibold text-muted">{label}</dt>
            <dd className="tabular m-0">{value}</dd>
          </div>
        ))}
        {preview.entityRetireCount > 0 && <p className="col-span-2 m-0 mt-1 text-faint">이 화에서만 등장한 인물·설정 {n(preview.entityRetireCount)}건은 폐기 처리됩니다.</p>}
      </dl>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted">
        <Spinner label="삭제 대상을 세는 중" /> 삭제 대상을 세는 중…
      </div>
    );
  }
  if (error) {
    return (
      <Callout tone="warn" title="삭제 대상을 미리 셀 수 없습니다">
        {errorMessage(error)} — 그래도 삭제는 진행할 수 있습니다.
      </Callout>
    );
  }
  return null;
}

/** E13: approved → published. */
export function PublishDialog({ novelId, episode, open, onClose }: { novelId: string; episode: EpisodeDto; open: boolean; onClose: () => void }) {
  const m = usePublish(novelId, episode.episodeNo);
  return (
    <ConfirmDialog
      open={open}
      title={`${episode.episodeNo}화를 공개로 표시할까요?`}
      description="공개된 화의 사실은 확정 캐논(published_locked)이 되어 이후 수정에 승인이 필요합니다."
      confirmLabel="공개"
      busy={m.isPending}
      onCancel={() => {
        m.reset();
        onClose();
      }}
      onConfirm={() => m.mutate(undefined, { onSuccess: onClose })}
    >
      {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
    </ConfirmDialog>
  );
}
