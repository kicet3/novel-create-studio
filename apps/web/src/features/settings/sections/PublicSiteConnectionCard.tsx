import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PUBLIC_SITE_SCHEMA_RE,
  publicSiteCheckDtoSchema,
  publicSiteRoleSqlDtoSchema,
  publicSiteStatusDtoSchema,
  type PublicSiteStatusDto,
  type PublicSiteTarget,
  type UpdatePublicSiteConfigRequest,
} from "@ncs/shared";
import { api, errorMessage } from "../../../api/client.js";
import { queryKeys } from "../../../api/query-keys.js";
import { Badge, Button, Callout, Card, Field, Input, QueryView, Select } from "../../../components/ui/index.js";

/**
 * 설치 설정 → 공개 사이트(snowpage) 연결 (GET /api/public-site, PUT /api/public-site/config, POST …/build, POST …/check,
 * GET …/role-sql). 쓰기용 연결 문자열과 snowpage 운영 토큰(ADMIN_TOKEN)은 비밀 저장소에 암호화해 두고 다시 보여 주지
 * 않습니다(“설정됨”만 표시). 공개된 화만 Supabase 공개 스키마로 나가며, 초안·설정·비밀은 이 컴퓨터를 떠나지 않습니다.
 * 운영 토큰이 있으면 동기화 직후 독자 페이지 캐시를 바로 비웁니다(status.revalidate).
 */
export const publicSiteStatusKey = [...queryKeys.installSettings, "public-site"] as const;

export function PublicSiteConnectionCard() {
  const q = useQuery({ queryKey: publicSiteStatusKey, queryFn: ({ signal }) => api.get("/public-site", { schema: publicSiteStatusDtoSchema, signal }) });
  return (
    <Card title="공개 사이트 (snowpage)">
      <QueryView query={q}>{(s) => <PublicSiteConnection status={s} />}</QueryView>
    </Card>
  );
}

const TARGET_LABEL: Record<PublicSiteTarget, string> = { supabase: "Supabase DB (Vercel 독자 사이트)", files: "정적 파일(오프라인·개발용)" };

