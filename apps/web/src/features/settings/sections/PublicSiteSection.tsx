import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PUBLIC_SITE_SLUG_RE, publicSiteNovelDtoSchema, publicSiteStatusDtoSchema, type PublicSiteNovelDto, type UpdatePublicSiteNovelRequest } from "@ncs/shared";
import { api, errorMessage } from "../../../api/client.js";
import { queryKeys } from "../../../api/query-keys.js";
import { Button, Callout, Card, Checkbox, Field, Input, QueryView, Textarea } from "../../../components/ui/index.js";

/**
 * 설계 추가 0021: 공개 사이트 (GET/PATCH /api/novels/:id/public-site, GET /api/public-site, POST /api/public-site/build).
 * 켜진 작품의 "공개된 화"만 정적 JSON으로 내보내고, 독자용 앱(apps/public-reader)이 그 파일만 읽습니다.
 * 이 화면은 파일을 만들 뿐 인터넷에 노출하지 않습니다(배포는 README의 수동 단계).
 */
const siteKey = [...queryKeys.installSettings, "public-site"] as const;
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

function PublicSiteForm({ novelId, settings }: { novelId: string; settings: PublicSiteNovelDto }) {
  const qc = useQueryClient();
  const status = usePublicSiteStatus();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [slug, setSlug] = useState(settings.slug ?? "");
  const [intro, setIntro] = useState(settings.intro);
  const [authorName, setAuthorName] = useState(settings.authorName);
  const save = useMutation({
    mutationFn: (body: UpdatePublicSiteNovelRequest) => api.patch(`/novels/${novelId}/public-site`, body, { schema: publicSiteNovelDtoSchema }),
    onSuccess: (d) => {
      qc.setQueryData(novelKey(novelId), d);
      void qc.invalidateQueries({ queryKey: siteKey });
    },
  });
  const rebuild = useMutation({
    mutationFn: () => api.post("/public-site/build", undefined, { schema: publicSiteStatusDtoSchema }),
    onSuccess: (d) => qc.setQueryData(siteKey, d),
  });
  const slugTrim = slug.trim().toLowerCase();
  const slugValid = slugTrim === "" || (PUBLIC_SITE_SLUG_RE.test(slugTrim) && !slugTrim.includes("--"));
  const patch: UpdatePublicSiteNovelRequest = {
    ...(enabled !== settings.enabled ? { enabled } : {}),
    ...(slugTrim !== (settings.slug ?? "") ? { slug: slugTrim || null } : {}),
    ...(intro !== settings.intro ? { intro } : {}),
    ...(authorName.trim() !== settings.authorName ? { authorName: authorName.trim() } : {}),
  };
  const dirty = Object.keys(patch).length > 0;
  const blocked = !slugValid || (enabled && !slugTrim) || intro.length > 2000 || authorName.trim().length > 40;
  const s = status.data;
  return (
    <div className="flex flex-col gap-3">
      <Checkbox
        label="공개 사이트에 노출"
        hint={`켜면 이 작품의 공개된 화(지금 ${settings.publishedEpisodeCount}개)만 독자용 읽기 사이트 파일로 내보냅니다. 초안·승인 대기·승인만 된 화와 기획·설정 자료는 나가지 않습니다.`}
        checked={enabled}
        onChange={(e) => setEnabled(e.target.checked)}
      />
      <Field label="공개 주소" hint="독자 사이트 주소의 작품 부분입니다(예: /novels/my-story). 영문 소문자·숫자·하이픈, 1~64자." error={slugValid ? (enabled && !slugTrim ? "노출하려면 공개 주소를 정해 주세요." : undefined) : "영문 소문자·숫자·하이픈(-)만, 하이픈으로 시작·끝나거나 연달아 쓸 수 없습니다."}>
        <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="my-story" autoCapitalize="off" autoCorrect="off" spellCheck={false} className="max-w-72" />
      </Field>
      <Field label="작가 표시 이름" hint="독자 사이트에 보이는 이름입니다(비워 두면 표시하지 않음, 40자 이내).">
        <Input value={authorName} maxLength={40} onChange={(e) => setAuthorName(e.target.value)} className="max-w-72" />
      </Field>
      <Field label="공개 소개" hint={`작품 홈과 검색 결과 설명에 쓰입니다. 독자에게 그대로 보이니 스포일러·내부 메모는 넣지 마세요. (${intro.length}/2000)`}>
        <Textarea value={intro} rows={4} maxLength={2000} onChange={(e) => setIntro(e.target.value)} />
      </Field>
      {save.error && <Callout tone="danger">{errorMessage(save.error)}</Callout>}
      {save.isSuccess && !dirty && <Callout tone="ok">저장했습니다. 공개 사이트 파일도 다시 만들었습니다.</Callout>}
      <div className="flex justify-end">
        <Button variant="primary" disabled={!dirty || blocked} loading={save.isPending} onClick={() => save.mutate(patch)}>
          변경 저장
        </Button>
      </div>
      <div className="flex flex-col gap-1 border-t border-border pt-3 text-xs text-muted">
        <span>
          출력 폴더: <code className="break-all">{s?.outputDir ?? "…"}</code>
        </span>
        <span>
          마지막 생성: {s?.lastBuiltAt ? new Date(s.lastBuiltAt).toLocaleString("ko-KR") : "아직 없음"}
          {s ? ` · 작품 ${s.novelCount}개 · 공개된 화 ${s.episodeCount}개` : ""}
        </span>
        {s?.lastError && <Callout tone="danger">{s.lastError}</Callout>}
        {rebuild.error && <Callout tone="danger">{errorMessage(rebuild.error)}</Callout>}
        <p className="m-0 text-faint">이 폴더를 독자용 앱(apps/public-reader)이 읽습니다. 인터넷에 공개하는 일(호스팅·포트 개방)은 직접 결정해서 따로 해야 합니다.</p>
        <div className="flex justify-end">
          <Button loading={rebuild.isPending} onClick={() => rebuild.mutate()}>
            공개 사이트 다시 만들기
          </Button>
        </div>
      </div>
    </div>
  );
}
