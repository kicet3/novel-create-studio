import { Outlet, useLocation } from "react-router";
import { AppShell } from "../components/layout/AppShell.js";
import { Sidebar, SidebarNavItem, SidebarSection } from "../components/layout/Sidebar.js";
import { NOVEL_NAV, novelPath } from "../components/layout/nav.js";
import { useNovelId } from "./novel-context.js";
import { NovelSidebarContext, useInboxNavCount } from "../features/novels/NovelSidebarContext.js";
import { useNovel } from "../features/novels/api.js";
import { AutopilotBanner } from "../features/autopilot/AutopilotBanner.js";

/** Shell for install-level pages: /novels, /onboarding, /settings. */
export function GlobalLayout() {
  return (
    <AppShell
      sidebar={
        <Sidebar
          navLabel="주 메뉴"
          context={
            <>
              <b className="block text-[13px]">작업 공간</b>
              <span className="text-muted">작품을 고르거나 새로 만드세요</span>
            </>
          }
        >
          <SidebarSection title="작품">
            <SidebarNavItem to="/novels" end icon="library">
              작품 목록
            </SidebarNavItem>
            <SidebarNavItem to="/onboarding" icon="plus">
              새 작품
            </SidebarNavItem>
          </SidebarSection>
          <SidebarSection title="도구">
            <SidebarNavItem to="/images" icon="image">
              이미지 생성
            </SidebarNavItem>
          </SidebarSection>
          <SidebarSection title="설치">
            <SidebarNavItem to="/settings" icon="gear">
              설치 설정
            </SidebarNavItem>
          </SidebarSection>
        </Sidebar>
      }
    >
      <Outlet />
    </AppShell>
  );
}

/** Shell for `/novels/:novelId/*`: novel context box, novel nav, and install-level links in the footer. */
export function NovelLayout() {
  const novelId = useNovelId();
  const inboxCount = useInboxNavCount(novelId);
  const novel = useNovel(novelId);
  const { pathname } = useLocation();
  // 설계 추가 0014: the full_auto status + kill switch on every novel screen (home shows the detailed banner itself)
  const home = pathname.replace(/\/+$/, "") === novelPath(novelId, "").replace(/\/+$/, "");
  return (
    <AppShell
      title={novel.data?.title}
      sidebar={
        <Sidebar
          navLabel="작품 메뉴"
          context={<NovelSidebarContext novelId={novelId} />}
          footer={
            <>
              <SidebarNavItem to="/novels" end icon="library">
                작품 목록
              </SidebarNavItem>
              <SidebarNavItem to="/images" end icon="image">
                이미지 생성(공용)
              </SidebarNavItem>
              <SidebarNavItem to="/settings" icon="gear">
                설치 설정
              </SidebarNavItem>
            </>
          }
        >
          <SidebarSection title="작품">
            {NOVEL_NAV.map((item) => (
              <SidebarNavItem
                key={item.screen}
                to={novelPath(novelId, item.path)}
                end={item.path === ""}
                icon={item.icon}
                count={item.screen === "inbox" ? inboxCount : undefined}
              >
                {item.label}
              </SidebarNavItem>
            ))}
          </SidebarSection>
        </Sidebar>
      }
    >
      {!home && novel.data?.autonomyLevel === "full_auto" && (
        <div className="mb-3">
          <AutopilotBanner novelId={novelId} autonomyLevel={novel.data.autonomyLevel} timezone={novel.data.timezone} compact />
        </div>
      )}
      {!home && novel.data?.autonomyLevel === "full_auto" && (
        <div className="mb-3">
          <AutopilotBanner novelId={novelId} autonomyLevel={novel.data.autonomyLevel} timezone={novel.data.timezone} compact />
        </div>
      )}
      <Outlet />
    </AppShell>
  );
}
