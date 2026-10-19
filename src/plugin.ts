import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpencodeBridgeAdapter } from "./adapter.js";
import { SessionStore } from "./session-store.js";
import { loadCatalog as loadModelCatalog } from "./catalog-store.js";
import { DEFAULT_CONFIG_PATH, loadModelFilterConfig, selectVisibleModels } from "./model-filter.js";
import { buildModelSettingsRoutes } from "./model-settings.js";
import { buildCliStatusRoute } from "./cli-status.js";
import type { HostFetchRoute } from "./model-settings.js";
import type { CatalogModel } from "./catalog.js";

export const name = "llm-opencode-bridge";
export const inject = ["llm"];

/**
 * host 侧构建指纹：apply 时写入 diagnostics.log。
 * 实机排查「修复没生效」时用它确认加载的是哪版模块（HMR live 重载可能只换
 * fiber 不换 ESM 模块实例，见 ISSUE-001 复验记录）。
 */
export const BRIDGE_BUILD = "0.1.0-2026-10-19.1";

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
  /**
   * cordis 等待式可选注入：目标服务就绪后回调；服务永不出现则回调不执行（安静降级）。
   * `ctx.get` 是即时查询，会错过晚于本插件 apply 注册的服务（connection 实测如此）。
   */
  inject?: (
    keys: readonly string[],
    callback: (ctx: { get?: (key: string) => unknown }) => unknown,
  ) => { dispose?: () => unknown } | (() => void);
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

/**
 * 组装「读配置 -> 取目录 -> 过滤」的模型供给器。
 * 每次调用重读配置：改完 `config.json` 下次打开模型选择器即生效，无需重启；
 * 配置不可用只记诊断并退回默认，绝不影响模型列表。
 */
export function createModelLister(options: {
  configPath?: string;
  loadCatalog?: () => Promise<readonly CatalogModel[]>;
  onDiagnostic?: (message: string) => void;
} = {}): () => Promise<CatalogModel[]> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const loadCatalog = options.loadCatalog ?? loadModelCatalog;
  return async () => {
    const loaded = loadModelFilterConfig(configPath);
    if (loaded.error !== undefined) {
      try {
        options.onDiagnostic?.(`config ignored: ${loaded.error}`);
      } catch { /* 诊断不影响主流程 */ }
    }
    return selectVisibleModels(await loadCatalog(), loaded.config);
  };
}

export function apply(ctx: PluginContext): (() => void) & { replace?: (providers: string[]) => void } {
  safeAppend("diagnostics.log", `${new Date().toISOString()} ${JSON.stringify({ code: "BRIDGE_LOADED", build: BRIDGE_BUILD })}\n`);
  const adapter = new OpencodeBridgeAdapter({
    resolveWorkspace: (sessionId) => resolveWorkspace(ctx, sessionId),
    sessionStore: new SessionStore(join(LOG_DIR, "sessions.json")),
    listModelEntries: createModelLister({
      onDiagnostic: (message) => {
        safeAppend("diagnostics.log", `${new Date().toISOString()} ${JSON.stringify({ code: "MODEL_FILTER_CONFIG", message }).slice(0, 2000)}\n`);
      },
    }),
    onDiagnostic: (d) => {
      safeAppend("diagnostics.log", `${new Date().toISOString()} ${JSON.stringify(d).slice(0, 2000)}\n`);
    },
    onRequestStart: (info) => {
      const ts = new Date().toISOString();
      safeAppend(
        "requests.log",
        `${ts} start model=${info.model} workspace=${info.workspace || "(empty)"} sessionId=${info.sessionId ?? "(none)"} ocSession=${info.ocSessionId ?? "(new)"} effort=${info.reasoningEffort ?? "-"} promptChars=${info.prompt.length}\n`,
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
  const registration = ctx.llm.registerAdapter(["opencode-bridge"], adapter);
  const routeDisposers = registerModelSettingsRoutes(ctx);
  const dispose = (() => {
    for (const d of routeDisposers) {
      try {
        d();
      } catch { /* 卸载尽力而为 */ }
    }
    registration();
  }) as (() => void) & { replace?: (providers: string[]) => void };
  if (registration.replace !== undefined) {
    dispose.replace = (providers) => registration.replace?.(providers);
  }
  return dispose;
}

/** `ctx.connection.fetch` 的结构性窄接口（G9）。 */
interface ConnectionLike {
  fetch?: { register?: (route: HostFetchRoute) => unknown };
}

/** 全部设置面路由：模型暴露设置两条 + CLI 状态检测一条。 */
function buildSettingsRoutes(): HostFetchRoute[] {
  return [...buildModelSettingsRoutes(), buildCliStatusRoute()];
}

/**
 * 注册「模型暴露设置」的 host 路由（读状态 / 写过滤 / CLI 检测）到 `ctx.connection.fetch`：
 * 该注册面位于浏览器会话 cookie 鉴权栅栏内（缺 cookie 的请求 401），无需自建围栏。
 * connection 服务可能晚于本插件 apply 就绪 —— 经 `ctx.inject` 等待式注入；
 * 服务缺失或注册失败只记诊断并跳过，设置 UI 不可用不影响模型桥主功能。
 */
export function registerModelSettingsRoutes(ctx: PluginContext): Array<() => void> {
  const disposers: Array<() => void> = [];
  const ts = new Date().toISOString();
  const registerWith = (connection: ConnectionLike | undefined): void => {
    const fetchApi = connection?.fetch;
    const register = fetchApi?.register;
    if (typeof register !== "function") {
      safeAppend("diagnostics.log", `${ts} ${JSON.stringify({ code: "MODEL_SETTINGS_ROUTES", message: "connection service unavailable; settings routes disabled" })}\n`);
      return;
    }
    for (const route of buildSettingsRoutes()) {
      try {
        const d = register.call(fetchApi, route);
        disposers.push(typeof d === "function" ? (d as () => void) : () => {});
      } catch (e) {
        safeAppend("diagnostics.log", `${ts} ${JSON.stringify({ code: "MODEL_SETTINGS_ROUTES", message: `register failed ${route.path}: ${String(e)}` }).slice(0, 2000)}\n`);
      }
    }
    safeAppend("diagnostics.log", `${ts} ${JSON.stringify({ code: "MODEL_SETTINGS_ROUTES", message: `routes registered: ${buildSettingsRoutes().map((r) => r.path).join(", ")}` })}\n`);
  };
  try {
    if (typeof ctx.inject === "function") {
      const seat = ctx.inject(["connection"], (injected) => {
        registerWith(injected?.get?.("connection") as ConnectionLike | undefined);
      });
      disposers.push(() => {
        try {
          const stop = typeof seat === "function" ? seat : seat?.dispose;
          if (typeof stop === "function") stop();
        } catch { /* 卸载尽力而为 */ }
      });
    } else {
      registerWith(ctx.get?.("connection") as ConnectionLike | undefined);
    }
  } catch (e) {
    safeAppend("diagnostics.log", `${ts} ${JSON.stringify({ code: "MODEL_SETTINGS_ROUTES", message: `inject failed: ${String(e)}` }).slice(0, 2000)}\n`);
  }
  return disposers;
}
