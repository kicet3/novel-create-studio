import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { labelKo, type EpisodeStatus } from "@ncs/shared";
import { PageHeader } from "../../components/layout/PageHeader.js";
import {
  Badge,
  Button,
  ButtonLink,
  Callout,
  Card,
  formatDateTime,
  formatRelative,
  InlineStatus,
  List,
  ListItem,
  NotReady,
  QueryError,
  QueryView,
  StatusBadge,
  Tabs,
  CHOICE_BOX,
} from "../../components/ui/index.js";
import { cx } from "../../lib/cx.js";
import { actorLabelKo } from "../audit/labels.js";
import { useMe, useNovel } from "../novels/api.js";
import { useSetups } from "../setups/api.js";
import { describeLocation } from "./annotate.js";
import {
  useArcs,
  useEpisode,
  useEpisodes,
  usePauseEpisode,
  useRejections,
  useVersionDetail,
  useVersions,
  type BeatAnnotation,
  type IssueAnnotation,
  type ManuscriptVersionSummaryDto,
  type VersionDetail,
} from "./api.js";
import { DiffView, versionLabel } from "./DiffView.js";
import { EditPanel } from "./EditPanel.js";
import { EpisodeActionBar } from "./EpisodeActionBar.js";
import { PublishDialog, RevisionDialog, UnpublishDialog } from "./EpisodeDialogs.js";
import { ExportDialog } from "./ExportDialog.js";
import { RevisionChat } from "../revision/RevisionChatPanel.js";
import { AttributionLegend, beatSort, DEFAULT_TOGGLES, issueSort, markerDomId, VersionViewer, type ViewerToggles } from "./VersionViewer.js";

const FLOW: readonly EpisodeStatus[] = ["outlining", "drafting", "checking", "polishing", "awaiting_approval", "approved", "published"];

type Mode = "read" | "diff" | "edit" | "chat";
type DialogKind = "revision" | "publish" | "unpublish" | "export" | null;

