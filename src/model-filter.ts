import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { STATIC_MODELS } from "./catalog.js";
import type { CatalogModel } from "./catalog.js";

/**
 * 模型展示筛选：只决定 DSH 模型选择器里看得见哪些条目。
 * 不影响目录缓存（缓存仍存全量）与请求转发（`resolveModel` 保持宽松回退）。
 */
export interface ModelFilterConfig {
  /** 白名单：非空时只展示命中任一模式的条目；空或缺省表示全放行。 */
  include?: readonly string[];
  /** 黑名单：恒生效，命中即隐藏，优先级高于 include。 */
  exclude?: readonly string[];
}

/** 内置默认排除：`opencode-go/*` 默认不展示；需要时在 include 里显式写回。 */
export const DEFAULT_EXCLUDE: readonly string[] = ["opencode-go/*"];

/** 模式匹配：仅支持 `*` 通配（匹配任意长度任意字符），其余字符按字面匹配。 */
export function matchesPattern(id: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(id);
}

function matchesAny(id: string, patterns: readonly string[] | undefined): boolean {
  return (patterns ?? []).some((pattern) => matchesPattern(id, pattern));
}

/**
 * 规则：
 * 1. include 非空时，只保留命中 include 的条目；
 * 2. 命中 exclude 的条目一定隐藏（优先级最高）；
 * 3. 命中 DEFAULT_EXCLUDE 的条目隐藏，除非它被 include 显式命中（显式 include 覆盖默认排除）。
 */
export function filterModels(models: readonly CatalogModel[], config: ModelFilterConfig = {}): CatalogModel[] {
  const include = config.include ?? [];
  const out: CatalogModel[] = [];
  for (const model of models) {
    if (include.length > 0 && !matchesAny(model.id, include)) continue;
    if (matchesAny(model.id, config.exclude)) continue;
    if (matchesAny(model.id, DEFAULT_EXCLUDE) && !matchesAny(model.id, include)) continue;
    out.push(model);
  }
  return out;
}

/** 可见目录 = 过滤结果；过滤到空时兜底静态保底模型，避免模型选择器全空。 */
export function selectVisibleModels(models: readonly CatalogModel[], config: ModelFilterConfig = {}): CatalogModel[] {
  const filtered = filterModels(models, config);
  return filtered.length > 0 ? filtered : STATIC_MODELS.map((model) => ({ ...model }));
}

export const DEFAULT_CONFIG_PATH = join(homedir(), ".dsh-opencode-bridge", "config.json");

export interface LoadedModelFilter {
  config: ModelFilterConfig;
  /** 配置文件存在但不可用时的原因；缺省表示正常（含「文件不存在」）。 */
  error?: string;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => typeof item === "string" && item !== "")) return null;
  return value as string[];
}

/** 解析 `config.json` 的 `models` 段；形状不符一律退回默认（不抛异常）。 */
export function parseModelFilterConfig(raw: unknown): LoadedModelFilter {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { config: {}, error: "config root must be an object" };
  }
  const models = (raw as Record<string, unknown>).models;
  if (models === undefined) return { config: {} };
  if (typeof models !== "object" || models === null || Array.isArray(models)) {
    return { config: {}, error: "config.models must be an object" };
  }
  const config: { include?: string[]; exclude?: string[] } = {};
  for (const key of ["include", "exclude"] as const) {
    const value = (models as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const list = asStringArray(value);
    if (list === null) return { config: {}, error: `config.models.${key} must be an array of non-empty strings` };
    config[key] = list;
  }
  return { config };
}

/** 读取模型筛选配置；文件缺失不算错，其余读失败/解析失败一律退回默认并给出 error。 */
export function loadModelFilterConfig(configPath: string = DEFAULT_CONFIG_PATH): LoadedModelFilter {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") return { config: {} };
    return { config: {}, error: `read failed: ${err?.code ?? String(e)}` };
  }
  try {
    return parseModelFilterConfig(JSON.parse(text) as unknown);
  } catch (e) {
    return { config: {}, error: `invalid JSON: ${String(e)}` };
  }
}
