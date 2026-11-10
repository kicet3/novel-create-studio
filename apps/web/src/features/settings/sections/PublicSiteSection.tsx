import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { publicSiteNovelDtoSchema, publicSiteStatusDtoSchema, type PublicSiteNovelDto, type UpdatePublicSiteNovelRequest } from "@ncs/shared";
import { api, errorMessage } from "../../../api/client.js";
import { queryKeys } from "../../../api/query-keys.js";
import { Badge, Button, Callout, Card, Field, QueryView, Textarea } from "../../../components/ui/index.js";
import { publicSiteStatusKey } from "./PublicSiteConnectionCard.js";

/**
 * 설계 추가 0021/0022/0025: 공개 사이트 (GET/PATCH /api/novels/:id/public-site, GET /api/public-site, POST /api/public-site/build).
 * 노출 켜기는 없습니다: 보관되지 않은 작품에 공개된 화가 하나라도 있으면 자동으로 공개 사이트(snowpage)에 오릅니다.
 * 공개 주소는 작품 id(소문자), 작가 표시 이름은 "새벽눈길" 고정이고, 여기서는 공개 소개만 고칩니다.
 * 연결 문자열·대상·제한 역할 SQL은 설치 설정 → 공개 사이트(snowpage)에서 다룹니다.
 */
const siteKey = publicSiteStatusKey;
const novelKey = (novelId: string) => [...queryKeys.novel(novelId).settings(), "public-site"] as const;

function usePublicSiteStatus() {
  return useQuery({ queryKey: siteKey, queryFn: ({ signal }) => api.get("/public-site", { schema: publicSiteStatusDtoSchema, signal }) });
}

export function PublicSiteSection({ novelId }: { novelId: string }) {
  const q = useQuery({ queryKey: novelKey(novelId), queryFn: ({ signal }) => api.get(`/novels/${novelId}/public-site`, { schema: publicSiteNovelDtoSchema, signal }) });
  return (
    <Card title="공개 사이트">
      <QueryView query={q}>{(s) => <PublicSiteForm key={s.updatedAt ?? "new"} novelId={novelId} settings={s} />}</QueryView>
    </Card>
  );
}

function exposureNote(s: PublicSiteNovelDto): string {
  if (s.archived) return "보관된 작품이라 공개 사이트에 올리지 않습니다.";
  if (s.publishedEpisodeCount === 0) return "아직 공개된 화가 없어 공개 사이트 목록에 보이지 않습니다. 첫 화를 공개하면 자동으로 올라갑니다.";
  return "공개된 화만 자동으로 공개 사이트에 올라갑니다. 마지막 공개 화를 내리면 작품도 목록에서 빠집니다.";
}

function PublicSiteForm({ novelId, settings }: { novelId: string; settings: PublicSiteNovelDto }) {
  const qc = useQueryClient();
  const status = usePublicSiteStatus();
  const [intro, setIntro] = useState(settings.intro);
  const [copied, setCopied] = useState(false);
  const save = useMutation({
    mutationFn: (body: UpdatePublicSiteNovelRequest) => api.patch(`/novels/${novelId}/public-site`, body, { schema: publicSiteNovelDtoSchema }),
    onSuccess: (d) => {
      qc.setQueryData(novelKey(novelId), d);
      void qc.invalidateQueries({ queryKey: siteKey });
    },
  });
  const rebuild = useMutation({
    mutationFn: () => api.post("/public-site/build", undefined, { schema: publicSiteStatusDtoSchema }),
    onSuccess: (d) => {
      qc.setQueryData(siteKey, d);
      void qc.invalidateQueries({ queryKey: novelKey(novelId) });
    },
  });
  const dirty = intro !== settings.intro;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(settings.publicUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const s = status.data;
  const syncedAt = s?.lastBuiltAt ?? settings.lastSyncedAt;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={settings.exposed ? "ok" : "neutral"}>{settings.exposed ? "공개 중" : "목록에 없음"}</Badge>
        <span className="text-muted">
          공개된 화 {settings.publishedEpisodeCount}개 · 마지막 동기화 {syncedAt ? new Date(syncedAt).toLocaleString("ko-KR") : "아직 없음"}
        </span>
      </div>
      <p className="m-0 text-xs text-muted">{exposureNote(settings)} 초안·승인 대기·승인만 된 화와 기획·설정 자료는 나가지 않습니다.</p>
      <Field label="공개 주소" hint="작품 id로 정해지며 바꿀 수 없습니다. 작가 표시 이름은 「새벽눈길」로 고정입니다.">
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all rounded border border-border px-2 py-1 text-xs">{settings.publicUrl}</code>
          <Button size="sm" onClick={() => void copy()}>
            {copied ? "복사했습니다" : "주소 복사"}
          </Button>
        </div>
      </Field>
      <Field label="공개 소개" hint={`작품 홈과 검색 결과 설명에 쓰입니다. 독자에게 그대로 보이니 스포일러·내부 메모는 넣지 마세요. (${intro.length}/2000)`}>
        <Textarea value={intro} rows={4} maxLength={2000} onChange={(e) => setIntro(e.target.value)} />
      </Field>
      {save.error && <Callout tone="danger">{errorMessage(save.error)}</Callout>}
      {save.isSuccess && !dirty && <Callout tone="ok">저장했습니다. 공개 사이트도 다시 맞췄습니다.</Callout>}
      <div className="flex justify-end">
        <Button variant="primary" disabled={!dirty || intro.length > 2000} loading={save.isPending} onClick={() => save.mutate({ intro })}>
          변경 저장
        </Button>
      </div>
      <div className="flex flex-col gap-1 border-t border-border pt-3 text-xs text-muted">
        <span>
          내보낼 곳: {s ? (s.target === "supabase" ? `Supabase 공개 스키마 ${s.supabase.schema}` : "정적 파일(오프라인·개발용)") : "…"}
          {s ? ` · 전체 작품 ${s.novelCount}개 · 공개된 화 ${s.episodeCount}개` : ""}
        </span>
        {s?.lastError && <Callout tone="danger">{s.lastError}</Callout>}
        {rebuild.error && <Callout tone="danger">{errorMessage(rebuild.error)}</Callout>}
        <p className="m-0 text-faint">연결 문자열·내보낼 곳·독자 사이트용 제한 역할 SQL은 설치 설정 → 공개 사이트(snowpage)에서 정합니다.</p>
        <div className="flex justify-end">
          <Button loading={rebuild.isPending} onClick={() => rebuild.mutate()}>
            지금 동기화
          </Button>
        </div>
      </div>
    </div>
  );
}
