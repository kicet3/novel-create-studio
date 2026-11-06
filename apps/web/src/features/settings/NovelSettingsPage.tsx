import { Link } from "react-router";
import { useNovelId } from "../../app/novel-context.js";
import { PageHeader } from "../../components/layout/PageHeader.js";
import { novelPath } from "../../components/layout/nav.js";
import { QueryView } from "../../components/ui/index.js";
import { useNovel } from "../novels/api.js";
import { AutonomySection } from "./sections/AutonomySection.js";
import { BudgetSection } from "./sections/BudgetSection.js";
import { ChannelsSection } from "./sections/ChannelsSection.js";
import { HealthChecksSection } from "./sections/HealthChecksSection.js";
import { LengthProfileSection } from "./sections/LengthProfileSection.js";
import { ModelBindingsSection } from "./sections/ModelBindingsSection.js";
import { NotificationSection } from "./sections/NotificationSection.js";
import { NovelBasicsSection } from "./sections/NovelBasicsSection.js";

/** `/novels/:novelId/settings` — 작품 단위 설정 (08 §9.8, FR-UI-09). 모든 변경은 감사 로그에 남습니다. */
export function NovelSettingsPage() {
  const novelId = useNovelId();
  const novel = useNovel(novelId);
  return (
    <>
      <PageHeader
        title="설정"
        subtitle={
          <>
            {novel.data ? `「${novel.data.title}」 ` : ""}작품 설정 · 모든 변경은 <Link to={novelPath(novelId, "audit")}>감사 타임라인</Link>에 주체·이전/이후 값과 함께 남습니다
          </>
        }
      />
      <QueryView query={novel}>
        {(n) => (
          <div className="grid grid-cols-1 gap-3 min-[861px]:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-3">
              <NovelBasicsSection key={n.updatedAt} novel={n} />
              <AutonomySection novel={n} />
              <BudgetSection novelId={novelId} />
              <LengthProfileSection novelId={novelId} />
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              <ChannelsSection novelId={novelId} timezone={n.timezone} />
              <HealthChecksSection novelId={novelId} timezone={n.timezone} />
              <NotificationSection novelId={novelId} />
            </div>
            <div className="min-w-0 min-[861px]:col-span-2">
              <ModelBindingsSection novelId={novelId} />
            </div>
          </div>
        )}
      </QueryView>
    </>
  );
}
