import { useMemo, useState } from "react";
import { labelKo, type ConceptFieldOrigin, type ConceptSessionViewDto, type ConceptSlotState } from "@ncs/shared";
import { errorMessage } from "../../api/client.js";
import { Badge, Button, Callout, Input, Progress, Select, Textarea, toneForStatus, type Tone } from "../../components/ui/index.js";
import { useConfirmFields, useDecideProposal, useEditBrief } from "./api.js";
import { BRIEF_FIELDS, briefValueText, editText, fieldValueText, getBriefValue, isEmptyBriefValue, parseEditValue, type BriefFieldDef } from "./brief-fields.js";

const ORIGIN_TONE: Record<ConceptFieldOrigin, Tone> = {
  user_stated: "accent",
  user_edited: "accent",
  agent_proposed_accepted: "info",
  agent_proposed_modified: "info",
  agent_delegated: "violet",
  template_default: "neutral",
  imported: "warn",
};
const STATE_TONE: Record<ConceptSlotState, Tone> = { empty: "neutral", proposed: "violet", confirmed: "ok", deferred: "neutral" };

interface Row extends BriefFieldDef {
  value: unknown;
  origin?: ConceptFieldOrigin;
  state: ConceptSlotState;
  evidence: string[];
  badge?: { originLabel: string; stateLabel: string };
}

/**
 * 오른쪽 작업 중 브리프 (11 §4.1): 필드별 값, 슬롯 상태, 출처 배지(사용자/제안 채택/위임/템플릿/가져오기),
 * 근거 메시지로 이동, ‘고치기’(user_edited), 변경 제안 수락·거절, 확정.
 */
export function BriefPanel({ novelId, view, onJumpToMessage }: { novelId: string; view: ConceptSessionViewDto; onJumpToMessage: (id: string) => void }) {
  const s = view.session;
  const wb = view.workingBrief;
  const editable = s.status === "active" || s.status === "paused";
  const confirm = useConfirmFields(novelId, s.id);
  const decide = useDecideProposal(novelId, s.id);
  const [showEmpty, setShowEmpty] = useState(false);

  const rows = useMemo<Row[]>(() => {
    const known = new Set(BRIEF_FIELDS.map((f) => f.path));
    const extra: BriefFieldDef[] = Object.keys(wb.field_provenance)
      .filter((p) => !known.has(p))
      .map((p) => ({ path: p, label: p, valueType: "complex", group: "기타" }));
    return [...BRIEF_FIELDS, ...extra].map((f) => {
      const prov = wb.field_provenance[f.path];
      const value = getBriefValue(wb.content, f.path);
      return {
        ...f,
        value,
        origin: prov?.origin,
        state: prov?.slot_state ?? (isEmptyBriefValue(value) ? "empty" : "proposed"),
        evidence: prov?.evidence_message_ids ?? [],
        badge: view.fieldBadges[f.path],
        required: f.required || view.progress.missing.some((m) => m.path === f.path),
      };
    });
  }, [wb, view.fieldBadges, view.progress.missing]);

  const visible = rows.filter((r) => showEmpty || !isEmptyBriefValue(r.value) || r.required);
  const groups = [...new Set(visible.map((r) => r.group))];
  const pendingProposals = wb.change_proposals.filter((p) => p.status === "pending");
  const hasImported = rows.some((r) => r.origin === "imported" && r.state === "proposed");
  const hasDelegated = rows.some((r) => r.origin === "agent_delegated" && r.state === "proposed");
  const { requiredConfirmed, requiredTotal } = view.progress;

  return (
    <aside aria-labelledby="brief-title" className="flex min-w-0 flex-col gap-3 rounded-[10px] border border-border bg-surface px-4 py-3.5 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <h2 id="brief-title" className="text-[13.5px] font-bold">
          {view.session.status === "approved" ? "승인된 브리프" : view.session.status === "active" ? "작업 중 브리프" : "브리프"}
        </h2>
        <Badge tone={view.session.status === "approved" ? "ok" : "info"}>{view.session.status === "active" ? view.stageLabel : view.statusLabel}</Badge>
      </div>
      <div>
        <div className="mb-1 flex justify-between text-xs text-muted">
          <span>필수 항목 확정</span>
          <span className="tabular">
            {requiredConfirmed} / {requiredTotal}
          </span>
        </div>
        <Progress value={requiredConfirmed} max={Math.max(requiredTotal, 1)} tone={requiredConfirmed >= requiredTotal ? "ok" : "accent"} label="필수 항목 확정" valueText={`${requiredConfirmed} / ${requiredTotal}`} />
        {view.nextStep.text && <p className="m-0 mt-1.5 text-xs text-muted">다음: {view.nextStep.text}</p>}
      </div>

      {view.session.status === "active" && view.blockers.length > 0 && (
        <Callout tone="warn" title="승인 요청 전에 해결할 것">
          <ul className="m-0 list-disc pl-4">
            {view.blockers.map((b) => (
              <li key={b.code + b.fieldPaths.join()}>{b.message}</li>
            ))}
          </ul>
        </Callout>
      )}

      {pendingProposals.length > 0 && (
        <section aria-label="에이전트 변경 제안" className="flex flex-col gap-2">
          {pendingProposals.map((p) => (
            <Callout
              key={p.id}
              tone="violet"
              title={`변경 제안: ${BRIEF_FIELDS.find((f) => f.path === p.field_path)?.label ?? p.field_path}`}
              actions={
                <>
                  <Button size="sm" variant="primary" loading={decide.isPending} onClick={() => decide.mutate({ proposalId: p.id, decision: "accepted" })}>
                    수락
                  </Button>
                  <Button size="sm" onClick={() => decide.mutate({ proposalId: p.id, decision: "rejected" })}>
                    거절
                  </Button>
                </>
              }
            >
              <p className="m-0">→ {fieldValueText(BRIEF_FIELDS.find((f) => f.path === p.field_path), p.new_value)}</p>
              {p.reason && <p className="m-0 text-xs text-muted">이유: {p.reason}</p>}
            </Callout>
          ))}
          {decide.error && <Callout tone="danger">{errorMessage(decide.error)}</Callout>}
        </section>
      )}

      {editable && (hasImported || hasDelegated) && (
        <div className="flex flex-wrap gap-2">
          {hasImported && (
            <Button size="sm" loading={confirm.isPending} onClick={() => confirm.mutate({ which: "imported" })}>
              추출값 전체 확인
            </Button>
          )}
          {hasDelegated && (
            <Button size="sm" loading={confirm.isPending} onClick={() => confirm.mutate({ which: "delegated" })}>
              맡긴 값 모두 확정
            </Button>
          )}
        </div>
      )}
      {confirm.error && <Callout tone="danger">{errorMessage(confirm.error)}</Callout>}

      {groups.map((g) => (
        <section key={g} aria-label={g}>
          <h3 className="mb-1 text-xs font-bold text-faint">{g}</h3>
          <dl className="m-0 flex flex-col">
            {visible
              .filter((r) => r.group === g)
              .map((r) => (
                <FieldRow key={r.path} novelId={novelId} sessionId={s.id} row={r} editable={editable} onJump={onJumpToMessage} onConfirm={() => confirm.mutate({ paths: [r.path] })} />
              ))}
          </dl>
        </section>
      ))}
      <Button variant="ghost" size="sm" onClick={() => setShowEmpty((v) => !v)} aria-pressed={showEmpty}>
        {showEmpty ? "빈 항목 숨기기" : "빈 항목도 보기"}
      </Button>
    </aside>
  );
}

