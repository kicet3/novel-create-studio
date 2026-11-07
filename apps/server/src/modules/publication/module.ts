/** Factory of `publication` (설계 추가 0021: 공개 사이트). */
import type { Platform, ServerModule } from "../../platform/index.js";
import type { AuditService } from "../audit/index.js";
import type { ManuscriptService } from "../manuscript/index.js";
import type { NovelService } from "../novel/index.js";
import type { SecretProvider } from "../../platform/index.js";
import type { PublicationService } from "./index.js";
import type { PublicDbConnector } from "./adapters/pg/public-db.js";
import { createPublicationService, isRebuildHint, RECONCILE_INTERVAL_MS } from "./application/publication-service.js";
import { mountPublicationRoutes } from "./adapters/http/routes.js";

export interface PublicationModuleDeps {
  platform: Platform;
  audit: AuditService;
  novel: NovelService;
  manuscript: ManuscriptService;
  /** studio secrets (system.service.secrets): holds the Supabase writer URL */
  secrets: SecretProvider;
  /** test seam: connect to a stand-in for the user's Supabase database (default postgres.js) */
  publicDbConnector?: PublicDbConnector;
}

/** debounce of audit hints (several publish events in one approval burst → one rebuild) */
const HINT_DEBOUNCE_MS = 1500;

export function createPublicationModule(deps: PublicationModuleDeps): ServerModule<PublicationService> {
  const service = createPublicationService(deps);
  let unsubscribe: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;
  const log = deps.platform.log.child({ module: "publication" });

  return {
    name: "publication",
    implemented: true,
    service,
    routes: (r) => mountPublicationRoutes(r, service),
    loops: [
      {
        name: "publication.reconcile",
        intervalMs: RECONCILE_INTERVAL_MS,
        runOnStart: true,
        async tick() {
          await service.rebuild();
        },
      },
    ],
    async start() {
      // a public-site config problem must never block the studio from starting
      await service.init().catch(() => log.warn("public site config could not be loaded; sync stays off until fixed"));
      // UI-style hint only: correctness comes from the reconcile fingerprint, the hint just makes it prompt
      unsubscribe = deps.audit.subscribe((ev) => {
        if (!isRebuildHint(ev.action)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          service.rebuild().catch((err: unknown) => log.warn({ err }, "public site sync failed"));
        }, HINT_DEBOUNCE_MS);
        timer.unref?.();
      });
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      if (timer) clearTimeout(timer);
      timer = null;
      await service.close();
    },
  };
}
