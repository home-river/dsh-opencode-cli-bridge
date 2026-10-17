import { OpencodeBridgeAdapter } from "./adapter.js";
import { loadCatalog } from "./catalog-store.js";

export const name = "llm-opencode-bridge";
export const inject = ["llm"];

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
  });
  return ctx.llm.registerAdapter(["opencode-bridge"], adapter);
}
