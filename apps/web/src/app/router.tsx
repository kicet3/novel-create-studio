import type { ComponentType } from "react";
import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { GlobalLayout, NovelLayout } from "./layouts.js";
import { NotFoundPage, RouteError } from "./RouteError.js";

/**
 * Route table. Novel-scoped screens live under `/novels/:novelId/<screen>` (08 §9.1, 03 T-4).
 * Detail paths from design/08 §9 (`episodes/:episodeNo`, `entities/:entityId`, `setups/:setupNo`,
 * `inbox/:questionId` — the messenger deep link in 05) render the same feature pages.
 *
 * Feature pages are code-split per route with `lazy`; each feature module exports a named page component.
 */
const page =
  <M,>(load: () => Promise<M>, pick: (m: M) => ComponentType) =>
  async () => ({ Component: pick(await load()) });

export const routes: RouteObject[] = [
  {
    path: "/",
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/novels" replace /> },
      {
        element: <GlobalLayout />,
        children: [
          { path: "novels", lazy: page(() => import("../features/novels/NovelsPage.js"), (m) => m.NovelsPage) },
          { path: "onboarding", lazy: page(() => import("../features/onboarding/OnboardingPage.js"), (m) => m.OnboardingPage) },
          { path: "settings", lazy: page(() => import("../features/settings/InstallSettingsPage.js"), (m) => m.InstallSettingsPage) },
          { path: "images", lazy: page(() => import("../features/images/ImagesPage.js"), (m) => m.ImagesPage) },
          { path: "dev/ui", lazy: page(() => import("../features/ui-catalog/UiCatalogPage.js"), (m) => m.UiCatalogPage) },
        ],
      },
      // 읽기(reader): full-screen reading without the sidebar
      { path: "novels/:novelId/read", lazy: page(() => import("../features/reader/ReaderTocPage.js"), (m) => m.ReaderTocPage) },
      { path: "novels/:novelId/read/:episodeNo", lazy: page(() => import("../features/reader/ReaderEpisodePage.js"), (m) => m.ReaderEpisodePage) },
      {
        path: "novels/:novelId",
        element: <NovelLayout />,
        children: [
          { index: true, lazy: page(() => import("../features/home/NovelHomePage.js"), (m) => m.NovelHomePage) },
          { path: "concept", lazy: page(() => import("../features/concept/ConceptPage.js"), (m) => m.ConceptPage) },
          { path: "cast", lazy: page(() => import("../features/cast/CastPage.js"), (m) => m.CastPage) },
          { path: "cast/:characterId", lazy: page(() => import("../features/cast/CastPage.js"), (m) => m.CastPage) },
          { path: "structure", lazy: page(() => import("../features/structure/StructurePage.js"), (m) => m.StructurePage) },
          { path: "structure/plots/:arcId", lazy: page(() => import("../features/structure/StructurePage.js"), (m) => m.StructurePage) },
          { path: "board", lazy: page(() => import("../features/board/BoardPage.js"), (m) => m.BoardPage) },
          { path: "agents", lazy: page(() => import("../features/agents/AgentsPage.js"), (m) => m.AgentsPage) },
          { path: "inbox", lazy: page(() => import("../features/inbox/InboxPage.js"), (m) => m.InboxPage) },
          { path: "inbox/:questionId", lazy: page(() => import("../features/inbox/InboxPage.js"), (m) => m.InboxPage) },
          { path: "manuscript", lazy: page(() => import("../features/manuscript/ManuscriptPage.js"), (m) => m.ManuscriptPage) },
          { path: "episodes/:episodeNo", lazy: page(() => import("../features/manuscript/ManuscriptPage.js"), (m) => m.ManuscriptPage) },
          { path: "ontology", lazy: page(() => import("../features/ontology/OntologyPage.js"), (m) => m.OntologyPage) },
          { path: "entities", element: <Navigate to="../ontology" relative="path" replace /> },
          { path: "entities/:entityId", lazy: page(() => import("../features/ontology/OntologyPage.js"), (m) => m.OntologyPage) },
          { path: "setups", lazy: page(() => import("../features/setups/SetupsPage.js"), (m) => m.SetupsPage) },
          { path: "setups/:setupNo", lazy: page(() => import("../features/setups/SetupsPage.js"), (m) => m.SetupsPage) },
          { path: "images", lazy: page(() => import("../features/images/ImagesPage.js"), (m) => m.NovelImagesPage) },
          { path: "audit", lazy: page(() => import("../features/audit/AuditPage.js"), (m) => m.AuditPage) },
          { path: "settings", lazy: page(() => import("../features/settings/NovelSettingsPage.js"), (m) => m.NovelSettingsPage) },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
      {
        element: <GlobalLayout />,
        children: [{ path: "*", element: <NotFoundPage /> }],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
