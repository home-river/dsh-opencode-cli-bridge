import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { discoverOpencodeCli } from "./discover-cli.js";
import { mergeVerified, parseModelsOutput, STATIC_MODELS } from "./catalog.js";
import type { CatalogModel } from "./catalog.js";

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const FETCH_FAILURE_TTL_MS = 5 * 60 * 1000;

interface CatalogMemo {
  at: number;
  models: CatalogModel[] | null;
  ttlMs: number;
}

const catalogMemo = new Map<string, CatalogMemo>();

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

function spawnModels(command: string, args: string[]): Promise<CatalogModel[] | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let settled = false;
    let timedOut = false;

    const finish = (models: CatalogModel[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(models);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish(null);
    }, 15_000);

    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (timedOut || code !== 0) {
        finish(null);
        return;
      }
      const models = parseModelsOutput(stdout);
      finish(models.length > 0 ? models : null);
    });
  });
}

export async function runModelsCli(options: { command?: string; args?: string[] } = {}): Promise<CatalogModel[] | null> {
  try {
    const found = await discoverOpencodeCli({ command: options.command });
    return await spawnModels(found.command, options.args ?? ["models"]);
  } catch {
    return null;
  }
}

function cachedFallback(cachePath: string, ttlMs: number, now: () => number): CatalogModel[] {
  const cached = readCache(cachePath);
  if (cached !== null && now() - Date.parse(cached.fetchedAt) < ttlMs) {
    return mergeVerified(cached.models);
  }
  if (cached !== null) return mergeVerified(cached.models);
  return mergeVerified(STATIC_MODELS);
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

  const memo = catalogMemo.get(cachePath);
  if (memo !== undefined && now() - memo.at < memo.ttlMs) {
    return Promise.resolve(memo.models === null
      ? cachedFallback(cachePath, ttlMs, now)
      : mergeVerified(memo.models));
  }

  const cached = readCache(cachePath);
  const fresh = cached !== null && now() - Date.parse(cached.fetchedAt) < ttlMs;
  if (fresh) return Promise.resolve(mergeVerified(cached.models));

  return (async () => {
    const fetched = await fetchModels();
    if (fetched !== null && fetched.length > 0) {
      const models = mergeVerified(fetched);
      writeCache(cachePath, { source: "cli", fetchedAt: new Date(now()).toISOString(), models });
      catalogMemo.set(cachePath, { at: now(), models, ttlMs });
      return models;
    }

    catalogMemo.set(cachePath, { at: now(), models: null, ttlMs: FETCH_FAILURE_TTL_MS });
    if (cached !== null) return mergeVerified(cached.models);

    const models = mergeVerified(STATIC_MODELS);
    writeCache(cachePath, { source: "static", fetchedAt: new Date(now()).toISOString(), models });
    return models;
  })();
}
