import { useState } from "react";
import { ENUMS, labelKo, type NarrationMode, type NovelDto, type QuestionThreshold } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Button, Callout, Card, Checkbox, Field, Input, Select } from "../../../components/ui/index.js";
import { useUpdateNovel } from "../../novels/api.js";

/** 작품 기본 설정 (PATCH /api/novels/:id → novel.settings_changed). */
export function NovelBasicsSection({ novel }: { novel: NovelDto }) {
  const [title, setTitle] = useState(novel.title);
  const [audience, setAudience] = useState(novel.targetAudience ?? "");
  const [threshold, setThreshold] = useState<QuestionThreshold>(novel.questionThreshold);
  const [narration, setNarration] = useState<NarrationMode>(novel.defaultNarrationMode);
  const [timezone, setTimezone] = useState(novel.timezone);
  const [possession, setPossession] = useState(novel.possessionModeEnabled);
  const m = useUpdateNovel(novel.id);

  const patch = {
    ...(title.trim() !== novel.title ? { title: title.trim() } : {}),
    ...((audience.trim() || null) !== novel.targetAudience ? { targetAudience: audience.trim() || null } : {}),
    ...(threshold !== novel.questionThreshold ? { questionThreshold: threshold } : {}),
    ...(narration !== novel.defaultNarrationMode ? { defaultNarrationMode: narration } : {}),
    ...(timezone.trim() !== novel.timezone ? { timezone: timezone.trim() } : {}),
    ...(possession !== novel.possessionModeEnabled ? { possessionModeEnabled: possession } : {}),
  };
  const dirty = Object.keys(patch).length > 0;
  return (
    <Card title="작품 기본 설정">
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 items-start gap-3 min-[521px]:grid-cols-2">
          <Field label="작품명" required error={title.trim() ? undefined : "작품명을 입력하세요."}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="타깃 독자">
            <Input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="예) 20~30대 현판 독자" />
          </Field>
          <Field label="질문 민감도" hint="비차단형 질문 수만 바뀝니다. 차단형 기준은 바꿀 수 없습니다.">
            <Select value={threshold} onChange={(e) => setThreshold(e.target.value as QuestionThreshold)}>
              {(["minimal", "normal", "detailed"] as const).map((v) => (
                <option key={v} value={v}>
                  {labelKo("question_threshold", v)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="기본 서술 시점">
            <Select value={narration} onChange={(e) => setNarration(e.target.value as NarrationMode)}>
              {NARRATION.map((v) => (
                <option key={v} value={v}>
                  {labelKo("narration_mode", v)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="시간대" hint="IANA 이름, 예) Asia/Seoul">
            <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          </Field>
          <div className="min-[521px]:pt-8">
            <Checkbox label="빙의 모드" hint="몸·인격 이름을 따로 관리합니다." checked={possession} onChange={(e) => setPossession(e.target.checked)} />
          </div>
        </div>
        <p className="m-0 text-xs text-faint">
          연령 등급: {labelKo("age_rating", novel.ageRating)} (현재 15세 이용가까지 지원) · 장르: {novel.genre || "컨셉 승인 후 정해집니다"}
        </p>
        {m.error && <Callout tone="danger">{errorMessage(m.error)}</Callout>}
        {m.isSuccess && !dirty && <Callout tone="ok">저장했습니다.</Callout>}
        <div className="flex justify-end">
          <Button variant="primary" disabled={!dirty || !title.trim()} loading={m.isPending} onClick={() => m.mutate(patch)}>
            변경 저장
          </Button>
        </div>
      </div>
    </Card>
  );
}

const NARRATION = ENUMS.narration_mode;
