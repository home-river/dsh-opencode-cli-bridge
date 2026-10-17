import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpencodeBridgeAdapter } from "./adapter.js";
import { loadCatalog } from "./catalog-store.js";

export const name = "llm-opencode-bridge";
export const inject = ["llm"];

const LOG_DIR = join(homedir(), ".dsh-opencode-bridge");

/** 取证日志：一切异常吞掉，绝不影响请求主流程。 */
function safeAppend(file: string, data: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, file), data);
  } catch { /* 日志失败不影响主流程 */ }
}

/** 宿主 ctx 的结构性窄接口（G9：只声明用到的成员）。 */
export interface PluginContext {
  llm: {
    registerAdapter: (providers: string[], adapter: unknown) => (() => void) & { replace?: (providers: string[]) => void };
  };
  get?: (key: string) => unknown;
}

interface SessionLike { header?: { cwd?: string } }
interface WorkspaceLike { path: string; sessionIds?: readonly string[] }

/** G10：sessions.header.cwd -> workspaceRegistry 命中 -> process.cwd()。 */
export function resolveWorkspace(ctx: PluginContext, sessionId?: string): string {
  if (sessionId !== undefined) {
    const sessions = ctx.get?.("sessions") as { get?: (id: string) => SessionLike | undefined } | undefined;
    const cwd = sessions?.get?.(sessionId)?.header?.cwd;
    if (typeof cwd === "string" && cwd !== "") return cwd;
    const registry = ctx.get?.("workspaceRegistry") as { list?: () => readonly WorkspaceLike[] } | undefined;
    for (const workspace of registry?.list?.() ?? []) {
      if (workspace.sessionIds?.includes(sessionId) && typeof workspace.path === "string" && workspace.path !== "") {
        return workspace.path;
      }
    }
  }
  return process.cwd();
}

export function apply(ctx: PluginContext): (() => void) & { replace?: (providers: string[]) => void } {
  const adapter = new OpencodeBridgeAdapter({
    resolveWorkspace: (sessionId) => resolveWorkspace(ctx, sessionId),
    listModelEntries: () => loadCatalog(),
    onDiagnostic: (d) => {
      safeAppend("diagnostics.log", `${new Date().toISOString()} ${JSON.stringify(d).slice(0, 2000)}\n`);
    },
    onRequestStart: (info) => {
      const ts = new Date().toISOString();
      safeAppend(
        "requests.log",
        `${ts} start model=${info.model} workspace=${info.workspace || "(empty)"} sessionId=${info.sessionId ?? "(none)"} promptChars=${info.prompt.length}\n`,
      );
      if (info.prompt !== "") {
        try {
          mkdirSync(LOG_DIR, { recursive: true });
          writeFileSync(join(LOG_DIR, "last-request.md"), info.prompt);
        } catch { /* 日志失败不影响主流程 */ }
      }
    },
    onRequestEnd: (info) => {
      safeAppend(
        "requests.log",
        `${new Date().toISOString()} end   model=${info.model} durationMs=${info.durationMs} textChars=${info.textChars} finish=${info.finishKind}${info.finishCode ? `:${info.finishCode}` : ""}\n`,
      );
    },
  });
  return ctx.llm.registerAdapter(["opencode-bridge"], adapter);
}
