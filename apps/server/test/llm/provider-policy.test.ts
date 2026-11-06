/**
 * Claude subscription policy guard (code.claude.com/docs/en/legal-and-compliance, read 2026-11-06):
 * - allowed: the end user signs in to the UNMODIFIED Claude Code binary with their own subscription, and
 *   this app runs that binary (`claude -p`, `claude auth status`) — modules/llm/adapters/claude-cli;
 * - forbidden: collecting, storing or intermediating Claude.ai credentials or session tokens, or offering
 *   Claude.ai login inside the app. So no source may read the CLI's credential store, mint/handle
 *   subscription OAuth tokens, or call Claude OAuth endpoints; login happens only via `claude auth login`
 *   run by the user in a terminal (Anthropic's own flow).
 * Source scan of apps/server/src + apps/web/src + packages/shared/src.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cliArgs } from "../../src/modules/llm/adapters/claude-cli/claude-cli-adapter.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const dirs = ["apps/server/src", "apps/web/src", "packages/shared/src"].map((d) => join(root, d));

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

const FORBIDDEN: Array<[RegExp, string]> = [
  [/CLAUDE_CODE_OAUTH_TOKEN/, "handling a Claude subscription OAuth token"],
  [/setup-token/, "minting a Claude subscription token"],
  [/\.credentials\.json|Claude Code-credentials/, "reading the Claude Code credential store"],
  [/claude\.ai\/oauth|console\.anthropic\.com\/oauth|platform\.claude\.com\/oauth/, "Claude OAuth endpoint"],
  [/["'`]auth["'`]\s*,\s*["'`]login["'`]/, "starting Claude.ai login from the app"],
];

describe("Claude subscription policy", () => {
  it("no source collects, stores or intermediates Claude.ai credentials", () => {
    const hits: string[] = [];
    for (const d of dirs) {
      for (const f of files(d)) {
        const s = readFileSync(f, "utf8");
        for (const [re, what] of FORBIDDEN) if (re.test(s)) hits.push(`${f.slice(root.length + 1)}: ${what}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the subscription adapter only runs the unmodified CLI and reads `claude auth status`", () => {
    const src = readFileSync(join(root, "apps/server/src/modules/llm/adapters/claude-cli/claude-cli-adapter.ts"), "utf8");
    expect(src).toMatch(/\["auth", "status"\]/);
    expect(src).toMatch(/delete env\.ANTHROPIC_API_KEY/);
    expect(src).not.toMatch(/readFile|keychain|security find-generic-password/i);
  });

  it("CLI tools: none by default; a web search call enables only the built-in WebSearch — never WebFetch (설계 추가 0011)", () => {
    const src = readFileSync(join(root, "apps/server/src/modules/llm/adapters/claude-cli/claude-cli-adapter.ts"), "utf8");
    // the only tool names the adapter can pass, and every tool flag goes through them
    expect(src).toMatch(/export const CLI_WEB_TOOLS = \["WebSearch"\] as const;/);
    expect(src).toMatch(/"--tools",\s*\n\s*req\.webSearch \? web : "",/);
    expect(src).toMatch(/\["--allowedTools", web, "--permission-mode", "dontAsk"\]/);
    expect(src).not.toMatch(/bypassPermissions|dangerously|--add-dir|--mcp-config|--plugin|--agents|--disallowedTools|"--settings"/);
    for (const name of ["Bash", "Edit", "Write", "Read", "Glob", "Grep", "NotebookEdit", "Task", "PowerShell"]) expect(src).not.toMatch(new RegExp(`["'\`]${name}["'\`]`));

    const base = { modelId: "claude-opus-5-5", system: "s", messages: [{ role: "user" as const, content: "u" }], output: { kind: "text" as const }, maxOutputTokens: 100 };
    const valueOf = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    const plain = cliArgs(base).args;
    expect(valueOf(plain, "--tools")).toBe("");
    expect(valueOf(plain, "--allowedTools")).toBeUndefined();
    expect(valueOf(plain, "--permission-mode")).toBeUndefined();
    const web = cliArgs({ ...base, webSearch: { maxUses: 3 } }).args;
    // WebFetch would fetch any URL (planted links, localhost / private addresses) from the user's PC
    for (const flag of ["--tools", "--allowedTools"]) expect(valueOf(web, flag)!.split(",")).toEqual(["WebSearch"]);
    expect(web.join(" ")).not.toMatch(/WebFetch/);
    expect(valueOf(web, "--permission-mode")).toBe("dontAsk");
    expect(web.filter((a) => a === "--tools" || a === "--allowedTools")).toHaveLength(2);
    expect(web).toContain("--strict-mcp-config");
    expect(valueOf(web, "--setting-sources")).toBe("");
  });
});
