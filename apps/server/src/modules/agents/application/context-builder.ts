/**
 * ContextBuilder (04 §9): ID-based graph RAG over ontology + registered ContextSectionProviders.
 * No LLM calls (C-3). Every world item carries an id recorded in the ContextSnapshot (C-1, FR-AGT-04).
 *
 * Providers may reference entities inside their text with `{{E:<entity_id>}}`; the builder replaces
 * them with the entity's name and adds the entity to the snapshot. `{{E!:<entity_id>}}` is the entity's
 * reference mark: the pack handle (`E<n>`, 04 §9.6) for a task that resolves handles (`spec.entityMarks`), nothing
 * for everyone else (설계 추가 0025 — a handle shown in place of a name ended up in the manuscript: "E6은 …").
 */
import { DEFAULTS, LABELS_KO } from "@ncs/shared";
import { NotImplementedError, type NovelScope, type Platform } from "../../../platform/index.js";
import type { NovelService } from "../../novel/index.js";
import type { FactAtAnchor, OntologyService, StoryAnchor } from "../../ontology/index.js";
import { TaskFailure, type RunHandle } from "../../orchestration/index.js";
import type { ContextBuilder, ContextPack, ContextSectionKind, ContextSectionProvider, ContextSectionResult, ContextSpec } from "../index.js";
import { SECTION_RANK, SECTION_TITLE, estimateTokens, fitSections, entityHandle } from "../domain/context-budget.js";
import { UNNAMED_ENTITY, entityRefIds, renderEntityRefs } from "../domain/handle-text.js";
import { cardLayer, roleDefinition } from "../domain/roles.js";
import { snapshotRepo } from "../adapters/db/snapshot-repository.js";

export interface ContextBuilderDeps {
  platform: Platform;
  novel: NovelService;
  ontology: OntologyService;
  providers: () => ReadonlyMap<ContextSectionKind, ContextSectionProvider[]>;
}

interface Built extends ContextSectionResult {
  section: ContextSectionKind;
  module: string;
  /** entity_cards: the same cards without the given candidate fact versions (they are shown by `pending_canon`) */
  without?: (factVersionIds: ReadonlySet<string>) => ContextSectionResult;
}

interface StoredPack {
  pack: ContextPack;
  entityIds: string[];
  nameIds: string[];
}

const BUILTIN = "agents";
const label = (enumName: string, v: string | null | undefined) => (v ? ((LABELS_KO as unknown as Record<string, Record<string, string>>)[enumName]?.[v] ?? v) : "");

/** ontology calls tolerate a still-placeholder ontology module (NotImplementedError → no data) */
async function safe<T>(p: () => Promise<T>): Promise<T | null> {
  try {
    return await p();
  } catch (err) {
    if (err instanceof NotImplementedError) return null;
    throw err;
  }
}

const uniq = (xs: Iterable<string>) => [...new Set(xs)];
/** `f.text` already names its subject ("서이온 — 나이: 27"); the subject joins the snapshot through `refs.entityIds` */
const factLine = (f: FactAtAnchor, tag = "") => `- ${tag}${f.text}`;
const subjectsOf = (facts: FactAtAnchor[]) => uniq(facts.map((f) => f.subjectEntityId).filter((x): x is string => !!x));

export function packStorageKey(novelId: string, snapshotId: string): string {
  return `novels/${novelId}/context/${snapshotId}.json`;
}

