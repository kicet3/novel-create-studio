/** Settings data hooks (install + novel scope). Endpoints per CONVENTIONS §13; 501 → "준비 중" in the UI. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  backupRecordDtoSchema,
  backupScheduleDtoSchema,
  budgetOverviewSchema,
  budgetPolicyDtoSchema,
  healthCheckResultDtoSchema,
  llmAvailableModelsSchema,
  llmProviderProfileDtoSchema,
  llmTestResponseSchema,
  roleModelDefaultListSchema,
  type AgentRole,
  type LlmAddModelRequest,
  type LlmCallProviderId,
  type LlmEditModelRequest,
  type UpdateRoleModelDefaultsRequest,
  providerOAuthSessionDtoSchema,
  providerStatusDtoSchema,
  type LlmProviderId,
  type ProviderConnectionMethod,
  type ProviderStatusDto,
  messagingBindingTokenDtoSchema,
  messagingBotDtoSchema,
  messagingChannelDtoSchema,
  notificationPolicyDtoSchema,
  lengthProfileDtoSchema,
  roleModelBindingDtoSchema,
  secretMetaDtoSchema,
  systemInfoDtoSchema,
  type BackupRecordDto,
  type BackupScheduleDto,
  type BudgetCategory,
  type BudgetPolicyPatchDto,
  type HealthCheckKind,
  type HealthCheckResultDto,
  type LlmTestRequest,
  type MessagingRegisterBotRequest,
  type UpdateLengthProfileRequest,
  type UpdateNotificationPolicyRequest,
  type UpdateRoleModelBindingRequest,
} from "@ncs/shared";
import { api } from "../../api/client.js";
import { queryKeys } from "../../api/query-keys.js";
import { listOf, normalizeList, useInvalidateNovel } from "../novels/api.js";

const INSTALL = queryKeys.installSettings;
const nk = (novelId: string, ...rest: string[]) => [...queryKeys.novel(novelId).settings(), ...rest] as const;

// ── install scope ────────────────────────────────────────────────────────
export function useSystemInfo() {
  return useQuery({ queryKey: [...INSTALL, "info"], queryFn: ({ signal }) => api.get("/system/info", { schema: systemInfoDtoSchema, signal }) });
}

export interface HealthChecksData {
  checks: Array<{ kind: string; scope?: string; label?: string; name?: string }>;
  items: HealthCheckResultDto[];
}

function parseHealth(d: unknown): HealthChecksData {
  const o = (d && typeof d === "object" ? d : {}) as { checks?: unknown; items?: unknown };
  return {
    checks: Array.isArray(o.checks) ? (o.checks as HealthChecksData["checks"]) : [],
    items: normalizeList(o.items ?? d, healthCheckResultDtoSchema),
  };
}

/** Install-level (`/api/system/health-checks`) or novel-level (`…/health-checks`) latest results. */
export function useHealthChecks(novelId?: string) {
  return useQuery({
    queryKey: novelId ? nk(novelId, "health") : [...INSTALL, "health"],
    queryFn: ({ signal }) => api.get(novelId ? `/novels/${novelId}/health-checks` : "/system/health-checks", { signal }).then(parseHealth),
  });
}

export function useRunHealthChecks(novelId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kinds?: HealthCheckKind[]) => api.post("/system/health-checks/run", { kinds, novelId }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [...INSTALL, "health"] });
      if (novelId) void qc.invalidateQueries({ queryKey: nk(novelId, "health") });
    },
  });
}

export function useSecrets() {
  return useQuery({
    queryKey: [...INSTALL, "secrets"],
    queryFn: ({ signal }) => api.get("/system/secrets", { signal }).then((d) => normalizeList(d, secretMetaDtoSchema)),
  });
}

export function useSetSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; value: string; label?: string }) =>
      api.put(`/system/secrets/${encodeURIComponent(args.id)}`, { value: args.value, label: args.label }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: INSTALL }),
  });
}

export function useDeleteSecret() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/system/secrets/${encodeURIComponent(id)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: INSTALL }),
  });
}

