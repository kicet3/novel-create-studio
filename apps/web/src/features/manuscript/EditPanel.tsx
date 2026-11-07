import { useMemo, useState } from "react";
import { errorMessage, isApiRequestError } from "../../api/client.js";
import { Button, Callout, Textarea } from "../../components/ui/index.js";
import { useSaveHumanEdit, type EpisodeDto } from "./api.js";
import { DiffBody } from "./DiffView.js";
import { diffLines, diffStats } from "./diff.js";

function countChars(s: string) {
  return { withSpaces: Array.from(s).length, withoutSpaces: Array.from(s.replace(/\s/g, "")).length };
}

/**
 * E16 direct edit (FR-MAN-07): saves a new human version on top of the current one.
 * Published episodes are read-only (INV-EP-04) — only an unpublish/retcon path remains.
 */
export function EditPanel({
  novelId,
  episode,
  baseVersionId,
  baseContent,
  onSaved,
}: {
  novelId: string;
  episode: EpisodeDto;
  baseVersionId: string;
  baseContent: string;
  onSaved: (versionId: string) => void;
}) {
  const [text, setText] = useState(baseContent);
  const [preview, setPreview] = useState(false);
  const save = useSaveHumanEdit(novelId, episode.episodeNo);
  const stats = useMemo(() => diffStats(diffLines(baseContent, text)), [baseContent, text]);
  const changed = text !== baseContent;
  const count = countChars(text);
  const readOnly = episode.status === "published";
  const stale = baseVersionId !== episode.currentVersionId;

  if (readOnly) {
    return (
      <Callout tone="info" title="공개된 화는 직접 수정할 수 없습니다">
        공개 취소(외부 미공개 확인) 후 수정하거나, 설정 변경(레트콘) 요청으로 진행하세요.
      </Callout>
    );
  }

  const conflict = isApiRequestError(save.error) && save.error.status === 409;

  return (
    <div className="grid gap-3">
      {stale && (
        <Callout tone="warn" title="현재 버전이 아닌 버전을 보고 있습니다">
          직접 수정은 현재 버전 위에만 저장할 수 있습니다. 버전 목록에서 현재 버전을 고르세요.
        </Callout>
      )}
      <label htmlFor="manuscript-edit" className="sr-only">
        원고 본문 편집
      </label>
      <Textarea
        id="manuscript-edit"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={24}
        disabled={stale || save.isPending}
        className="text-[14.5px] leading-[1.9]"
        lang="ko"
      />
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <span className="tabular">
          공백 포함 {count.withSpaces.toLocaleString("ko-KR")}자 · 공백 제외 {count.withoutSpaces.toLocaleString("ko-KR")}자
        </span>
        {changed && (
          <span className="tabular">
            +{stats.added} / −{stats.removed}줄
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" disabled={!changed} onClick={() => setText(baseContent)}>
            되돌리기
          </Button>
          <Button size="sm" disabled={!changed} onClick={() => setPreview((p) => !p)} aria-expanded={preview}>
            {preview ? "변경 미리보기 닫기" : "변경 미리보기"}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!changed || stale || text.trim().length === 0}
            loading={save.isPending}
            onClick={() => save.mutate({ content: text, baseVersionId }, { onSuccess: (v) => onSaved(v.id) })}
          >
            사람 수정 저장
          </Button>
        </div>
      </div>
      <p className="m-0 text-xs text-muted">
        저장하면 새 버전(사람 수정)이 만들어지고 진행 중인 작업은 멈춘 뒤 다시 검사합니다. 사람 수정은 에이전트가 승인 없이 되돌리지 않습니다.
        {" "}다시 검사할 때 새 본문에서 사실을 다시 추출해 온톨로지를 맞춥니다. 후보 사실은 바로 정리되고, 승인된 설정이 바뀌거나 빠지면 인박스의 설정 변경 승인을 거쳐 반영됩니다.
      </p>
      {save.error && (
        <Callout tone="danger" title={conflict ? "다른 버전이 먼저 저장되었습니다" : "저장하지 못했습니다"}>
          {conflict ? "새로 고친 뒤 최신 버전 위에서 다시 수정하세요. " : ""}
          {errorMessage(save.error)}
        </Callout>
      )}
      {preview && changed && <DiffBody oldText={baseContent} newText={text} mode="unified" full={false} />}
    </div>
  );
}
