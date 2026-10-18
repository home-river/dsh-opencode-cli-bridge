import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_CONFIG_PATH, filterModels, loadModelFilterConfig, parseModelFilterConfig } from "./model-filter.js";
import type { ModelFilterConfig } from "./model-filter.js";
import { loadCatalog } from "./catalog-store.js";
import type { CatalogModel } from "./catalog.js";

/**
 * 「模型暴露设置」的 host 数据面（ISSUE 背景：模型勾选面板）。
 * UI 语义：每个目录条目一个勾选框，勾中 = 暴露到 DSH 模型选择器。
 * 配置落 `~/.dsh-opencode-bridge/config.json` 的 `models` 段（复用 model-filter 的
 * include/exclude 通配语义）；`createModelLister` 每次列模型重读配置，写完即生效。
 */

/** 目录条目 + 当前是否暴露（可见性由过滤规则推导，不由 UI 直接存）。 */
export interface ModelSettingsEntry extends CatalogModel {
  visible: boolean;
}

export interface ModelSettingsState {
  /** 全量目录（含被隐藏条目），按 id 升序，UI 逐条渲染勾选框。 */
  models: ModelSettingsEntry[];
  /** 当前生效的过滤配置（UI 调试/高级视图用）。 */
  filter: ModelFilterConfig;
  /** 配置文件存在但不可用时的原因（缺省表示正常）。 */
  configError?: string;
}

export async function readModelSettingsState(
  options: {
    configPath?: string;
    loadCatalog?: () => Promise<readonly CatalogModel[]>;
  } = {},
): Promise<ModelSettingsState> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const loaded = loadModelFilterConfig(configPath);
  const catalog = [...(await (options.loadCatalog ?? loadCatalog)())].sort((a, b) => a.id.localeCompare(b.id));
  const visible = new Set(filterModels(catalog, loaded.config).map((m) => m.id));
  return {
    models: catalog.map((m) => ({ ...m, visible: visible.has(m.id) })),
    filter: loaded.config,
    ...(loaded.error === undefined ? {} : { configError: loaded.error }),
  };
}

/**
 * UI 勾选结果 → `models` 段。白名单语义：`include` = 暴露清单。
 * 全不勾时不能写空 include（空 include 语义是「不设白名单」，会被 DEFAULT_EXCLUDE 反向放行），
 * 用 `exclude: ["*"]` 显式全隐藏（selectVisibleModels 会兜底静态保底模型，不会全空）。
 */
export function filterFromSelection(selected: readonly string[]): ModelFilterConfig {
  return selected.length > 0
    ? { include: [...selected] }
    : { include: [], exclude: ["*"] };
}

export type WriteFilterResult = { ok: true } | { ok: false; error: string };
/**
 * 写回 config.json 的 `models` 段：
 * 1. 入参先过 parseModelFilterConfig 校验（形状不符拒绝，不落盘）；
 * 2. read-modify-merge：保留 `models` 以外的所有未知顶层键；
 * 3. tmp + rename 原子写（与 catalog-store.writeCache 同范式）；
 * 4. 既有文件读失败/JSON 损坏一律拒绝写入，避免覆盖未知内容。
 */
export function writeModelFilterSection(
  filter: ModelFilterConfig,
  configPath: string = DEFAULT_CONFIG_PATH,
): WriteFilterResult {
  const parsed = parseModelFilterConfig({ models: filter });
  if (parsed.error !== undefined) return { ok: false, error: parsed.error };

  let root: Record<string, unknown> = {};
  try {
    const text = readFileSync(configPath, "utf8");
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, error: "config root must be an object" };
    }
    root = raw as Record<string, unknown>;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code !== "ENOENT") {
      return { ok: false, error: `read failed: ${err?.code ?? String(e)}` };
    }
  }

  root.models = parsed.config;
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    const tmp = `${configPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(root, null, 2), "utf8");
    renameSync(tmp, configPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `write failed: ${String(e)}` };
  }
}

/** client 可达的路由路径（`ctx.connection.fetch.register` 要求 `/api/<segment>` 形态）。 */
export const MODELS_ROUTE_PATH = "/api/opencode-bridge.models";
export const FILTER_ROUTE_PATH = "/api/opencode-bridge.filter";

/** `ctx.connection.fetch.register` 路由的结构性窄接口（G9：不 import DSH 运行时）。 */
export interface HostFetchRoute {
  path: string;
  methods: string[];
  requestBody: "buffered" | "streaming";
  fetch: (request: Request) => Promise<Response>;
}

/** 写过滤的请求体：`{ selected: ids }`（UI 勾选语义）或 `{ models: {...} }`（高级原语义）。 */
export function parseFilterPayload(body: unknown): { filter: ModelFilterConfig } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "body must be an object" };
  const record = body as Record<string, unknown>;
  if (record.selected !== undefined) {
    const selected = record.selected;
    if (!Array.isArray(selected) || !selected.every((s) => typeof s === "string" && s !== "")) {
      return { error: "selected must be an array of non-empty strings" };
    }
    return { filter: filterFromSelection(selected as string[]) };
  }
  if (record.models !== undefined) {
    const parsed = parseModelFilterConfig({ models: record.models });
    if (parsed.error !== undefined) return { error: parsed.error };
    return { filter: parsed.config };
  }
  return { error: "body must carry `selected` or `models`" };
}

/** 构造两条设置路由（读状态 / 写过滤），供 plugin 注册进 `ctx.connection.fetch`。 */
export function buildModelSettingsRoutes(
  options: { configPath?: string; loadCatalog?: () => Promise<readonly CatalogModel[]> } = {},
): HostFetchRoute[] {
  return [
    {
      path: MODELS_ROUTE_PATH,
      methods: ["GET", "POST"],
      requestBody: "buffered",
      fetch: async () => Response.json({ ok: true, value: await readModelSettingsState(options) }),
    },
    {
      path: FILTER_ROUTE_PATH,
      methods: ["PUT", "POST"],
      requestBody: "buffered",
      fetch: async (request: Request) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
        }
        const parsed = parseFilterPayload(body);
        if ("error" in parsed) return Response.json({ ok: false, error: parsed.error }, { status: 400 });
        const written = writeModelFilterSection(parsed.filter, options.configPath);
        if (!written.ok) return Response.json({ ok: false, error: written.error }, { status: 500 });
        return Response.json({ ok: true, value: await readModelSettingsState(options) });
      },
    },
  ];
}