export function useProviderProfiles() {
  return useQuery({
    queryKey: [...INSTALL, "provider-profiles"],
    queryFn: ({ signal }) => api.get("/llm/provider-profiles", { signal, schema: listOf(llmProviderProfileDtoSchema) }),
  });
}

const PROFILES = [...INSTALL, "provider-profiles"] as const;
const ROLE_DEFAULTS = [...INSTALL, "role-defaults"] as const;

/** model-list edits (each answer is the NEW active profile version); refreshes profiles, defaults and every novel's bindings */
function useProfileMutation<A>(fn: (a: A) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: PROFILES });
      void qc.invalidateQueries({ queryKey: ROLE_DEFAULTS });
      void qc.invalidateQueries({ queryKey: queryKeys.novels.all });
    },
  });
}

export function useAddProfileModel() {
  return useProfileMutation((a: { profileId: string; model: LlmAddModelRequest }) =>
    api.post(`/llm/provider-profiles/${a.profileId}/models`, a.model, { schema: llmProviderProfileDtoSchema }),
  );
}

export function useEditProfileModel() {
  return useProfileMutation((a: { profileId: string; modelId: string; patch: LlmEditModelRequest }) =>
    api.patch(`/llm/provider-profiles/${a.profileId}/models/${encodeURIComponent(a.modelId)}`, a.patch, { schema: llmProviderProfileDtoSchema }),
  );
}

export function useRemoveProfileModel() {
  return useProfileMutation((a: { profileId: string; modelId: string }) =>
    api.delete(`/llm/provider-profiles/${a.profileId}/models/${encodeURIComponent(a.modelId)}`, { schema: llmProviderProfileDtoSchema }),
  );
}

export function useResetProfileModels() {
  return useProfileMutation((profileId: string) => api.post(`/llm/provider-profiles/${profileId}/reset-models`, {}, { schema: llmProviderProfileDtoSchema }));
}

/** the provider's own model list (API key lanes) / fixed list (Claude 구독); fetched on demand */
export function useAvailableModels() {
  return useMutation({
    mutationFn: (provider: LlmCallProviderId) => api.get(`/llm/providers/${provider}/available-models`, { schema: llmAvailableModelsSchema }),
  });
}

export function useRoleDefaults() {
  return useQuery({ queryKey: ROLE_DEFAULTS, queryFn: ({ signal }) => api.get("/llm/role-defaults", { signal, schema: roleModelDefaultListSchema }) });
}

export function useSetRoleDefaults() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateRoleModelDefaultsRequest) => api.put("/llm/role-defaults", body, { schema: roleModelDefaultListSchema }),
    onSuccess: (d) => qc.setQueryData(ROLE_DEFAULTS, d),
  });
}

export function useResetRoleDefaults() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (role?: AgentRole) => api.delete("/llm/role-defaults", { query: { role }, schema: roleModelDefaultListSchema }),
    onSuccess: (d) => qc.setQueryData(ROLE_DEFAULTS, d),
  });
}

export function useLlmTest() {
  return useMutation({ mutationFn: (body: LlmTestRequest) => api.post("/llm/test", body, { schema: llmTestResponseSchema }) });
}

export function useBots() {
  return useQuery({ queryKey: [...INSTALL, "bots"], queryFn: ({ signal }) => api.get("/messaging/bots", { signal, schema: listOf(messagingBotDtoSchema) }) });
}

export function useRegisterBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MessagingRegisterBotRequest) => api.post("/messaging/bots", body, { schema: messagingBotDtoSchema }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...INSTALL, "bots"] }),
  });
}

export interface BackupsData {
  items: BackupRecordDto[];
  schedule: BackupScheduleDto | null;
}

export function useBackups() {
  return useQuery({
    queryKey: [...INSTALL, "backups"],
    queryFn: ({ signal }) =>
      api.get("/system/backups", { signal }).then((d): BackupsData => {
        const sched = backupScheduleDtoSchema.safeParse((d as { schedule?: unknown } | null)?.schedule);
        return { items: normalizeList(d, backupRecordDtoSchema), schedule: sched.success ? sched.data : null };
      }),
  });
}

