import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { discoverOpencodeCli } from "./discover-cli.js";
import { mergeVerified, parseModelsOutput, STATIC_MODELS } from "./catalog.js";
import type { CatalogModel } from "./catalog.js";

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface CatalogCacheFile {
  source: "cli" | "static";
  fetchedAt: string;
  models: CatalogModel[];
}

export function readCache(cachePath: string): CatalogCacheFile | null {
  try {
    if (!existsSync(cachePath)) return null;
    const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const file = parsed as Partial<CatalogCacheFile>;
    if (typeof file.fetchedAt !== "string" || !Array.isArray(file.models)) return null;
    if (!file.models.every((m) => typeof m?.id === "string" && typeof m?.name === "string")) return null;
    return { source: file.source === "static" ? "static" : "cli", fetchedAt: file.fetchedAt, models: file.models };
  } catch {
    return null;
  }
}

export function writeCache(cachePath: string, file: CatalogCacheFile): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), "utf8");
    renameSync(tmp, cachePath);
  } catch {
    // 缓存写失败不影响目录供给
  }
}

export async function runModelsCli(options: { command?: string; args?: string[] } = {}): Promise<CatalogModel[] | null> {
  try {
    const found = await discoverOpencodeCli({ command: options.command });
    const result = spawnSync(found.command, options.args ?? ["models"], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 15_000,
    });
    if (result.error || result.status !== 0) return null;
    const models = parseModelsOutput(result.stdout ?? "");
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

export function loadCatalog(
  options: {
    cachePath?: string;
    command?: string;
    ttlMs?: number;
    now?: () => number;
    fetchModels?: () => Promise<CatalogModel[] | null> | CatalogModel[] | null;
  } = {},
): Promise<CatalogModel[]> {
  const cachePath = options.cachePath ?? join(homedir(), ".dsh-opencode-bridge", "models.json");
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const fetchModels = options.fetchModels ?? (() => runModelsCli({ command: options.command }));

  const cached = readCache(cachePath);
  const fresh = cached !== null && now() - Date.parse(cached.fetchedAt) < ttlMs;
  if (fresh) return Promise.resolve(mergeVerified(cached.models));

  return (async () => {
    const fetched = await fetchModels();
    if (fetched !== null && fetched.length > 0) {
      const models = mergeVerified(fetched);
      writeCache(cachePath, { source: "cli", fetchedAt: new Date(now()).toISOString(), models });
      return models;
    }
    if (cached !== null) return mergeVerified(cached.models);

    const models = mergeVerified(STATIC_MODELS);
    writeCache(cachePath, { source: "static", fetchedAt: new Date(now()).toISOString(), models });
    return models;
  })();
}