export function createContextBuilder(deps: ContextBuilderDeps): ContextBuilder & { loadPack(scope: NovelScope, snapshotId: string): Promise<ContextPack | null> } {
  const { platform, novel, ontology } = deps;
  const { uow, clock, ids, storage } = platform;

  async function builtin(section: ContextSectionKind, scope: NovelScope, spec: ContextSpec, run: RunHandle, seeds: string[], prior: Built[], names: Map<string, string>): Promise<(ContextSectionResult & Pick<Built, "without">) | null> {
    const a = spec.anchor;
    switch (section) {
      case "entity_cards": {
        if (!seeds.length) return null;
        const cards = await safe(() => ontology.getEntityCards(scope, seeds, a, cardLayer(run.role, !!a.povEntityId)));
        if (!cards?.length) return null;
        const render = (skip: ReadonlySet<string>): ContextSectionResult => {
          const lines: string[] = [];
          const shown: string[] = [];
          for (const c of cards) {
            const primary = c.usableNames[0]?.surface ?? c.displayName;
            const others = c.usableNames.slice(1).map((n) => n.surface);
            names.set(c.entityId, primary);
            lines.push(`- ${primary} [{{E!:${c.entityId}}}] (${label("entity_type", c.entityType)})${c.disambiguator ? ` — ${c.disambiguator}` : ""}${others.length ? ` / 다른 표기: ${others.join(", ")}` : ""}`);
            const fs = c.facts.filter((f) => !(f.canonStatus === "candidate" && skip.has(f.factVersionId)));
            for (const f of fs) lines.push(`  · ${f.canonStatus === "candidate" ? "[미확정] " : ""}${f.text}`);
            shown.push(...fs.map((f) => f.factVersionId));
            const hasCand = fs.some((f) => f.canonStatus === "candidate");
            for (const n of c.notes) if (n !== "미확정 사실 포함" || hasCand) lines.push(`  ※ ${n}`);
          }
          return {
            text: lines.join("\n"),
            tokenEstimate: 0,
            refs: { entityIds: cards.map((c) => c.entityId), entityNameIds: cards.flatMap((c) => c.usableNames.map((n) => n.nameId)), factVersionIds: shown },
          };
        };
        return { ...render(new Set()), without: render };
      }
      case "pov_names": {
        if (!seeds.length || roleDefinition(run.role).contextLayer !== "pov") return null;
        const viewer = a.povEntityId ?? "narrator";
        const forbidden: Array<{ surface: string; nameId: string; entityId: string }> = [];
        for (const id of seeds) {
          const detail = await safe(() => ontology.getEntityDetail(scope, id));
          for (const n of detail?.names ?? []) {
            if (n.nameKind === "hidden_variant") continue;
            const known = await safe(() => ontology.identityKnownBy(scope, n.id, viewer, a.storyPoint));
            if (known === false) forbidden.push({ surface: n.surface, nameId: n.id, entityId: id });
          }
        }
        if (!forbidden.length) return null;
        return {
          text: forbidden.map((f) => `- "${f.surface}" (이 시점 인물·독자는 아직 이 표기와 정체를 연결하지 못합니다)`).join("\n"),
          tokenEstimate: 0,
          refs: { entityNameIds: forbidden.map((f) => f.nameId) },
        };
      }
      case "knowledge": {
        const facts = await safe(() => ontology.knowledgeOf(scope, a.povEntityId ?? "narrator", a.storyPoint, a.timelineId));
        if (!facts?.length) return null;
        return { text: facts.map((f) => factLine(f)).join("\n"), tokenEstimate: 0, refs: { factVersionIds: facts.map((f) => f.factVersionId), entityIds: subjectsOf(facts) } };
      }
      case "constraints": {
        const facts = await safe(() => ontology.getConstraints(scope, { entityIds: seeds, answerIds: spec.seeds.answerIds, anchor: a }));
        if (!facts?.length) return null;
        return {
          text: facts.map((f) => factLine(f)).join("\n"),
          tokenEstimate: 0,
          refs: { constraintFactIds: facts.map((f) => f.factId), factVersionIds: facts.map((f) => f.factVersionId), answerIds: spec.seeds.answerIds, entityIds: subjectsOf(facts) },
        };
      }
      case "canon_1hop": {
        if (!seeds.length) return null;
        const facts = await safe(() => ontology.getCanonAt(scope, seeds, a.storyPoint, a.timelineId, { include: "canon" }));
        if (!facts?.length) return null;
        // oldest story_range start dropped first when trimming → keep newest first
        const sorted = [...facts].sort((x, y) => y.storyRange.from - x.storyRange.from);
        return { text: sorted.map((f) => factLine(f)).join("\n"), tokenEstimate: 0, refs: { factVersionIds: sorted.map((f) => f.factVersionId), entityIds: subjectsOf(sorted) } };
      }
      case "canon_2hop": {
        const hop1 = prior.find((p) => p.section === "canon_1hop");
        const first = seeds.length ? await safe(() => ontology.getCanonAt(scope, seeds, a.storyPoint, a.timelineId, { include: "canon" })) : null;
        const allowed = spec.hopPredicates.hop2;
        const next = uniq((first ?? []).filter((f) => allowed === "all" || allowed.includes(f.predicate)).map((f) => f.objectEntityId ?? "").filter((x) => x && !seeds.includes(x)));
        if (!next.length) return null;
        const facts = await safe(() => ontology.getCanonAt(scope, next, a.storyPoint, a.timelineId, { include: "canon" }));
        const used = new Set(hop1?.refs.factVersionIds ?? []);
        const rest = (facts ?? []).filter((f) => !used.has(f.factVersionId) && (allowed === "all" || allowed.includes(f.predicate)));
        if (!rest.length) return null;
        return { text: rest.map((f) => factLine(f)).join("\n"), tokenEstimate: 0, refs: { factVersionIds: rest.map((f) => f.factVersionId), entityIds: uniq([...next, ...subjectsOf(rest)]) } };
      }
      case "candidates": {
        if (!seeds.length) return null;
        const facts = await safe(() => ontology.getCanonAt(scope, seeds, a.storyPoint, a.timelineId, { include: "canon_and_safe_candidates" }));
        const cands = (facts ?? []).filter((f) => f.canonStatus === "candidate");
        if (!cands.length) return null;
        return { text: cands.map((f) => factLine(f, "[미확정] ")).join("\n"), tokenEstimate: 0, refs: { candidateFactVersionIds: cands.map((f) => f.factVersionId), entityIds: subjectsOf(cands) } };
      }
      case "unresolved_surfaces": {
        if (!spec.manuscriptVersionId) return null;
        const ms = await safe(() => ontology.listMentions(scope, { linkStatus: ["ambiguous", "new_entity_candidate"], manuscriptVersionId: spec.manuscriptVersionId, limit: 30 }));
        if (!ms?.length) return null;
        const lines = ms.map((m) => {
          const cands = Array.isArray(m.candidates) ? (m.candidates as Array<{ entityId: string }>).map((c) => `{{E:${c.entityId}}}`).join(", ") : "";
          return `- "${m.surface}" (${label("link_status", m.linkStatus)})${cands ? ` 후보: ${cands}` : ""}`;
        });
        return { text: lines.join("\n"), tokenEstimate: 0, refs: {} };
      }
      default:
        return null;
    }
  }

  function headerText(n: Awaited<ReturnType<NovelService["getNovel"]>>, run: RunHandle): string {
    const role = roleDefinition(run.role);
    return [
      role.mission,
      "## 작품",
      [
        `- 제목: ${n.title}`,
        n.genre ? `- 장르: ${n.genre}` : "",
        `- 연령 등급: ${label("age_rating", n.ageRating)} (이 등급을 넘는 묘사는 쓰지 않습니다)`,
        `- 기본 서술 방식: ${label("narration_mode", n.defaultNarrationMode)}`,
        n.targetAudience ? `- 대상 독자: ${n.targetAudience}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      "## 공통 규칙",
      [
        "- 사용자에게 보이는 문장은 한국어 존댓말 평서문으로 씁니다(본문 서술은 작품 문체를 따릅니다).",
        "- 컨텍스트에 없는 사실을 캐논처럼 단정하지 않습니다. [미확정] 사실은 참고만 합니다.",
        "- 실존 인물을 비방하거나 미성년자를 성적으로 묘사하지 않습니다.",
      ].join("\n"),
    ].join("\n\n");
  }

  async function storePack(novelId: string, snapshotId: string, stored: StoredPack): Promise<void> {
    await storage.put(packStorageKey(novelId, snapshotId), JSON.stringify(stored), { overwrite: true });
  }

  async function loadStored(novelId: string, snapshotId: string): Promise<StoredPack | null> {
    const key = packStorageKey(novelId, snapshotId);
    if (!(await storage.exists(key))) return null;
    return JSON.parse((await storage.get(key)).toString("utf8")) as StoredPack;
  }

  async function buildInner(run: RunHandle, spec: ContextSpec): Promise<ContextPack> {
    const t0 = clock.now();
    const scope: NovelScope = { novelId: run.novelId };
    const n = await novel.getNovel(scope);
    let anchor: StoryAnchor = spec.anchor;
    if (!anchor.timelineId) {
      const tl = await safe(() => ontology.getDefaultTimeline(scope));
      if (tl) anchor = { ...anchor, timelineId: tl.id };
    }
    const effSpec: ContextSpec = { ...spec, anchor };

    // seeds (C-2, C-6): merged ids → survivor
    let seeds = uniq(spec.seeds.entityIds);
    if (seeds.length) {
      const map = await safe(() => ontology.resolveEntityIds(scope, seeds));
      if (map) seeds = uniq(seeds.map((id) => map.get(id) ?? id));
    }

    const providers = deps.providers();
    const built: Built[] = [];
    /** entity id → the name this role may use (entity cards first, the rest looked up below) */
    const names = new Map<string, string>();
    const sections = uniq(spec.sections) as ContextSectionKind[];
    sections.sort((x, y) => SECTION_RANK[x] - SECTION_RANK[y]);
    for (const section of sections) {
      const own = providers.get(section) ?? [];
      for (const p of own) {
        const r = await p.build(scope, effSpec, run);
        if (r && r.text.trim()) built.push({ ...r, section, module: p.module });
      }
      const b = await builtin(section, scope, effSpec, run, seeds, built, names);
      if (b && b.text.trim()) built.push({ ...b, section, module: BUILTIN });
    }

    // handles (04 §9.6): seeds first, then ids referenced by sections, then inline placeholders
    const entityIds: string[] = [...seeds];
    const addEntity = (id: string) => {
      if (id && !entityIds.includes(id)) entityIds.push(id);
    };
    for (const b of built) for (const id of b.refs.entityIds ?? []) addEntity(id);
    for (const b of built) for (const id of entityRefIds(b.text)) addEntity(id);
    const handleOf = (id: string) => entityHandle(entityIds.indexOf(id));
    // names of entities that have no card in this pack (fact subjects, 2-hop neighbours, mention candidates)
    const layer = cardLayer(run.role, !!anchor.povEntityId);
    const unnamed = entityIds.filter((id) => !names.has(id));
    if (unnamed.length) {
      // a referenced entity may be gone (deleted / never created): that one stays unnamed, the pack still builds
      const nameOfCard = (c: { usableNames: Array<{ surface: string }>; displayName: string }) => c.usableNames[0]?.surface ?? c.displayName;
      const cardsOf = (ids: string[]) => ontology.getEntityCards(scope, ids, anchor, layer).catch(() => null);
      for (const c of (await cardsOf(unnamed)) ?? []) names.set(c.entityId, nameOfCard(c));
      // one by one for the rest: the batch failed on a missing id, or a merged id came back under its survivor's id
      for (const id of unnamed.filter((x) => !names.has(x))) {
        const c = (await cardsOf([id]))?.[0];
        if (c) names.set(id, nameOfCard(c));
      }
    }
    const nameOf = (id: string) => names.get(id) || UNNAMED_ENTITY;
    // handles are shown only to a task that resolves them (spec.entityMarks) — never to a role that writes prose
    const marks = !!spec.entityMarks && roleDefinition(run.role).contextLayer !== "pov";
    const renderRefs = (text: string) => renderEntityRefs(text, { nameOf, handleOf, marks });
    for (const b of built) {
      b.text = renderRefs(b.text);
      b.tokenEstimate = Math.max(b.tokenEstimate || 0, estimateTokens(b.text) + 8);
    }

    const handleNote =
      "\n\n엔티티 옆의 [E1], [E2] … 는 참조용 핸들입니다. JSON의 엔티티 참조 필드에만 쓰고, 요약·설명·본문 같은 문장에는 핸들 대신 이름을 씁니다. 핸들은 이 컨텍스트 안에서만 유효합니다.";
    const system = headerText(n, run) + (marks && entityIds.length ? handleNote : "");
    const decision = fitSections(built, estimateTokens(system), spec.maxInputTokens, spec.keepSections ?? []);
    if (!decision.ok) {
      throw new TaskFailure("internal", `컨텍스트 상한 초과: 필수 섹션만으로 ${decision.required} 토큰이 필요하지만 상한은 ${decision.max} 토큰입니다.`, false);
    }
    const kept = decision.kept;
    // 설계 추가(미확정 사실 선행 집필): an earlier episode's candidate fact kept in `pending_canon` (with its source episode)
    // is not repeated as a bare "[미확정]" line on the entity card
    const pending = kept.find((b) => b.section === "pending_canon");
    const shownPending = new Set(pending?.refs.candidateFactVersionIds ?? []);
    if (shownPending.size) {
      for (const b of kept) {
        if (!b.without) continue;
        const r = b.without(shownPending);
        const before = b.tokenEstimate;
        b.text = renderRefs(r.text);
        b.refs = r.refs;
        b.tokenEstimate = estimateTokens(b.text) + 8;
        decision.total -= Math.max(0, before - b.tokenEstimate);
      }
    }
    const body = kept.map((b) => `## ${SECTION_TITLE[b.section]}\n${b.text}`).join("\n\n");
    const messages = body ? [{ role: "user" as const, content: `# 컨텍스트\n\n${body}`, cacheBoundary: true }] : [];

    const collect = (k: keyof ContextSectionResult["refs"]) => uniq(kept.flatMap((b) => b.refs[k] ?? []));
    const nameIds = collect("entityNameIds");
    const snapshotId = ids.next("ctx");
    const pack: ContextPack = {
      snapshotId,
      system,
      messages,
      handles: { entities: entityIds, names: nameIds, labels: entityIds.map((id) => names.get(id) ?? "") },
      tokenEstimate: decision.total,
      droppedSections: decision.dropped,
      sections: kept.map((b) => ({ section: b.section, module: b.module, tokenEstimate: b.tokenEstimate })),
    };

    await uow.run(async (tx) => {
      await snapshotRepo.insert(tx.db, {
        id: snapshotId,
        novelId: scope.novelId,
        runId: run.runId,
        storyPoint: Number.isFinite(anchor.storyPoint) ? Math.trunc(anchor.storyPoint) : null,
        timelineId: /^tln_/.test(anchor.timelineId) ? anchor.timelineId : null,
        povEntityId: anchor.povEntityId && /^ent_/.test(anchor.povEntityId) ? anchor.povEntityId : null,
        conceptMessageIds: collect("conceptMessageIds"),
        factVersionIds: collect("factVersionIds"),
        candidateFactVersionIds: collect("candidateFactVersionIds"),
        constraintFactIds: collect("constraintFactIds"),
        setupIds: uniq([...spec.seeds.setupIds, ...collect("setupIds")]),
        answerIds: uniq([...spec.seeds.answerIds, ...collect("answerIds")]),
        entityIds,
        entityNameIds: nameIds,
        schemaVersionId: n.activeSchemaVersionId,
        episodeRecapIds: collect("recapIds"),
        provisionalQuestionIds: collect("questionIds"),
        manuscriptVersionIds: collect("versionIds"),
        tokenEstimate: decision.total,
        buildMs: Math.max(0, Math.round(clock.now() - t0)),
      });
      // runs.context_snapshot_id (FR-AGT-04)
      await run.attachContextSnapshot?.(tx, snapshotId);
    });
    await storePack(scope.novelId, snapshotId, { pack, entityIds, nameIds });
    return pack;
  }

  return {
    async build(run, spec) {
      const timeoutMs = DEFAULTS["context.build_timeout_seconds"] * 1000;
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          buildInner(run, spec),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new TaskFailure("internal", "컨텍스트 구성 시간이 초과되었습니다.", true)), timeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    async cloneFrom(snapshotId, run) {
      const scope: NovelScope = { novelId: run.novelId };
      const orig = await snapshotRepo.get(uow.db, scope, snapshotId);
      if (!orig) throw new TaskFailure("internal", `원본 컨텍스트 스냅숏이 없습니다: ${snapshotId}`, false);
      const stored = await loadStored(scope.novelId, snapshotId);
      if (!stored) throw new TaskFailure("internal", `원본 컨텍스트 내용이 없습니다: ${snapshotId}`, false);
      // 설계 추가 0025: a pack stored before 0025 shows handles in place of names — the caller rebuilds the context instead
      if (!Array.isArray(stored.pack.handles?.labels)) throw new TaskFailure("internal", `이전 형식의 컨텍스트라 다시 구성합니다: ${snapshotId}`, false);
      const id = ids.next("ctx");
      await uow.run(async (tx) => {
        const { id: _old, createdAt: _c, ...rest } = orig;
        await snapshotRepo.insert(tx.db, { ...rest, id, runId: run.runId, clonedFromSnapshotId: orig.id, buildMs: 0 });
        await run.attachContextSnapshot?.(tx, id);
      });
      const pack: ContextPack = { ...stored.pack, snapshotId: id };
      await storePack(scope.novelId, id, { ...stored, pack });
      return pack;
    },

    async loadPack(scope, snapshotId) {
      return (await loadStored(scope.novelId, snapshotId))?.pack ?? null;
    },
  };
}
