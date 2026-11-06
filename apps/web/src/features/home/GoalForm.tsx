import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import type { GoalDto } from "@ncs/shared";
import { errorMessage, isApiRequestError } from "../../api/client.js";
import { Badge, Button, Callout, Card, Field, Input, Textarea } from "../../components/ui/index.js";
import { novelPath } from "../../components/layout/nav.js";
import { useGoal, useSaveGoal } from "../novels/api.js";
import { useCast } from "../cast/api.js";
import { useGoalFormDefaults, type GoalFormDefaults } from "./api.js";

interface FormState {
  totalEpisodesMin: string;
  totalEpisodesMax: string;
  cadenceEpisodesPerWeek: string;
  reserveTargetEpisodes: string;
  endingDirection: string;
  notes: string;
}

type FromBrief = Partial<Record<keyof FormState, boolean>>;

function initial(goal: GoalDto | null, defaults: GoalFormDefaults | null): { state: FormState; fromBrief: FromBrief } {
  if (goal) {
    return {
      state: {
        totalEpisodesMin: String(goal.totalEpisodesMin),
        totalEpisodesMax: goal.totalEpisodesMax === null ? "" : String(goal.totalEpisodesMax),
        cadenceEpisodesPerWeek: String(goal.cadenceEpisodesPerWeek),
        reserveTargetEpisodes: String(goal.reserveTargetEpisodes),
        endingDirection: goal.endingDirection,
        notes: goal.notes ?? "",
      },
      fromBrief: {},
    };
  }
  const fromBrief: FromBrief = {
    totalEpisodesMin: defaults?.totalEpisodesMin != null,
    totalEpisodesMax: defaults?.totalEpisodesMax != null,
    cadenceEpisodesPerWeek: defaults?.cadenceEpisodesPerWeek != null,
    endingDirection: !!defaults?.endingDirection,
  };
  return {
    state: {
      totalEpisodesMin: String(defaults?.totalEpisodesMin ?? 100),
      totalEpisodesMax: defaults?.totalEpisodesMax != null ? String(defaults.totalEpisodesMax) : "",
      cadenceEpisodesPerWeek: String(defaults?.cadenceEpisodesPerWeek ?? 7),
      reserveTargetEpisodes: "5",
      endingDirection: defaults?.endingDirection ?? "",
      notes: "",
    },
    fromBrief,
  };
}

const BriefBadge = () => (
  <Badge tone="violet" glyph>
    컨셉 브리프에서 가져옴
  </Badge>
);

/**
 * 목표 폼 (11 §5.7 M-06~M-08, M-22): 처음 저장하면 N3(onboarding → planning)으로 기획이 시작됩니다.
 * 초기값은 승인된 컨셉 브리프에서 가져오고, 가져온 칸에는 출처 배지를 붙입니다.
 */
