/** `ncs secrets set|list|delete` (08 §5.4–5.5): values from stdin or a hidden prompt, never echoed. */
import type { Command } from "commander";
import { isCancel, password } from "@clack/prompts";
import { secretIdSchema } from "@ncs/shared";
import { loadConfig } from "../lib/config.js";
import { api, detectServer } from "../lib/http.js";
import { ownerActor, withCore } from "../lib/core.js";
import { fail, printJson, readStdin, table } from "../lib/output.js";

export async function setSecret(id: string, value: string, label?: string): Promise<"http" | "offline"> {
  const { config } = loadConfig();
  if ((await detectServer(config)).running) {
    await api(config, "PUT", `/api/system/secrets/${encodeURIComponent(id)}`, { value, label });
    return "http";
  }
  await withCore(config, async (core) => {
    const existed = await core.modules.system.service.secrets.has(id);
    await core.modules.system.service.secrets.set(id, value, label);
    const actor = await ownerActor(core);
    await core.platform.uow.run((tx: unknown) =>
      core.modules.audit.service.record(tx, {
        novelId: null,
        actor,
        action: "secret.set",
        target: { type: "settings", id: `secret.${id}` },
        details: { secretId: id, replaced: existed, via: "cli" },
      }),
    );
  });
  return "offline";
}

export function registerSecretsCommands(program: Command): void {
  const cmd = program.command("secrets").description("비밀(API 키·봇 토큰) 관리 — 값은 화면에 표시하지 않습니다");

  cmd
    .command("set <id>")
    .description("비밀 값을 저장합니다(표준 입력 또는 숨김 입력). 예: llm.anthropic.api_key")
    .option("--label <label>", "표시 이름")
    .option("--stdin", "표준 입력에서 값을 읽습니다")
    .action(async (id: string, o: { label?: string; stdin?: boolean }) => {
      const parsed = secretIdSchema.safeParse(id);
      if (!parsed.success) fail(parsed.error.issues[0]?.message ?? "비밀 키 형식이 올바르지 않습니다.");
      let value: string;
      if (o.stdin || !process.stdin.isTTY) value = await readStdin();
      else {
        const v = await password({ message: `${id} 값`, mask: "•" });
        if (isCancel(v)) fail("취소했습니다.");
        value = String(v);
      }
      if (!value) fail("값이 비어 있습니다.");
      const via = await setSecret(id, value, o.label);
      process.stdout.write(`${id} 를 저장했습니다(${via === "http" ? "실행 중인 서버" : "로컬 DB"}).\n`);
    });

  cmd
    .command("list")
    .description("비밀 목록(이름·갱신일만)")
    .option("--json", "JSON 출력")
    .action(async (o: { json?: boolean }) => {
      const { config } = loadConfig();
      const items = (await detectServer(config)).running
        ? (await api<{ items: Array<{ id: string; label: string | null; updatedAt: string }> }>(config, "GET", "/api/system/secrets")).items
        : await withCore(config, async (core) =>
            (await core.modules.system.service.secrets.list()).map((s) => ({ ...s, updatedAt: new Date(s.updatedAt).toISOString() })),
          );
      if (o.json) return printJson({ items });
      if (!items.length) return void process.stdout.write("저장된 비밀이 없습니다.\n");
      process.stdout.write(`${table(items.map((s) => ({ id: s.id, label: s.label ?? "", updatedAt: s.updatedAt })), ["id", "label", "updatedAt"])}\n`);
    });

  cmd
    .command("delete <id>")
    .description("비밀을 지웁니다")
    .action(async (id: string) => {
      const { config } = loadConfig();
      if ((await detectServer(config)).running) await api(config, "DELETE", `/api/system/secrets/${encodeURIComponent(id)}`);
      else {
        const ok = await withCore(config, async (core) => {
          const done = await core.modules.system.service.secrets.delete(id);
          if (done) {
            const actor = await ownerActor(core);
            await core.platform.uow.run((tx: unknown) =>
              core.modules.audit.service.record(tx, {
                novelId: null,
                actor,
                action: "secret.deleted",
                target: { type: "settings", id: `secret.${id}` },
                details: { secretId: id, via: "cli" },
              }),
            );
          }
          return done;
        });
        if (!ok) fail(`비밀이 없습니다: ${id}`);
      }
      process.stdout.write(`${id} 를 지웠습니다.\n`);
    });
}
