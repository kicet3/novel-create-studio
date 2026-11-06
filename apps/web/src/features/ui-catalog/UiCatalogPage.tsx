import { useState } from "react";
import type { EnumValue } from "@ncs/shared";
import { PageHeader } from "../../components/layout/PageHeader.js";
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  Chip,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Grid,
  Input,
  KeyValueList,
  KpiCard,
  List,
  ListItem,
  Progress,
  ReqTag,
  Select,
  Split,
  StatusBadge,
  Tabs,
  Textarea,
  type Column,
} from "../../components/ui/index.js";

interface SampleTask {
  no: string;
  kind: string;
  role: string;
  status: EnumValue<"task_status">;
}

const TASKS: SampleTask[] = [
  { no: "T-41", kind: "초고 작성", role: "writer", status: "running" },
  { no: "T-42", kind: "연속성 검사", role: "continuity_editor", status: "blocked" },
  { no: "T-39", kind: "아웃라인", role: "planner", status: "done" },
];

const COLUMNS: Column<SampleTask>[] = [
  { key: "no", header: "번호", cell: (t) => <span className="mono">{t.no}</span>, rowHeader: true },
  { key: "kind", header: "작업", cell: (t) => t.kind },
  { key: "role", header: "담당", cell: (t) => <code>{t.role}</code> },
  { key: "status", header: "상태", cell: (t) => <StatusBadge enum="task_status" value={t.status} /> },
];

/** `/dev/ui` — living catalog of the design system (sample data from docs/mockups-src/SPEC.md). */
export function UiCatalogPage() {
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="컴포넌트 카탈로그"
        subtitle="apps/web/src/components/ui — 목업 base.css 토큰과 컴포넌트를 옮긴 것"
        actions={
          <>
            <Badge tone="accent">
              자율성 <code>episode_approval</code>
            </Badge>
            <Button size="sm">작품 일시정지</Button>
          </>
        }
      />

      <Callout tone="danger" title="Telegram 연결 끊김 · 봇 토큰 폐기" actions={<Button size="sm" variant="primary">채널 다시 연결</Button>}>
        대기 질문 3건은 대기열에 유지됩니다. 웹 인박스에서 바로 답할 수 있습니다.
      </Callout>

      <Grid cols={4}>
        <KpiCard label="목표 진척 (승인 대기 포함)" value="11" of="/ 120화" delta="공개 처리 8화">
          <Progress value={11} max={120} label="목표 진척" valueText="11 / 120화" />
        </KpiCard>
        <KpiCard label="비축분" value="3" of="/ 목표 5화" delta="목표 대비 −2">
          <Progress value={3} max={5} tone="warn" label="비축분" valueText="3 / 5화" />
        </KpiCard>
        <KpiCard label="이번 달 비용" value="$41.20" of="/ $80" delta="52% · 화당 평균 $1.62">
          <Progress value={52} tone="ok" label="예산 소진율" valueText="52%" />
        </KpiCard>
        <KpiCard label="대기 질문" value="3" delta="차단형 1 · 마감 오늘 21:00" />
      </Grid>

      <Split>
        <Card title="배지 · 상태" actions={<ReqTag>FR-UI-03</ReqTag>}>
          <div className="flex flex-wrap gap-1.5">
            {(["neutral", "ok", "warn", "danger", "info", "accent", "violet"] as const).map((t) => (
              <Badge key={t} tone={t} glyph>
                {t}
              </Badge>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <StatusBadge enum="episode_status" value="awaiting_approval" />
            <StatusBadge enum="episode_status" value="published" />
            <StatusBadge enum="question_grade" value="blocking" />
            <StatusBadge enum="canon_status" value="candidate" />
            <StatusBadge enum="setup_narrative_status" value="planted" />
            <StatusBadge enum="issue_severity" value="high" />
            <Chip>S-01 도현 손목의 흉터</Chip>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button>기본</Button>
            <Button variant="primary">승인</Button>
            <Button variant="danger">반려</Button>
            <Button variant="ghost">취소</Button>
            <Button size="sm" loading>
              저장 중
            </Button>
          </div>
        </Card>
        <Card title="키·값">
          <KeyValueList
            items={[
              { key: "goal", label: "목표", value: "120화 · 하루 1화" },
              { key: "len", label: "분량 프로필", value: "기본(공백 포함 5,000~5,500자)" },
              { key: "auto", label: "자율성", value: <StatusBadge enum="autonomy_level" value="episode_approval" />, hint: "화별 승인" },
            ]}
          />
        </Card>
      </Split>

      <Tabs
        label="예시 탭"
        items={[
          { value: "table", label: "표", panel: <DataTable label="작업 목록" columns={COLUMNS} rows={TASKS} rowKey={(t) => t.no} /> },
          {
            value: "list",
            label: "목록",
            adornment: <Badge>3</Badge>,
            panel: (
              <Card>
                <List>
                  <ListItem>
                    <Avatar initials="W" label="writer" />
                    <div>12화 씬2 초고 작성 중</div>
                  </ListItem>
                  <ListItem>
                    <Avatar initials="C" label="continuity_editor" />
                    <div>11화 연속성 이슈 1건 (중간)</div>
                  </ListItem>
                </List>
              </Card>
            ),
          },
          {
            value: "form",
            label: "입력",
            panel: (
              <Card className="flex flex-col gap-3">
                <Field label="작품 제목" required hint="나중에 컨셉 승인 때 바꿀 수 있습니다">
                  <Input placeholder="회귀자의 흉터" />
                </Field>
                <Field label="자율성 수준">
                  <Select defaultValue="episode_approval">
                    <option value="episode_approval">화별 승인</option>
                    <option value="arc_approval">아크별 승인</option>
                  </Select>
                </Field>
                <Field label="반려 사유" error="사유를 입력하세요">
                  <Textarea />
                </Field>
              </Card>
            ),
          },
          { value: "empty", label: "빈 상태", panel: <EmptyState title="열린 연속성 이슈가 없습니다" description="새 이슈가 생기면 여기에 표시됩니다." /> },
        ]}
      />

      <div className="flex gap-2">
        <Button onClick={() => setDialog(true)}>대화 상자 열기</Button>
        <Button variant="primary" onClick={() => setConfirm(true)}>
          11화 승인…
        </Button>
      </div>
      <Dialog open={dialog} onClose={() => setDialog(false)} title="일시정지 안내" description="진행 중 실행은 안전 지점에서 멈춥니다.">
        <p className="m-0 text-[13px]">작품 단위로 모든 작업을 멈춥니다.</p>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        title="11화를 승인할까요?"
        description="승인하면 비축분에 포함되고 예정 시각에 공개 처리됩니다."
        confirmLabel="승인"
        onConfirm={() => setConfirm(false)}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