export function useCreateBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/system/backups", {}),
    onSettled: () => void qc.invalidateQueries({ queryKey: [...INSTALL, "backups"] }),
  });
}

export function useVerifyBackup() {
  return useMutation({ mutationFn: (id: string) => api.post<{ ok: boolean; message: string }>(`/system/backups/${id}/verify`, {}) });
}

// ── novel scope ──────────────────────────────────────────────────────────
export function useBudget(novelId: string) {
  return useQuery({ queryKey: nk(novelId, "budget"), queryFn: ({ signal }) => api.get(`/novels/${novelId}/budget`, { signal, schema: budgetOverviewSchema }) });
}

export function useUpdateBudgetPolicy(novelId: string) {
  const invalidate = useInvalidateNovel(novelId);
  return useMutation({
    mutationFn: (args: { category: BudgetCategory; patch: BudgetPolicyPatchDto }) =>
      api.patch(`/novels/${novelId}/budget/policies/${args.category}`, args.patch, { schema: budgetPolicyDtoSchema }),
    onSuccess: () => void invalidate(),
  });
}

export function useResumeBudget(novelId: string) {
  const invalidate = useInvalidateNovel(novelId);
  return useMutation({
    mutationFn: (category: BudgetCategory) => api.post(`/novels/${novelId}/budget/policies/${category}/resume`, {}),
    onSuccess: () => void invalidate(),
  });
}

export function useModelBindings(novelId: string) {
  return useQuery({
    queryKey: nk(novelId, "model-bindings"),
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/model-bindings`, { signal, schema: listOf(roleModelBindingDtoSchema) }),
  });
}

export function useUpdateModelBinding(novelId: string) {
  const invalidate = useInvalidateNovel(novelId);
  return useMutation({
    mutationFn: (args: { role: string; patch: UpdateRoleModelBindingRequest }) => api.patch(`/novels/${novelId}/model-bindings/${args.role}`, args.patch),
    onSuccess: () => void invalidate(),
  });
}

export function useChannels(novelId: string) {
  return useQuery({
    queryKey: nk(novelId, "channels"),
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/channels`, { signal, schema: listOf(messagingChannelDtoSchema) }),
  });
}

export function useIssueBinding(novelId: string) {
  return useMutation({
    mutationFn: (bot: { id: string; kind: "telegram" | "discord" }) =>
      api.post(`/novels/${novelId}/channels/bindings`, { kind: bot.kind, botId: bot.id }, { schema: messagingBindingTokenDtoSchema }),
  });
}

export function useUnbindChannel(novelId: string) {
  const invalidate = useInvalidateNovel(novelId);
  return useMutation({
    mutationFn: (channelId: string) => api.post(`/novels/${novelId}/channels/${channelId}/unbind`, {}),
    onSuccess: () => void invalidate(),
  });
}

