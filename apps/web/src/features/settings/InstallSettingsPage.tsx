import { PageHeader } from "../../components/layout/PageHeader.js";
import { Callout } from "../../components/ui/index.js";
import { HealthChecksSection } from "./sections/HealthChecksSection.js";
import { BackupsCard, BotsCard, LlmCard, SecretsCard, SystemInfoCard } from "./sections/InstallSections.js";
import { ModelCatalogCard } from "./sections/ModelCatalogCard.js";
import { ProviderConnectionsCard } from "./sections/ProviderConnectionsCard.js";
import { PublicSiteConnectionCard } from "./sections/PublicSiteConnectionCard.js";
import { RoleDefaultsCard } from "./sections/RoleDefaultsCard.js";

/** `/settings` — 설치 단위 설정 (08 §9.8): AI 계정 연결·모델 관리·새 작품 기본 모델·단가 프로필, 메신저 봇, 공개 사이트(snowpage) 연결, 연결 점검, 백업, 비밀. */
export function InstallSettingsPage() {
  return (
    <>
      <PageHeader title="설치 설정" subtitle="이 컴퓨터에 설치된 Novel Studio 전체에 적용됩니다" />
      <div className="flex flex-col gap-3">
        <Callout tone="info">
          컴퓨터가 절전·종료 중이면 에이전트 작업과 질문 발송·수신이 멈추고, 복귀하면 자동으로 다시 시작합니다.
        </Callout>
        <ProviderConnectionsCard />
        {/* model lists / defaults / pricing history need the full width (review3 visual #11) */}
        <ModelCatalogCard />
        <RoleDefaultsCard />
        <LlmCard />
        <PublicSiteConnectionCard />
        <div className="grid grid-cols-1 gap-3 min-[861px]:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-3">
            <BotsCard />
            <SecretsCard />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <SystemInfoCard />
            <HealthChecksSection />
            <BackupsCard />
          </div>
        </div>
      </div>
    </>
  );
}
