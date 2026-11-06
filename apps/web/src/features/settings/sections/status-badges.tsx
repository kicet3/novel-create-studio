import type { ReactNode } from "react";
import { Badge } from "../../../components/ui/index.js";
import type { Tone } from "../../../components/ui/tone.js";

/**
 * One badge vocabulary for the settings screens, so the same word always means the same thing:
 * - 사용 중 (ok): what is applied right now
 * - 기본값 (accent): what a new novel / an untouched setting uses
 * - 주의 (warn): allowed, but removes a human check or costs money
 * - 예정 (neutral): not available yet (instead of "준비 중"/"v1")
 * - 꺼짐 (neutral): available but turned off
 */
export type SettingState = "active" | "default" | "caution" | "planned" | "off";

const META: Record<SettingState, { tone: Tone; label: string; title: string }> = {
  active: { tone: "ok", label: "사용 중", title: "지금 적용되고 있습니다." },
  default: { tone: "accent", label: "기본값", title: "따로 바꾸지 않으면 이 값을 씁니다." },
  caution: { tone: "warn", label: "주의", title: "사람 확인을 줄이거나 비용이 늘 수 있습니다. 설명을 확인하세요." },
  planned: { tone: "neutral", label: "예정", title: "아직 제공하지 않는 기능입니다." },
  off: { tone: "neutral", label: "꺼짐", title: "사용할 수 있지만 꺼져 있습니다." },
};

export const SETTING_STATE_LABEL: Record<SettingState, string> = Object.fromEntries(Object.entries(META).map(([k, v]) => [k, v.label])) as Record<SettingState, string>;

export function StateBadge({ state, children }: { state: SettingState; children?: ReactNode }) {
  const m = META[state];
  return (
    <Badge tone={m.tone} glyph={state === "active" || state === "caution"} title={m.title}>
      {children ?? m.label}
    </Badge>
  );
}

/** badges for one option row: state badges in a fixed order (사용 중 → 기본값 → 주의 → 예정) */
export function StateBadges({ states }: { states: Array<SettingState | false | null | undefined> }) {
  const order: SettingState[] = ["active", "default", "caution", "planned", "off"];
  const set = new Set(states.filter(Boolean) as SettingState[]);
  return (
    <>
      {order.filter((s) => set.has(s)).map((s) => (
        <StateBadge key={s} state={s} />
      ))}
    </>
  );
}
