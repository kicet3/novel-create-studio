import { useState } from "react";
import { labelKo, type CountBasis, type LengthProfileDto } from "@ncs/shared";
import { errorMessage } from "../../../api/client.js";
import { Button, Callout, Card, Field, Input, QueryView, Select } from "../../../components/ui/index.js";
import { useNovelLengthProfile, useUpdateLengthProfile } from "../api.js";

/** 분량 프로필 (min ≤ max, 글자 수 기준). */
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
  const save = () => {
    const a = Number(min);
    const b = Number(max);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a) return setErr("최소 ≤ 최대인 양의 정수를 입력하세요.");
    setErr(null);
    m.mutate({ minChars: a, maxChars: b, countBasis: basis });
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[13px] text-muted">현재: {p.name}</p>
      <div className="grid grid-cols-1 gap-3 min-[521px]:grid-cols-3">
        <Field label="최소 글자 수">
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
      {(err || m.error) && <Callout tone="danger">{err ?? errorMessage(m.error)}</Callout>}
      {m.isSuccess && <Callout tone="ok">저장했습니다.</Callout>}
      <div className="flex justify-end">
        <Button variant="primary" onClick={save} loading={m.isPending}>
          저장
        </Button>
      </div>
    </div>
  );
}