export function GoalForm({ novelId, onSaved, title = "연재 목표" }: { novelId: string; onSaved?: (g: GoalDto) => void; title?: string }) {
  const goalQ = useGoal(novelId);
  const goal = goalQ.data ?? null;
  const defaultsQ = useGoalFormDefaults(novelId, goalQ.isSuccess && goal === null);
  const ready = goalQ.isSuccess && (goal !== null || !defaultsQ.isPending);
  const [form, setForm] = useState<FormState | null>(null);
  const [fromBrief, setFromBrief] = useState<FromBrief>({});
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const save = useSaveGoal(novelId);
  const cast = useCast(novelId);
  // the first goal save needs a confirmed cast (server: 422 cast_not_confirmed)
  const castBlocked = !goal && cast.isSuccess && !cast.data.confirmed;

  useEffect(() => {
    if (!ready || form) return;
    const init = initial(goal, defaultsQ.data ?? null);
    setForm(init.state);
    setFromBrief(init.fromBrief);
  }, [ready, form, goal, defaultsQ.data]);

  if (goalQ.isError) {
    return (
      <Card title={title}>
        <Callout tone="danger">{errorMessage(goalQ.error)}</Callout>
      </Card>
    );
  }
  if (!form) {
    return (
      <Card title={title}>
        <p role="status" className="m-0 text-[13px] text-muted">
          목표를 불러오는 중…
        </p>
      </Card>
    );
  }

  const set = (k: keyof FormState) => (v: string) => {
    setForm({ ...form, [k]: v });
    setFromBrief({ ...fromBrief, [k]: false });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (castBlocked) return; // Enter in a field submits even with the button disabled
    const errs: typeof errors = {};
    const int = (k: keyof FormState, min: number, optional = false) => {
      const raw = form[k].trim();
      if (optional && raw === "") return null;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < min) errs[k] = `${min} 이상의 정수를 입력하세요.`;
      return n;
    };
    const min = int("totalEpisodesMin", 1);
    const max = int("totalEpisodesMax", 1, true);
    const cadence = int("cadenceEpisodesPerWeek", 1);
    const reserve = int("reserveTargetEpisodes", 0);
    if (cadence !== null && cadence > 70) errs.cadenceEpisodesPerWeek = "주당 70화 이하로 입력하세요.";
    if (max !== null && min !== null && !errs.totalEpisodesMax && max < min) errs.totalEpisodesMax = "최대 화수는 최소 화수 이상이어야 합니다.";
    if (!form.endingDirection.trim()) errs.endingDirection = "결말 방향을 입력하세요.";
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    save.mutate(
      {
        totalEpisodesMin: min ?? 1,
        totalEpisodesMax: max,
        cadenceEpisodesPerWeek: cadence ?? 1,
        reserveTargetEpisodes: reserve ?? 5,
        endingDirection: form.endingDirection.trim(),
        notes: form.notes.trim() || null,
        expectedRevision: goal?.revision,
      },
      { onSuccess: (g) => onSaved?.(g) },
    );
  };

  const defaults = defaultsQ.data;
  const saveErr = save.error;
  return (
    <Card title={title} actions={goal ? <Badge tone="ok" glyph>저장됨 · 개정 {goal.revision}</Badge> : <Badge tone="warn" glyph>미저장</Badge>}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
        {!goal && (
          <p className="m-0 text-[13px] text-muted">
            목표를 처음 저장하면 작품이 <b>기획 중</b>으로 바뀌고, 기획서(시리즈 바이블) 작성이 시작됩니다.
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 min-[521px]:grid-cols-2">
          <Field label={<>최소 화수 {fromBrief.totalEpisodesMin && <BriefBadge />}</>} required error={errors.totalEpisodesMin}>
            <Input inputMode="numeric" value={form.totalEpisodesMin} onChange={(e) => set("totalEpisodesMin")(e.target.value)} />
          </Field>
          <Field label={<>최대 화수 {fromBrief.totalEpisodesMax && <BriefBadge />}</>} hint="비우면 상한 없음" error={errors.totalEpisodesMax}>
            <Input inputMode="numeric" value={form.totalEpisodesMax} onChange={(e) => set("totalEpisodesMax")(e.target.value)} />
          </Field>
          <Field
            label={<>주당 연재 화수 {fromBrief.cadenceEpisodesPerWeek && <BriefBadge />}</>}
            required
            hint="하루 1화 = 7"
            error={errors.cadenceEpisodesPerWeek}
          >
            <Input inputMode="numeric" value={form.cadenceEpisodesPerWeek} onChange={(e) => set("cadenceEpisodesPerWeek")(e.target.value)} />
          </Field>
          <Field label="비축분 목표(화)" hint="기본 5화" error={errors.reserveTargetEpisodes}>
            <Input inputMode="numeric" value={form.reserveTargetEpisodes} onChange={(e) => set("reserveTargetEpisodes")(e.target.value)} />
          </Field>
        </div>
        <Field label={<>결말 방향 {fromBrief.endingDirection && <BriefBadge />}</>} required error={errors.endingDirection}>
          <Textarea rows={3} value={form.endingDirection} onChange={(e) => set("endingDirection")(e.target.value)} />
        </Field>
        <Field label="메모" hint="기획 에이전트에게 전할 추가 지시(선택)">
          <Textarea rows={2} value={form.notes} onChange={(e) => set("notes")(e.target.value)} />
        </Field>
        {!goal && defaults && (defaults.lengthHint || defaults.suggestMultiTimeline || defaults.suggestPossessionMode) && (
          <Callout tone="info" title="컨셉 브리프의 제안">
            <ul className="m-0 list-disc pl-4">
              {defaults.lengthHint && <li>분량: {defaults.lengthHint} — 설정의 분량 프로필에서 고를 수 있습니다.</li>}
              {defaults.suggestMultiTimeline && <li>회귀 트로프가 있어 다중 시간선을 권합니다(다음 버전에서 제공).</li>}
              {defaults.suggestPossessionMode && <li>빙의 트로프가 있어 빙의 모드를 권합니다. 설정에서 켤 수 있습니다.</li>}
            </ul>
          </Callout>
        )}
        {saveErr && (
          <Callout tone="danger">
            {isApiRequestError(saveErr) && saveErr.code === "concept_not_approved"
              ? "컨셉 브리프가 승인된 뒤에 목표를 저장할 수 있습니다."
              : isApiRequestError(saveErr) && saveErr.code === "cast_not_confirmed"
                ? "캐릭터 설정을 먼저 확정하세요."
                : errorMessage(saveErr)}
          </Callout>
        )}
        {save.isSuccess && !save.data?.pendingEndingChange && <Callout tone="ok">목표를 저장했습니다.</Callout>}
        {save.isSuccess && save.data?.pendingEndingChange && (
          <Callout tone="info" title="결말 방향 변경은 승인 뒤에 반영됩니다">
            다른 항목은 저장했습니다. 결말 방향은{" "}
            <Link to={novelPath(novelId, `inbox/${save.data.pendingEndingChange.questionId}`)}>인박스의 결말 변경 승인</Link>을 승인하면 바뀝니다.
          </Callout>
        )}
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {castBlocked && (
            <p id="goal-cast-hint" className="m-0 text-[13px] text-muted">
              캐릭터 설정을 먼저 확정하세요. <Link to={novelPath(novelId, "cast")}>캐릭터 화면으로</Link>
            </p>
          )}
          <Button type="submit" variant="primary" loading={save.isPending} disabled={castBlocked} aria-describedby={castBlocked ? "goal-cast-hint" : undefined}>
            {goal ? "목표 수정 저장" : "목표 저장하고 기획 시작"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
