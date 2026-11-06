import type { NovelDto } from "@ncs/shared";
import { Callout } from "../../components/ui/index.js";
import { AutonomySection } from "../settings/sections/AutonomySection.js";
import { ChannelsSection } from "../settings/sections/ChannelsSection.js";
import { CastStepCard } from "../cast/CastStepCard.js";
import { GoalForm } from "./GoalForm.js";

/**
 * `onboarding` 상태(컨셉 승인 후, 목표 전)의 설정 마무리: 캐릭터 설정(필수) → 목표(필수) → 자율성 수준 → 채널 연결(선택).
 * 캐스트를 확정해야 목표를 저장할 수 있습니다(서버 `cast_not_confirmed`).
 * 목표를 저장하면 N3로 `planning`이 되고 이 묶음은 사라집니다.
 */
export function NovelSetupFlow({ novel }: { novel: NovelDto }) {
  return (
    <section aria-labelledby="setup-flow-title" className="flex flex-col gap-3 rounded-xl border border-accent bg-accent-soft/40 p-3">
      <div>
        <h2 id="setup-flow-title" className="text-[15px] font-bold">
          설정 마무리
        </h2>
        <Callout tone="ok" className="mt-2">
          컨셉 브리프가 승인됐습니다. 캐릭터를 정해 캐스트를 확정한 뒤 연재 목표를 저장하면 기획서 작성이 시작됩니다. 자율성 수준과 채널은 나중에 설정에서 바꿀 수 있습니다.
        </Callout>
      </div>
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        <li>
          <CastStepCard novelId={novel.id} title="1. 캐릭터 설정 (필수)" />
        </li>
        <li>
          <GoalForm novelId={novel.id} title="2. 연재 목표 (필수)" />
        </li>
        <li>
          <AutonomySection novel={novel} />
        </li>
        <li>
          <ChannelsSection novelId={novel.id} timezone={novel.timezone} />
        </li>
      </ol>
    </section>
  );
}
