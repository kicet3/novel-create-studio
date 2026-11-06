import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { labelKo, type ConceptEntryMode, type NovelDto } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { novelPath } from "../../components/layout/nav.js";
import { Button, Callout, ChoiceGroup, Field, Select, type ChoiceOption } from "../../components/ui/index.js";
import { useCreateNovel } from "./api.js";

const ENTRY: ChoiceOption<ConceptEntryMode>[] = [
  { value: "conversation", label: "대화로 컨셉 잡기", description: "컨셉 파트너가 한두 개씩 질문하며 장르·주인공·결말 방향을 함께 정합니다." },
  { value: "import", label: "기존 컨셉 붙여 넣기", description: "써 둔 기획 메모를 붙여 넣으면 브리프로 정리하고 빈칸만 묻습니다." },
  { value: "direct_input", label: "폼으로 직접 입력", description: "브리프 칸을 직접 채웁니다. 언제든 대화로 바꿀 수 있습니다." },
];

const AGE = ["all", "age_12", "age_15"] as const;

function browserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * POST /api/novels (N1) → 컨셉 화면으로 이동. 제목은 여기서 받지 않습니다(‘제목 미정’으로 시작):
 * 컨셉 대화에서 추천 제목을 고르거나 고쳐서 정합니다.
 */
export function CreateNovelForm({ onCreated, onCancel, compact = false }: { onCreated?: (n: NovelDto) => void; onCancel?: () => void; compact?: boolean }) {
  const [age, setAge] = useState<(typeof AGE)[number]>("age_15");
  const [entry, setEntry] = useState<ConceptEntryMode>("conversation");
  const create = useCreateNovel();
  const navigate = useNavigate();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { ageRating: age, entryMode: entry, timezone: browserTimezone() },
      {
        onSuccess: (n) => {
          if (onCreated) onCreated(n);
          else void navigate(novelPath(n.id, "concept"));
        },
      },
    );
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <p className="m-0 text-[13px] text-muted">제목은 지금 정하지 않아도 됩니다. 컨셉 대화에서 이야기를 잡으면 추천 제목을 드리고, 그중에서 고르거나 고쳐서 정할 수 있습니다.</p>
      <div className="grid grid-cols-1 gap-3 min-[521px]:grid-cols-2">
        <Field label="연령 등급" hint="현재 15세 이용가까지 지원합니다.">
          <Select value={age} onChange={(e) => setAge(e.target.value as (typeof AGE)[number])}>
            {AGE.map((a) => (
              <option key={a} value={a}>
                {labelKo("age_rating", a)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <ChoiceGroup legend="시작 방법" name="entry-mode" value={entry} onChange={setEntry} options={ENTRY} columns={compact ? 1 : 3} />
      {create.error && <Callout tone="danger">{errorMessage(create.error)}</Callout>}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && <Button onClick={onCancel}>취소</Button>}
        <Button type="submit" variant="primary" loading={create.isPending}>
          작품 만들고 컨셉 시작
        </Button>
      </div>
    </form>
  );
}