function PublicSiteConnection({ status: s }: { status: PublicSiteStatusDto }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [schema, setSchema] = useState(s.supabase.schema);
  const [target, setTarget] = useState<"" | PublicSiteTarget>(s.targetSource === "explicit" ? s.target : "");
  const [showSql, setShowSql] = useState(false);
  const [copied, setCopied] = useState(false);
  const setStatus = (d: PublicSiteStatusDto) => qc.setQueryData(publicSiteStatusKey, d);
  const save = useMutation({
    mutationFn: (body: UpdatePublicSiteConfigRequest) => api.put("/public-site/config", body, { schema: publicSiteStatusDtoSchema }),
    onSuccess: (d) => {
      setStatus(d);
      setUrl("");
      setAdminToken("");
    },
  });
  const sync = useMutation({ mutationFn: () => api.post("/public-site/build", undefined, { schema: publicSiteStatusDtoSchema }), onSuccess: setStatus });
  const check = useMutation({ mutationFn: () => api.post("/public-site/check", undefined, { schema: publicSiteCheckDtoSchema }) });
  const roleSql = useQuery({
    queryKey: [...publicSiteStatusKey, "role-sql", s.supabase.schema],
    queryFn: ({ signal }) => api.get("/public-site/role-sql", { schema: publicSiteRoleSqlDtoSchema, signal }),
    enabled: showSql,
  });

  const urlTrim = url.trim();
  const urlValid = urlTrim === "" || /^postgres(ql)?:\/\/\S+$/.test(urlTrim);
  const tokenTrim = adminToken.trim();
  const tokenValid = tokenTrim === "" || (tokenTrim.length >= 24 && /^\S+$/.test(tokenTrim));
  const schemaValid = PUBLIC_SITE_SCHEMA_RE.test(schema.trim());
  const patch: UpdatePublicSiteConfigRequest = {
    ...(urlTrim ? { databaseUrl: urlTrim } : {}),
    ...(tokenTrim ? { adminToken: tokenTrim } : {}),
    ...(schema.trim() !== s.supabase.schema ? { schema: schema.trim() } : {}),
    ...((target || null) !== (s.targetSource === "explicit" ? s.target : null) ? { target: target || null } : {}),
  };
  const dirty = Object.keys(patch).length > 0;
  /** which of the two "지우기" buttons (or the main save) is in flight */
  const clearing = save.isPending ? (save.variables?.databaseUrl === null ? "url" : save.variables?.adminToken === null ? "token" : "save") : null;
  const rv = s.revalidate;
  const copy = async () => {
    if (!roleSql.data) return;
    try {
      await navigator.clipboard.writeText(roleSql.data.sql);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-xs text-muted">
        스튜디오(이 컴퓨터)에서 쓰고, 공개 독자 사이트는 공개된 화만 받아서 보여 줍니다. 작품마다 <strong>공개된 화</strong>만 Supabase 공개 스키마로 자동 동기화하며(공개된 화가 있는 작품만 목록에 오르고, 작가 이름은 새벽눈길), 초안·설정 자료·비밀은 보내지 않습니다.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={s.target === "supabase" ? "info" : "neutral"}>지금 대상: {TARGET_LABEL[s.target]}</Badge>
        <Badge tone={s.supabase.configured ? "ok" : "warn"}>{s.supabase.configured ? "연결 문자열 설정됨" : "연결 문자열 없음"}</Badge>
        <Badge tone={rv.configured ? "ok" : "neutral"}>{rv.configured ? "운영 토큰 설정됨" : "운영 토큰 없음"}</Badge>
        {s.supabase.host && <span className="text-muted">호스트 {s.supabase.host}</span>}
      </div>
      <Field
        label="Supabase 쓰기 연결 문자열"
        hint="Supabase → Project Settings → Database → Connection string(Transaction pooler, 포트 6543 권장)의 postgres 사용자 URL입니다. 암호화해 저장하고 다시 보여 주지 않습니다. 비워 두면 그대로 둡니다."
        error={urlValid ? undefined : "postgresql:// 로 시작하는 연결 문자열을 넣어 주세요."}
      >
        <Input
          type="password"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={s.supabase.configured ? "설정됨 — 바꿀 때만 입력" : "postgresql://postgres.xxxx:비밀번호@…pooler.supabase.com:6543/postgres"}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field
        label="snowpage 운영 토큰(ADMIN_TOKEN)"
        hint="공개 사이트 Vercel 환경 변수 ADMIN_TOKEN 과 같은 값. 공개·공개 취소 직후 독자 페이지 캐시를 바로 비우는 데 씁니다. 비우면 최대 30초 뒤에 반영됩니다."
        error={tokenValid ? undefined : "운영 토큰은 공백 없이 24자 이상이어야 합니다."}
      >
        <Input
          type="password"
          value={adminToken}
          onChange={(e) => setAdminToken(e.target.value)}
          placeholder={rv.configured ? "설정됨 — 바꿀 때만 입력" : "Vercel의 ADMIN_TOKEN 값(24자 이상)"}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 min-[521px]:grid-cols-2">
        <Field label="공개 스키마" hint="이 스키마 안에만 테이블을 만들고 씁니다(기본 ncs_public). public·auth·storage 등은 쓸 수 없습니다." error={schemaValid ? undefined : "영문 소문자·숫자·밑줄(_), 63자 이내"}>
          <Input value={schema} onChange={(e) => setSchema(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </Field>
        <Field label="내보낼 곳" hint="기본값: 연결 문자열이 있으면 Supabase, 없으면 정적 파일.">
          <Select value={target} onChange={(e) => setTarget(e.target.value as "" | PublicSiteTarget)}>
            <option value="">기본값</option>
            <option value="supabase">{TARGET_LABEL.supabase}</option>
            <option value="files">{TARGET_LABEL.files}</option>
          </Select>
        </Field>
      </div>
      {save.error && <Callout tone="danger">{errorMessage(save.error)}</Callout>}
      <div className="flex flex-wrap justify-end gap-2">
        {s.supabase.configured && (
          <Button variant="ghost" loading={clearing === "url"} onClick={() => window.confirm("저장된 연결 문자열을 지울까요?") && save.mutate({ databaseUrl: null })}>
            연결 문자열 지우기
          </Button>
        )}
        {rv.configured && (
          <Button variant="ghost" loading={clearing === "token"} onClick={() => window.confirm("저장된 운영 토큰을 지울까요? 공개 직후 캐시 갱신이 꺼지고 최대 30초 뒤에 반영됩니다.") && save.mutate({ adminToken: null })}>
            운영 토큰 지우기
          </Button>
        )}
        <Button variant="primary" disabled={!dirty || !urlValid || !tokenValid || !schemaValid} loading={clearing === "save"} onClick={() => save.mutate(patch)}>
          저장
        </Button>
      </div>

      <div className="flex flex-col gap-1 border-t border-border pt-3 text-xs text-muted">
        <span>
          마지막 동기화: {s.lastBuiltAt ? new Date(s.lastBuiltAt).toLocaleString("ko-KR") : "아직 없음"} · 작품 {s.novelCount}개 · 공개된 화 {s.episodeCount}개
          {s.target === "supabase" && s.supabase.schemaVersion !== null ? ` · 스키마 버전 ${s.supabase.schemaVersion}/${s.supabase.latestSchemaVersion}` : ""}
        </span>
        {s.lastRun && (
          <span>
            지난 실행: 작품 갱신 {s.lastRun.upsertedNovels} · 화 갱신 {s.lastRun.upsertedEpisodes} · 작품 삭제 {s.lastRun.deletedNovels} · 화 삭제 {s.lastRun.deletedEpisodes} · 그대로 {s.lastRun.unchangedNovels}
          </span>
        )}
        {rv.configured && (
          <span>
            마지막 캐시 갱신: {rv.lastAt ? new Date(rv.lastAt).toLocaleString("ko-KR") : "아직 없음"}
            {rv.lastOk !== null ? ` · ${rv.lastOk ? "성공" : "실패"}` : ""}
            {rv.lastMessage ? ` · ${rv.lastMessage}` : ""}
          </span>
        )}
        {s.target === "files" && (
          <span>
            출력 폴더: <code className="break-all">{s.outputDir}</code>
          </span>
        )}
        {s.lastError && <Callout tone="danger">{s.lastError}</Callout>}
        {sync.error && <Callout tone="danger">{errorMessage(sync.error)}</Callout>}
        {check.data && <Callout tone={check.data.ok ? "ok" : "danger"}>{check.data.message}</Callout>}
        {check.error && <Callout tone="danger">{errorMessage(check.error)}</Callout>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={!s.supabase.configured} loading={check.isPending} onClick={() => check.mutate()}>
            연결 확인
          </Button>
          <Button loading={sync.isPending} onClick={() => sync.mutate()}>
            지금 동기화
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-3 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className="text-[13px]">독자 사이트용 제한 역할 SQL</strong>
          <Button size="sm" variant="ghost" onClick={() => setShowSql((v) => !v)}>
            {showSql ? "접기" : "SQL 보기"}
          </Button>
        </div>
        <p className="m-0 text-muted">
          Vercel 독자 사이트는 postgres 사용자가 아니라 이 스키마만 다루는 제한 역할(ncs_public_reader)로 접속합니다. [지금 동기화]로 스키마를 만든 뒤, 아래 SQL의 &lt;직접 입력&gt;을 긴 무작위 비밀번호로 바꿔 Supabase SQL Editor에서 직접 실행하세요. 스튜디오는 이 SQL을 실행하지 않습니다. 이 스키마는 Supabase Data API의 Exposed schemas에 넣지 마세요.
        </p>
        {showSql && roleSql.error && <Callout tone="danger">{errorMessage(roleSql.error)}</Callout>}
        {showSql && roleSql.data && (
          <>
            <pre className="m-0 max-h-80 overflow-auto rounded-md bg-surface-2 p-2 text-[11.5px] leading-[1.5]">{roleSql.data.sql}</pre>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void copy()}>
                {copied ? "복사했습니다" : "SQL 복사"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
