import { useState } from "react";
import { labelKo, type ExportJobDto } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { Button, Callout, ChoiceGroup, Dialog, isUnavailable, NotReady } from "../../components/ui/index.js";
import { exportDownloadUrl, useCreateExport } from "./api.js";

export interface ExportTarget {
  scopeKind: "episode" | "arc" | "novel";
  targetId?: string;
  label: string;
}

/** FR-MAN-04a: TXT / Markdown export of an episode, arc or the whole novel. */
export function ExportDialog({ novelId, target, open, onClose }: { novelId: string; target: ExportTarget; open: boolean; onClose: () => void }) {
  const [format, setFormat] = useState<"txt" | "markdown">("txt");
  const [selection, setSelection] = useState<"default" | "current">("default");
  const [job, setJob] = useState<ExportJobDto | null>(null);
  const create = useCreateExport(novelId);

  const close = () => {
    setJob(null);
    create.reset();
    onClose();
  };

  const submit = () =>
    create.mutate(
      { scopeKind: target.scopeKind, targetId: target.targetId, format, versionSelection: selection },
      { onSuccess: (j) => setJob(j) },
    );

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`내보내기 · ${target.label}`}
      description="공개본(없으면 승인본)을 기본으로 내보냅니다. 현재 작업본을 고르면 승인 전 원고도 포함합니다."
      footer={
        job ? (
          <Button onClick={close}>닫기</Button>
        ) : (
          <>
            <Button onClick={close} disabled={create.isPending}>
              취소
            </Button>
            <Button variant="primary" onClick={submit} loading={create.isPending}>
              내보내기
            </Button>
          </>
        )
      }
    >
      {job ? (
        <ExportResult novelId={novelId} job={job} />
      ) : (
        <div className="grid gap-3">
          <ChoiceGroup
            legend="형식"
            name="export-format"
            value={format}
            onChange={setFormat}
            columns={2}
            options={[
              { value: "txt", label: "TXT", description: "일반 텍스트" },
              { value: "markdown", label: "Markdown", description: "화 제목을 머리글로" },
            ]}
          />
          <ChoiceGroup
            legend="버전"
            name="export-selection"
            value={selection}
            onChange={setSelection}
            columns={2}
            options={[
              { value: "default", label: labelKo("export_version_selection", "default"), description: "공개본 → 승인본" },
              { value: "current", label: labelKo("export_version_selection", "current"), description: "가장 최근 버전" },
            ]}
          />
          {create.error &&
            (isUnavailable(create.error) ? (
              <NotReady compact title="내보내기는 준비 중입니다" />
            ) : (
              <Callout tone="danger" title="내보내지 못했습니다">
                {errorMessage(create.error)}
              </Callout>
            ))}
        </div>
      )}
    </Dialog>
  );
}

/** export-service exclusion reasons → Korean (FR-UI-03: no raw identifiers) */
const EXCLUSION_REASON_KO: Record<string, string> = { not_approved: "미승인", no_current_version: "원고 없음" };

function ExportResult({ novelId, job }: { novelId: string; job: ExportJobDto }) {
  const total = job.items.reduce((n, it) => n + it.char_count_with_spaces, 0);
  if (job.failureReason) {
    return (
      <Callout tone="danger" title="내보내기 실패">
        {job.failureReason}
      </Callout>
    );
  }
  return (
    <div className="grid gap-2 text-[13px]">
      <Callout tone="ok" title={`${job.items.length}화를 묶었습니다`}>
        공백 포함 {total.toLocaleString("ko-KR")}자 · {labelKo("export_format", job.exportFormat)}
      </Callout>
      {job.excluded.length > 0 && (
        <p className="m-0 text-muted">
          제외된 화: {job.excluded.map((e) => `${e.episode_no}화(${EXCLUSION_REASON_KO[e.reason] ?? e.reason})`).join(", ")}
        </p>
      )}
      {job.completedAt || job.storageKey ? (
        <a className="font-semibold text-accent underline" href={exportDownloadUrl(novelId, job.id)} download>
          파일 내려받기
        </a>
      ) : (
        <p className="m-0 text-muted">파일을 만드는 중입니다. 잠시 후 내보내기 목록에서 내려받으세요.</p>
      )}
    </div>
  );
}