function FieldRow({
  novelId,
  sessionId,
  row,
  editable,
  onJump,
  onConfirm,
}: {
  novelId: string;
  sessionId: string;
  row: Row;
  editable: boolean;
  onJump: (id: string) => void;
  onConfirm: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const edit = useEditBrief(novelId, sessionId);
  const text = fieldValueText(row, row.value);
  const canEdit = editable && row.valueType !== "complex";
  const startEdit = () => {
    setDraft(editText(row.valueType, row.value));
    setEditing(true);
  };
  const save = () => edit.mutate({ path: row.path, value: parseEditValue(row.valueType, draft) }, { onSuccess: () => setEditing(false) });
  const inputLabel = `${row.label} 고치기`;

  return (
    <div className="border-t border-border py-2 first:border-t-0">
      <dt className="flex flex-wrap items-center gap-1 text-[12px] font-semibold text-muted">
        {row.label}
        {row.required && <span className="text-danger" aria-label="필수">*</span>}
        <Badge tone={STATE_TONE[row.state]} glyph>
          {row.badge?.stateLabel ?? labelKo("concept_slot_state", row.state)}
        </Badge>
        {row.origin && <Badge tone={ORIGIN_TONE[row.origin] ?? toneForStatus("concept_field_origin", row.origin)}>{row.badge?.originLabel ?? labelKo("concept_field_origin", row.origin)}</Badge>}
      </dt>
      <dd className="m-0 mt-0.5 text-[13px]">
        {editing ? (
          <div className="flex flex-col gap-1.5">
            {row.valueType === "choice" && row.choice ? (
              <Select aria-label={inputLabel} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}>
                {!row.choice.values.includes(draft) && <option value={draft}>{draft || "선택하세요"}</option>}
                {row.choice.values.map((v) => (
                  <option key={v} value={v}>
                    {labelKo(row.choice!.enum, v)}
                  </option>
                ))}
              </Select>
            ) : row.valueType === "text" && draft.length < 60 && !draft.includes("\n") ? (
              <Input aria-label={inputLabel} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), save())} />
            ) : row.valueType === "int" ? (
              <Input aria-label={inputLabel} autoFocus inputMode="numeric" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), save())} />
            ) : (
              <Textarea aria-label={inputLabel} autoFocus rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
            )}
            {row.valueType === "list" && <span className="text-xs text-faint">한 줄에 하나씩 또는 쉼표로 구분</span>}
            {edit.error && <Callout tone="danger">{errorMessage(edit.error)}</Callout>}
            <div className="flex gap-1.5">
              <Button size="sm" variant="primary" loading={edit.isPending} onClick={save}>
                저장
              </Button>
              <Button size="sm" onClick={() => setEditing(false)}>
                취소
              </Button>
            </div>
          </div>
        ) : (
          <>
            <span className={text ? "whitespace-pre-wrap" : "text-faint"}>{text || "아직 비어 있습니다"}</span>
            <span className="mt-1 -ml-2.5 flex flex-wrap gap-1">
              {canEdit && (
                <Button size="sm" variant="ghost" onClick={startEdit} aria-label={inputLabel}>
                  고치기
                </Button>
              )}
              {editable && row.state === "proposed" && !isEmptyBriefValue(row.value) && (
                <Button size="sm" variant="ghost" onClick={onConfirm} aria-label={`${row.label} 확정`}>
                  확정
                </Button>
              )}
              {row.evidence[0] && (
                <Button size="sm" variant="ghost" onClick={() => onJump(row.evidence[0]!)} aria-label={`${row.label} 근거 메시지로 이동`}>
                  근거 보기
                </Button>
              )}
            </span>
          </>
        )}
      </dd>
    </div>
  );
}
