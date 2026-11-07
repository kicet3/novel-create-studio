"use client";
/** 보기 설정: 넘김 방식, 글자 크기·글꼴, 줄 간격, 문단 간격, 여백, 배경 테마 (localStorage). */
import type { ReactNode } from "react";
import {
  READER_FONTS,
  READER_FONT_LABELS,
  READER_FONT_STEPS_PX,
  READER_PAGE_CHARS,
  READER_PAGE_CHARS_LABELS,
  READER_STEPS3,
  READER_STEP3_LABELS,
  READER_THEMES,
  READER_THEME_LABELS,
  READER_VIEWS,
  READER_VIEW_LABELS,
  fontPxOf,
  stepFont,
} from "@ncs/reader-core";
import { useReaderSettings } from "../lib/hooks";
import { Sheet } from "./Sheet";

function Segmented<T extends string>({ label, value, options, labels, onChange }: { label: string; value: T; options: readonly T[]; labels: Record<T, string>; onChange: (v: T) => void }) {
  return (
    <Row label={label}>
      <div className="pr-seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={value === o} className="pr-seg-item" onClick={() => onChange(o)}>
            {labels[o]}
          </button>
        ))}
      </div>
    </Row>
  );
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="pr-set-row">
    <span className="pr-set-label">{label}</span>
    {children}
  </div>
);

export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [s, update] = useReaderSettings();
  return (
    <Sheet open={open} title="보기 설정" onClose={onClose}>
      <div className="pr-settings">
        <Segmented label="넘김 방식" value={s.view} options={READER_VIEWS} labels={READER_VIEW_LABELS} onChange={(view) => update({ view })} />
        {s.view === "page" && <Segmented label="한 쪽 분량" value={s.pageChars} options={READER_PAGE_CHARS} labels={READER_PAGE_CHARS_LABELS} onChange={(pageChars) => update({ pageChars })} />}
        <Row label="글자 크기">
          <div className="pr-stepper">
            <button type="button" className="pr-seg-item" aria-label="글자 작게" disabled={s.fontStep <= 0} onClick={() => update({ fontStep: stepFont(s.fontStep, -1) })}>
              가−
            </button>
            <span className="pr-stepper-value" aria-live="polite">
              {fontPxOf(s.fontStep)}
            </span>
            <button type="button" className="pr-seg-item" aria-label="글자 크게" disabled={s.fontStep >= READER_FONT_STEPS_PX.length - 1} onClick={() => update({ fontStep: stepFont(s.fontStep, 1) })}>
              가+
            </button>
          </div>
        </Row>
        <Segmented label="글꼴" value={s.font} options={READER_FONTS} labels={READER_FONT_LABELS} onChange={(font) => update({ font })} />
        <Segmented label="줄 간격" value={s.lineHeight} options={READER_STEPS3} labels={READER_STEP3_LABELS} onChange={(lineHeight) => update({ lineHeight })} />
        <Segmented label="문단 간격" value={s.paraSpacing} options={READER_STEPS3} labels={READER_STEP3_LABELS} onChange={(paraSpacing) => update({ paraSpacing })} />
        <Segmented label="좌우 여백" value={s.margin} options={READER_STEPS3} labels={READER_STEP3_LABELS} onChange={(margin) => update({ margin })} />
        <Row label="배경">
          <div className="pr-themes" role="radiogroup" aria-label="배경">
            {READER_THEMES.map((t) => (
              <button key={t} type="button" role="radio" aria-checked={s.theme === t} className="pr-theme-chip" data-chip={t} onClick={() => update({ theme: t })}>
                {READER_THEME_LABELS[t]}
              </button>
            ))}
          </div>
        </Row>
        <Row label="들여쓰기">
          <div className="pr-seg" role="radiogroup" aria-label="들여쓰기">
            {[false, true].map((v) => (
              <button key={String(v)} type="button" role="radio" aria-checked={s.indent === v} className="pr-seg-item" onClick={() => update({ indent: v })}>
                {v ? "켜기" : "끄기"}
              </button>
            ))}
          </div>
        </Row>
      </div>
    </Sheet>
  );
}