/** `/novels/:novelId/episodes/:episodeNo` — one episode: version viewer, diff, direct edit (08 §9.4). */
export function EpisodeScreen({ novelId, episodeNo }: { novelId: string; episodeNo: number }) {
  const [params, setParams] = useSearchParams();
  const episode = useEpisode(novelId, episodeNo);
  const versions = useVersions(novelId, episodeNo);
  const episodes = useEpisodes(novelId);
  const arcs = useArcs(novelId);
  const novel = useNovel(novelId);
  const me = useMe().data ?? null;
  const setups = useSetups(novelId);
  const tz = novel.data?.timezone;
  const [toggles, setToggles] = useState<ViewerToggles>(DEFAULT_TOGGLES);
  const [dialog, setDialog] = useState<DialogKind>(null);

  const mode = (params.get("mode") as Mode | null) ?? "read";
  const setMode = (m: Mode) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (m === "read") n.delete("mode");
        else n.set("mode", m);
        return n;
      },
      { replace: true },
    );

  const sortedVersions = useMemo(() => [...(versions.data ?? [])].sort((a, b) => b.versionNo - a.versionNo), [versions.data]);
  const ep = episode.data;
  // an approved / published episode opens on its final text (the approval snapshot is newer than the working copy)
  const finalId = ep && (ep.status === "published" || ep.status === "approved") ? (ep.publishedVersionId ?? ep.approvedVersionId) : null;
  const selectedId = params.get("v") ?? finalId ?? ep?.currentVersionId ?? sortedVersions[0]?.id ?? null;
  const detail = useVersionDetail(novelId, selectedId);
  // 수정 대화 works on the working copy (anchors / patch bases are ids of the current version)
  const currentDetail = useVersionDetail(novelId, mode === "chat" ? (ep?.currentVersionId ?? null) : null, "spans");
  const at = params.get("at");
  const end = params.get("end");
  const focus = useMemo(() => (at !== null && Number.isFinite(Number(at)) ? { start: Number(at), end: end !== null ? Number(end) : Number(at) + 1 } : null), [at, end]);

  const setupMap = useMemo(() => new Map((setups.data ?? []).map((s) => [s.id, s])), [setups.data]);
  const setupLabel = useCallback((id: string) => setupMap.get(id)?.displayLabel ?? "떡밥", [setupMap]);

  const selectVersion = (id: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set("v", id);
        n.delete("at");
        n.delete("end");
        return n;
      },
      { replace: false },
    );

  const neighbours = useMemo(() => {
    const nos = (episodes.data ?? []).map((e) => e.episodeNo).sort((a, b) => a - b);
    const idx = nos.indexOf(episodeNo);
    return { prev: idx > 0 ? nos[idx - 1] : undefined, next: idx >= 0 && idx < nos.length - 1 ? nos[idx + 1] : undefined };
  }, [episodes.data, episodeNo]);

  if (!ep) {
    return (
      <>
        <PageHeader title={`원고 · ${episodeNo}화`} actions={<ButtonLink to={`/novels/${novelId}/manuscript`}>화 목록</ButtonLink>} />
        <QueryView query={episode} notReadyDescription="원고 모듈이 준비되면 이 화의 버전과 본문이 표시됩니다.">
          {() => null}
        </QueryView>
      </>
    );
  }

  const arc = arcs.data?.find((a) => a.id === ep.arcId);
  const pause = <PauseButton novelId={novelId} episodeNo={episodeNo} paused={!!ep.pausedAt} />;

  return (
    <>
      <PageHeader
        title={`${ep.episodeNo}화${ep.title ? ` · ${ep.title}` : ""}`}
        subtitle={
          <span>
            <Link to={`/novels/${novelId}/manuscript`} className="underline">
              원고
            </Link>
            {arc && ` › 플롯 ${arc.ord} · ${arc.title} (${arc.plannedEpisodeFrom}~${arc.plannedEpisodeTo}화)`}
          </span>
        }
        actions={
          <>
            <StatusBadge enum="episode_status" value={ep.status} />
            {ep.blockReasons.map((r) => (
              <Badge key={r} tone="danger" glyph>
                {labelKo("episode_block_reason", r)}
              </Badge>
            ))}
            {ep.pausedAt && <Badge tone="warn">일시정지</Badge>}
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ButtonLink size="sm" to={`/novels/${novelId}/episodes/${neighbours.prev ?? episodeNo}`} aria-disabled={neighbours.prev === undefined} className={cx(neighbours.prev === undefined && "pointer-events-none opacity-50")}>
          ← 이전 화
        </ButtonLink>
        <ButtonLink size="sm" to={`/novels/${novelId}/episodes/${neighbours.next ?? episodeNo}`} aria-disabled={neighbours.next === undefined} className={cx(neighbours.next === undefined && "pointer-events-none opacity-50")}>
          다음 화 →
        </ButtonLink>
        <div className="ml-auto flex flex-wrap gap-2">
          <ButtonLink size="sm" variant="ghost" to={`/novels/${novelId}/audit?targetType=episode&targetId=${ep.id}`}>
            이 화의 감사 이력
          </ButtonLink>
          <Button size="sm" onClick={() => setDialog("export")}>
            TXT · Markdown 내보내기
          </Button>
          {ep.status !== "published" && ep.status !== "approved" && pause}
          {ep.status === "approved" && (
            <>
              <Button size="sm" onClick={() => setDialog("revision")}>
                수정 요청
              </Button>
              <Button size="sm" variant="primary" onClick={() => setDialog("publish")}>
                공개
              </Button>
            </>
          )}
          {ep.status === "published" && (
            <Button size="sm" variant="danger" onClick={() => setDialog("unpublish")}>
              공개 취소
            </Button>
          )}
        </div>
      </div>

      <Stepper status={ep.status} />

      {ep.length?.belowFloor && (
        <Callout tone="danger" title="분량 미달" className="mt-3">
          {ep.length.count.toLocaleString("ko-KR")}자 / 최소 {ep.length.hardMinChars.toLocaleString("ko-KR")}자({labelKo("count_basis", ep.length.basis)}). 자동 승인·공개되지 않습니다. 직접 늘리거나 수정 요청을 보내 주세요.
        </Callout>
      )}

      {ep.status === "awaiting_approval" && mode !== "chat" && (
        <Callout tone="info" title={`${ep.episodeNo}화를 읽고 승인해 주세요`} className="mt-3" actions={<Button size="sm" onClick={() => setMode("chat")}>수정 대화</Button>}>
          이상한 부분은 [수정 대화]에서 묻고 고칠 수 있고, 대화 아래에서 바로 승인·공개할 수 있습니다. 반려는 인박스에서 합니다.
        </Callout>
      )}

      {mode === "chat" ? (
        <div className="mt-3">
          <ChatTabs value={mode} onChange={setMode} versionsCount={sortedVersions.length} hasText={!!ep.currentVersionId} />
          <div className="mt-3">
            <RevisionChat novelId={novelId} episodeNo={episodeNo} timezone={tz} content={currentDetail.data ? { versionId: currentDetail.data.id, text: currentDetail.data.content } : null} />
          </div>
          <EpisodeActionBar novelId={novelId} episode={ep} />
        </div>
      ) : (
      <div className="mt-3 grid grid-cols-1 gap-3 min-[1100px]:grid-cols-[minmax(0,1fr)_340px]">
        {/* desktop: the manuscript column is as tall as the info column (down to the 회차 말 훅 card) and scrolls inside */}
        <div className="min-w-0 min-[1100px]:relative min-[1100px]:min-h-[560px]">
          <div className="flex flex-col min-[1100px]:absolute min-[1100px]:inset-0">
          <ChatTabs value={mode} onChange={setMode} versionsCount={sortedVersions.length} hasText={!!ep.currentVersionId} />
          <div className={cx("mt-3 flex min-h-0 flex-1 flex-col", mode !== "read" && "min-[1100px]:overflow-y-auto")}>
            {mode === "diff" ? (
              <QueryView query={versions}>{(vs) => <DiffView novelId={novelId} versions={vs} defaultTargetId={selectedId} me={me} />}</QueryView>
            ) : !selectedId ? (
              <Callout tone="info" title="아직 원고가 없습니다">
                아웃라인이 작성되면 이곳에 표시됩니다.
              </Callout>
            ) : detail.data ? (
              mode === "edit" ? (
                <EditGate novelId={novelId} episode={ep} detail={detail.data} onSaved={selectVersion} />
              ) : (
                <ReadPane detail={detail.data} toggles={toggles} setToggles={setToggles} setupLabel={setupLabel} focus={focus} me={me} versions={sortedVersions} />
              )
            ) : detail.error ? (
              <QueryError error={detail.error} onRetry={() => void detail.refetch()} />
            ) : (
              <InlineStatus>본문을 불러오는 중…</InlineStatus>
            )}
          </div>
          </div>
        </div>

        <aside className="grid content-start gap-3" aria-label="원고 정보">
          <LengthCard detail={ep.length} />
          <VersionsCard versions={versions} selectedId={selectedId} currentId={ep.currentVersionId} approvedId={ep.approvedVersionId} publishedId={ep.publishedVersionId} onSelect={selectVersion} tz={tz} me={me} />
          {detail.data && <IssuesCard detail={detail.data} />}
          {detail.data && <BeatsCard detail={detail.data} setupLabel={setupLabel} setupTitle={(id) => setupMap.get(id)?.title} novelId={novelId} />}
          <RejectionsCard novelId={novelId} episodeNo={episodeNo} count={ep.rejectionCount} tz={tz} />
          {ep.hookNote && (
            <Card title="회차 말 훅">
              <p className="m-0 text-[13px]">{ep.hookNote}</p>
            </Card>
          )}
        </aside>
      </div>
      )}

      {dialog === "revision" && <RevisionDialog novelId={novelId} episode={ep} open onClose={() => setDialog(null)} />}
      {dialog === "publish" && <PublishDialog novelId={novelId} episode={ep} open onClose={() => setDialog(null)} />}
      {dialog === "unpublish" && <UnpublishDialog novelId={novelId} episode={ep} open onClose={() => setDialog(null)} />}
      {dialog === "export" && (
        <ExportDialog novelId={novelId} target={{ scopeKind: "episode", targetId: ep.id, label: `${ep.episodeNo}화` }} open onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function ChatTabs({ value, onChange, versionsCount, hasText }: { value: Mode; onChange: (m: Mode) => void; versionsCount: number; hasText: boolean }) {
  return (
    <Tabs
      label="원고 보기"
      value={value}
      onChange={onChange}
      items={[
        { value: "read", label: "본문" },
        { value: "diff", label: "버전 비교", disabled: versionsCount < 2 },
        { value: "edit", label: "직접 수정", disabled: !hasText },
        { value: "chat", label: "수정 대화", disabled: !hasText },
      ]}
    />
  );
}

function PauseButton({ novelId, episodeNo, paused }: { novelId: string; episodeNo: number; paused: boolean }) {
  const m = usePauseEpisode(novelId, episodeNo);
  return (
    <Button size="sm" loading={m.isPending} onClick={() => m.mutate(!paused)} title={m.error ? String((m.error as Error).message) : undefined}>
      {paused ? "재개" : "일시정지"}
    </Button>
  );
}

function Stepper({ status }: { status: EpisodeStatus }) {
  const idx = status === "revising" ? FLOW.indexOf("drafting") : FLOW.indexOf(status);
  return (
    <ol className="m-0 flex list-none flex-wrap gap-1 p-0 text-xs" aria-label="화 진행 단계">
      {FLOW.map((s, i) => {
        const state = idx < 0 ? "todo" : i < idx ? "done" : i === idx ? "now" : "todo";
        return (
          <li
            key={s}
            aria-current={state === "now" ? "step" : undefined}
            className={cx(
              "rounded-full border px-2.5 py-0.5",
              state === "done" && "border-ok bg-ok-soft text-ok",
              state === "now" && "border-accent bg-accent-soft font-semibold text-accent",
              state === "todo" && "border-border text-faint",
            )}
          >
            {state === "done" && <span aria-hidden="true">✓ </span>}
            {labelKo("episode_status", s)}
          </li>
        );
      })}
      {status === "revising" && <li className="rounded-full border border-warn bg-warn-soft px-2.5 py-0.5 font-semibold text-warn">{labelKo("episode_status", "revising")}</li>}
    </ol>
  );
}

function ReadPane({
  detail,
  toggles,
  setToggles,
  setupLabel,
  focus,
  me,
  versions,
}: {
  detail: VersionDetail;
  toggles: ViewerToggles;
  setToggles: (t: ViewerToggles) => void;
  setupLabel: (id: string) => string;
  focus: { start: number; end: number } | null;
  me: { id: string; displayName: string } | null;
  versions: ManuscriptVersionSummaryDto[];
}) {
  const summary = versions.find((v) => v.id === detail.id);
  const missing = (detail.beats ?? []).filter((b) => b.status === "missing");
  const toggle = (k: keyof ViewerToggles, label: string) => (
    <label className="flex items-center gap-1.5">
      <input type="checkbox" className={CHOICE_BOX} checked={toggles[k]} onChange={(e) => setToggles({ ...toggles, [k]: e.target.checked })} />
      {label}
    </label>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="font-semibold text-text">{summary ? versionLabel(summary, me) : `v${detail.versionNo}`}</span>
        <span className="tabular">
          {detail.charCountWithSpaces.toLocaleString("ko-KR")}자(공백 포함) · {detail.charCountWithoutSpaces.toLocaleString("ko-KR")}자(공백 제외)
        </span>
        {detail.isFallbackModel && <Badge tone="warn">대체 모델</Badge>}
        <div className="ml-auto flex flex-wrap gap-3">
          {toggle("attribution", "작성 주체")}
          {toggle("scenes", "씬 경계")}
          {toggle("issues", "이슈")}
          {toggle("beats", "떡밥")}
        </div>
      </div>
      {toggles.attribution && <AttributionLegend />}
      {missing.length > 0 && (
        <Callout tone="warn" title={`이 화에 배정됐지만 찾지 못한 떡밥 비트 ${missing.length}건`}>
          {missing.map((b) => `${setupLabel(b.setupId)} ${labelKo("setup_beat_kind", b.kind)}`).join(", ")} — 누락 비트가 있으면 승인 대기로 넘어가지 않습니다.
        </Callout>
      )}
      <VersionViewer detail={detail} toggles={toggles} setupLabel={setupLabel} focus={focus} me={me} className="min-[1100px]:min-h-0 min-[1100px]:flex-1 min-[1100px]:overflow-y-auto" />
    </div>
  );
}

function EditGate({ novelId, episode, detail, onSaved }: { novelId: string; episode: NonNullable<ReturnType<typeof useEpisode>["data"]>; detail: VersionDetail; onSaved: (id: string) => void }) {
  // remount the editor when the base version changes so the textarea resets
  return <EditPanel key={detail.id} novelId={novelId} episode={episode} baseVersionId={detail.id} baseContent={detail.content} onSaved={onSaved} />;
}

function LengthCard({ detail }: { detail: NonNullable<ReturnType<typeof useEpisode>["data"]>["length"] }) {
  if (!detail) return null;
  const tone = detail.belowFloor ? "danger" : detail.deviation ? "warn" : "ok";
  return (
    <Card title="분량">
      <div className="tabular text-[20px] font-bold">
        {detail.count.toLocaleString("ko-KR")}
        <span className="ml-1 text-xs font-normal text-muted">자 · {labelKo("count_basis", detail.basis)}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-xs text-muted">
        기준 {detail.minChars.toLocaleString("ko-KR")}~{detail.maxChars.toLocaleString("ko-KR")}
        <Badge tone={tone} glyph>
          {detail.belowFloor ? "분량 미달" : detail.deviation === "short" ? "부족" : detail.deviation === "long" ? "초과" : "충족"}
        </Badge>
      </div>
      <p className="m-0 mt-1 text-xs text-faint">고정 하한 {detail.hardMinChars.toLocaleString("ko-KR")}자 — 미만이면 자동 승인·공개하지 않습니다.</p>
    </Card>
  );
}

function VersionsCard({
  versions,
  selectedId,
  currentId,
  approvedId,
  publishedId,
  onSelect,
  tz,
  me,
}: {
  versions: ReturnType<typeof useVersions>;
  selectedId: string | null;
  currentId: string | null;
  approvedId: string | null;
  publishedId: string | null;
  onSelect: (id: string) => void;
  tz?: string;
  me: { id: string; displayName: string } | null;
}) {
  return (
    <Card title="버전 · 작성 주체">
      <QueryView query={versions} compact>
        {(items) =>
          items.length === 0 ? (
            <InlineStatus>버전이 없습니다.</InlineStatus>
          ) : (
            <List>
              {[...items]
                .sort((a, b) => b.versionNo - a.versionNo)
                .map((v) => (
                  <ListItem key={v.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(v.id)}
                      aria-current={v.id === selectedId ? "true" : undefined}
                      className={cx("w-full rounded-md px-1.5 py-1 text-left text-[12.5px] hover:bg-surface-2", v.id === selectedId && "bg-accent-soft")}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <b>v{v.versionNo}</b>
                        <span>{v.isHumanEdit ? `사람 수정${me && me.id === v.authorActorId ? ` · ${me.displayName}` : ""}` : actorLabelKo({ actorType: v.authorActorType, actorId: v.agentRole ?? v.authorActorId })}</span>
                        <span className="text-muted">· {labelKo("manuscript_version_kind", v.kind)}</span>
                        {v.id === currentId && <Badge tone="info">현재</Badge>}
                        {v.id === approvedId && <Badge tone="accent">승인본</Badge>}
                        {v.id === publishedId && <Badge tone="ok">공개본</Badge>}
                      </div>
                      <div className="text-xs text-muted">
                        {labelKo("episode_status", v.stage)} 단계 · {v.charCountWithSpaces.toLocaleString("ko-KR")}자 · <span title={formatDateTime(v.createdAt, tz)}>{formatRelative(v.createdAt)}</span>
                        {v.modelId && <span className="text-faint"> · {v.modelId}</span>}
                      </div>
                    </button>
                  </ListItem>
                ))}
            </List>
          )
        }
      </QueryView>
      <p className="mb-0 mt-2 text-[11.5px] text-faint">버전마다 작성 주체가 기록됩니다. 버전 비교 탭에서 임의의 두 버전을 비교할 수 있습니다.</p>
    </Card>
  );
}

function jumpTo(id: string) {
  document.getElementById(markerDomId(id))?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function IssuesCard({ detail }: { detail: VersionDetail }) {
  if (detail.issues === null) {
    return (
      <Card title="연속성 이슈">
        <NotReady compact />
      </Card>
    );
  }
  const issues = [...detail.issues].sort(issueSort);
  const open = issues.filter((i) => i.status === "open" || i.status === "fixing");
  const highOpen = open.filter((i) => i.severity === "high").length;
  return (
    <Card title="연속성 이슈" actions={<span className="text-xs text-muted">열림 {open.length}건</span>}>
      {issues.length === 0 ? (
        <InlineStatus>이 버전에 기록된 이슈가 없습니다.</InlineStatus>
      ) : (
        <List>
          {issues.map((i) => (
            <IssueItem key={i.id} issue={i} detail={detail} />
          ))}
        </List>
      )}
      {highOpen > 0 && (
        <p className="mb-0 mt-2 text-xs text-danger">
          높음 이슈가 열려 있어 승인 대기로 넘어가지 않습니다.
        </p>
      )}
    </Card>
  );
}

function IssueItem({ issue, detail }: { issue: IssueAnnotation; detail: VersionDetail }) {
  const loc = issue.charStart != null ? describeLocation(detail.content, issue.charStart, detail.scenes ?? []) : null;
  return (
    <Block id={`side-${issue.id}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge enum="issue_severity" value={issue.severity} />
        <b className="text-[12.5px]">{issue.displayLabel}</b>
        <StatusBadge enum="continuity_issue_status" value={issue.status} />
      </div>
      <p className="my-1 text-[13px]">{issue.message}</p>
      <div className="text-xs text-muted">유형: {labelKo("continuity_issue_kind", issue.kind)}</div>
      {issue.proposedFix && <div className="text-xs text-muted">제안: {issue.proposedFix}</div>}
      {loc ? (
        <button type="button" className="mt-1 text-xs font-semibold text-accent underline" onClick={() => jumpTo(issue.id)}>
          원고 위치 → {loc.sceneOrd ? `씬${loc.sceneOrd}, ` : ""}
          {loc.paragraph}번째 문단
        </button>
      ) : (
        <div className="mt-1 text-xs text-faint">화 단위 이슈</div>
      )}
    </Block>
  );
}

function BeatsCard({ detail, setupLabel, setupTitle, novelId }: { detail: VersionDetail; setupLabel: (id: string) => string; setupTitle: (id: string) => string | undefined; novelId: string }) {
  if (detail.beats === null) {
    return (
      <Card title="떡밥 비트">
        <NotReady compact />
      </Card>
    );
  }
  const beats = [...detail.beats].sort(beatSort);
  const by = (k: string) => beats.filter((b) => b.kind === k).length;
  return (
    <Card title="떡밥 비트" actions={<span className="text-xs text-muted">설치 {by("plant")} · 강화 {by("reinforce")} · 회수 {by("payoff")}</span>}>
      {beats.length === 0 ? (
        <InlineStatus>이 버전에 배정된 비트가 없습니다.</InlineStatus>
      ) : (
        <List>
          {beats.map((b) => (
            <BeatItem key={b.id} beat={b} detail={detail} label={setupLabel(b.setupId)} title={setupTitle(b.setupId)} novelId={novelId} />
          ))}
        </List>
      )}
    </Card>
  );
}

function BeatItem({ beat, detail, label, title, novelId }: { beat: BeatAnnotation; detail: VersionDetail; label: string; title?: string; novelId: string }) {
  const loc = beat.charStart != null ? describeLocation(detail.content, beat.charStart, detail.scenes ?? []) : null;
  const setupNo = label.startsWith("S-") ? label : beat.setupId;
  return (
    <Block id={`side-${beat.id}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
        <Link to={`/novels/${novelId}/setups/${encodeURIComponent(setupNo)}`} className="font-semibold underline">
          {label}
        </Link>
        {title && <span>{title}</span>}
        <Badge tone="violet">{labelKo("setup_beat_kind", beat.kind)}</Badge>
        <StatusBadge enum="setup_beat_status" value={beat.status} />
      </div>
      {loc ? (
        <button type="button" className="mt-1 text-xs font-semibold text-accent underline" onClick={() => jumpTo(beat.id)}>
          근거 → {loc.sceneOrd ? `씬${loc.sceneOrd}, ` : ""}
          {loc.paragraph}번째 문단
        </button>
      ) : (
        <div className="mt-1 text-xs text-faint">{beat.plannedNote ?? "위치 미확정"}</div>
      )}
    </Block>
  );
}

function RejectionsCard({ novelId, episodeNo, count, tz }: { novelId: string; episodeNo: number; count: number; tz?: string }) {
  const q = useRejections(novelId, episodeNo);
  if (count === 0) return null;
  return (
    <Card title={`반려·수정 요청 ${count}회`}>
      <QueryView query={q} compact>
        {(items) => (
          <List>
            {items.map((r) => (
              <Block key={r.id}>
                <div className="flex items-center gap-1.5 text-xs text-muted">
                  <b className="text-text">#{r.rejectionNo}</b>
                  {labelKo("rework_from", r.reworkFrom)} · {formatDateTime(r.createdAt, tz)}
                </div>
                <p className="m-0 mt-0.5 text-[13px]">{r.reason}</p>
              </Block>
            ))}
          </List>
        )}
      </QueryView>
    </Card>
  );
}

function Block({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <ListItem id={id} className="scroll-mt-24">
      <div className="min-w-0 flex-1">{children}</div>
    </ListItem>
  );
}
