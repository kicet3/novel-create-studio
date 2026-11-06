import { useState } from "react";
import { ENUMS, labelKo, type ReworkFrom } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { Button, Callout, Checkbox, ChoiceGroup, ConfirmDialog, Dialog, Field, Textarea } from "../../components/ui/index.js";
import { usePublish, useRevisionRequest, useUnpublish, type EpisodeDto } from "./api.js";

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