export function useNotificationPolicy(novelId: string) {
  return useQuery({
    queryKey: nk(novelId, "notification-policy"),
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/notification-policy`, { signal, schema: notificationPolicyDtoSchema }),
  });
}

export function useUpdateNotificationPolicy(novelId: string) {
  const invalidate = useInvalidateNovel(novelId);
  return useMutation({
    mutationFn: (body: UpdateNotificationPolicyRequest) => api.patch(`/novels/${novelId}/notification-policy`, body),
    onSuccess: () => void invalidate(),
  });
}

export function useNovelLengthProfile(novelId: string) {
  return useQuery({
    queryKey: nk(novelId, "length-profile"),
    queryFn: ({ signal }) => api.get(`/novels/${novelId}/length-profile`, { signal, schema: lengthProfileDtoSchema }),
  });
}

export function useUpdateLengthProfile(novelId: string) {
  const invalidate = useInvalidateNovel(novelId);
  return useMutation({
    mutationFn: (body: UpdateLengthProfileRequest) => api.patch(`/novels/${novelId}/length-profile`, body),
    onSuccess: () => void invalidate(),
  });
}

// ── AI provider connections (/api/providers) ─────────────────────────────
const PROVIDERS = [...INSTALL, "providers"] as const;

export function useProviders() {
  return useQuery({ queryKey: PROVIDERS, queryFn: ({ signal }) => api.get("/providers", { signal, schema: listOf(providerStatusDtoSchema) }) });
}

/** connection state per calling provider (profile provider): `anthropic` = Console API key, `claude_code` = Claude 구독 */
export function callProviderConnected(items: readonly ProviderStatusDto[]): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const p of items) {
    if (p.provider === "anthropic") {
      m.set("anthropic", p.methods.some((x) => x.method === "api_key" && x.configured));
      m.set("claude_code", p.claudeCli?.usable ?? false);
    } else m.set(p.provider, p.connected);
  }
  return m;
}

/** re-runs `claude auth status` on the server (the [상태 새로고침] button) */
export function useRefreshProviders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.get("/providers", { query: { refresh: "1" }, schema: listOf(providerStatusDtoSchema) }),
    onSuccess: (d) => {
      qc.setQueryData(PROVIDERS, d);
      void qc.invalidateQueries({ queryKey: [...INSTALL, "health"] });
    },
  });
}

/** Claude 구독: switch the method on in the app and re-check the CLI (the app never starts a login) */
export function useConnectClaudeCli() {
  return useProviderMutation(() => api.post("/providers/anthropic/claude-cli", {}, { schema: providerStatusDtoSchema }));
}

function useProviderMutation<A>(fn: (a: A) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: PROVIDERS });
      void qc.invalidateQueries({ queryKey: [...INSTALL, "secrets"] });
      void qc.invalidateQueries({ queryKey: [...INSTALL, "health"] });
    },
  });
}

export function useSetProviderApiKey() {
  return useProviderMutation((a: { provider: LlmProviderId; apiKey: string }) =>
    api.put(`/providers/${a.provider}/api-key`, { apiKey: a.apiKey }, { schema: providerStatusDtoSchema }),
  );
}

export function useSetProviderActiveMethod() {
  return useProviderMutation((a: { provider: LlmProviderId; method: ProviderConnectionMethod }) =>
    api.put(`/providers/${a.provider}/active-method`, { method: a.method }, { schema: providerStatusDtoSchema }),
  );
}

export function useDisconnectProvider() {
  return useProviderMutation((a: { provider: LlmProviderId; method?: ProviderConnectionMethod }) =>
    api.delete(`/providers/${a.provider}/connection`, { query: { method: a.method }, schema: providerStatusDtoSchema }),
  );
}

export function useImportCodexSession() {
  return useProviderMutation((provider: LlmProviderId) => api.post(`/providers/${provider}/import-codex`, {}, { schema: providerStatusDtoSchema }));
}

export function useTestProvider() {
  return useMutation({
    mutationFn: (a: { provider: LlmProviderId; modelId?: string; method?: ProviderConnectionMethod }) =>
      api.post(`/providers/${a.provider}/test`, { modelId: a.modelId, method: a.method }, { schema: llmTestResponseSchema }),
  });
}

export function useStartProviderLogin() {
  return useMutation({
    mutationFn: (a: { provider: LlmProviderId; flow: "browser" | "device" }) =>
      api.post(`/providers/${a.provider}/oauth`, { flow: a.flow }, { schema: providerOAuthSessionDtoSchema }),
  });
}

/** polls a pending OAuth login every 2 s until it finishes; refreshes provider status on completion */
export function useProviderLogin(provider: LlmProviderId, sessionId: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...PROVIDERS, "login", provider, sessionId],
    enabled: !!sessionId,
    queryFn: async ({ signal }) => {
      const s = await api.get(`/providers/${provider}/oauth/${sessionId}`, { signal, schema: providerOAuthSessionDtoSchema });
      if (s.status === "complete") void qc.invalidateQueries({ queryKey: PROVIDERS });
      return s;
    },
    refetchInterval: (q) => (q.state.data && q.state.data.status !== "pending" ? false : 2000),
  });
}

export function useCancelProviderLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { provider: LlmProviderId; sessionId: string }) => api.delete(`/providers/${a.provider}/oauth/${a.sessionId}`),
    onSettled: () => void qc.invalidateQueries({ queryKey: PROVIDERS }),
  });
}
