import { useState } from "react";
import { EPISODE_HARD_MIN_CHARS, EPISODE_HARD_MIN_MESSAGE, labelKo, type CountBasis, type LengthProfileDto } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Button, Callout, Card, Field, Input, QueryView, Select } from "../../../components/ui/index.js";
import { useNovelLengthProfile, useUpdateLengthProfile } from "../api.js";
import { lengthFormError } from "./length.js";

/** 분량 프로필 (3,000 ≤ min ≤ max, 글자 수 기준). 3,000자는 서버도 강제하는 고정 하한입니다. */
export function LengthProfileSection({ novelId }: { novelId: string }) {
  const q = useNovelLengthProfile(novelId);
  return (
    <Card title="분량 프로필">
      <QueryView query={q} compact>
        {(p) => <LengthForm key={p.id} novelId={novelId} p={p} />}
      </QueryView>
    </Card>
  );
}

function LengthForm({ novelId, p }: { novelId: string; p: LengthProfileDto }) {
  const [min, setMin] = useState(String(p.minChars));
  const [max, setMax] = useState(String(p.maxChars));
  const [basis, setBasis] = useState<CountBasis>(p.countBasis);
  const [err, setErr] = useState<string | null>(null);
  const m = useUpdateLengthProfile(novelId);
  const minLow = min.trim() !== "" && Number.isFinite(Number(min)) && Number(min) < EPISODE_HARD_MIN_CHARS;
  const save = () => {
    const a = Number(min);
    const b = Number(max);
    const e = lengthFormError(a, b);
    if (e) return setErr(e);
    setErr(null);
    m.mutate({ minChars: a, maxChars: b, countBasis: basis });
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[13px] text-muted">현재: {p.name}</p>
      <p className="m-0 text-xs text-muted">기본 5,000~5,500자 · 3,000자는 고정 하한입니다. 최소 분량에 못 미친 초고는 아웃라인을 따라 이어 쓰고, 3,000자 미만인 화는 자동 승인·공개하지 않습니다.</p>
      <div className="grid grid-cols-1 gap-3 min-[521px]:grid-cols-3">
        <Field label="최소 글자 수" error={minLow ? EPISODE_HARD_MIN_MESSAGE : undefined}>
          <Input inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} />
        </Field>
        <Field label="최대 글자 수">
          <Input inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} />
        </Field>
        <Field label="기준">
          <Select value={basis} onChange={(e) => setBasis(e.target.value as CountBasis)}>
            {(["with_spaces", "without_spaces"] as const).map((v) => (
              <option key={v} value={v}>
                {labelKo("count_basis", v)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {((err && !(minLow && err === EPISODE_HARD_MIN_MESSAGE)) || m.error) && <Callout tone="danger">{err ?? errorMessage(m.error)}</Callout>}
      {m.isSuccess && <Callout tone="ok">저장했습니다.</Callout>}
      <div className="flex justify-end">
        <Button variant="primary" onClick={save} loading={m.isPending}>
          저장
        </Button>
      </div>
    </div>
  );
}

