import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  readCache, writeCache, runModelsCli, loadCatalog, CACHE_TTL_MS,
} from "../../lib/catalog-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_MODELS = resolve(here, "..", "fixtures", "fake-models.mjs");

function tmp() { return mkdtempSync(join(tmpdir(), "ocbridge-cat-")); }

test("writeCache/readCache 原子往返", () => {
  const dir = tmp();
  try {
    const path = join(dir, "models.json");
    writeCache(path, { source: "cli", fetchedAt: "2026-10-17T00:00:00.000Z", models: [{ id: "a/b", name: "a/b" }] });
    assert.ok(existsSync(path));
    assert.ok(!existsSync(path + ".tmp"));
    const back = readCache(path);
    assert.equal(back.source, "cli");
    assert.deepEqual(back.models, [{ id: "a/b", name: "a/b" }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readCache: 不存在/损坏 -> null 不抛错", () => {
  const dir = tmp();
  try {
    assert.equal(readCache(join(dir, "missing.json")), null);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    assert.equal(readCache(bad), null);
    const wrong = join(dir, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ source: "cli" }));
    assert.equal(readCache(wrong), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runModelsCli: 走发现路径执行命令并解析输出", async () => {
  const models = await runModelsCli({ command: process.execPath, args: [FAKE_MODELS] });
  assert.deepEqual(models.map((m) => m.id), ["opencode/fake-one", "opencode/fake-two"]);
});

test("runModelsCli: 命令失败 -> null", async () => {
  assert.equal(await runModelsCli({ command: resolve(tmp(), "no-such-exe") }), null);
});

test("loadCatalog: 新鲜缓存直接命中，不触发 fetch", async () => {
  const dir = tmp();
  try {
    const path = join(dir, "models.json");
    writeCache(path, { source: "cli", fetchedAt: new Date().toISOString(), models: [{ id: "cached/one", name: "cached/one" }] });
    let fetched = false;
    const models = await loadCatalog({
      cachePath: path,
      fetchModels: () => { fetched = true; return null; },
    });
    assert.equal(fetched, false);
    assert.ok(models.some((m) => m.id === "cached/one"));
    assert.ok(models.some((m) => m.id === "opencode/mimo-v2.6-flash-free"), "mergeVerified 生效");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadCatalog: 过期缓存触发 fetch，成功后写回缓存", async () => {
  const dir = tmp();
  try {
    const path = join(dir, "models.json");
    const stale = new Date(Date.now() - CACHE_TTL_MS - 1000).toISOString();
    writeCache(path, { source: "cli", fetchedAt: stale, models: [{ id: "stale/one", name: "stale/one" }] });
    const models = await loadCatalog({
      cachePath: path,
      fetchModels: () => [{ id: "fresh/one", name: "fresh/one" }],
    });
    assert.ok(models.some((m) => m.id === "fresh/one"));
    assert.equal(readCache(path).models.some((m) => m.id === "fresh/one"), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadCatalog: fetch 失败回退陈旧缓存；全无 -> STATIC", async () => {
  const dir = tmp();
  try {
    const path = join(dir, "models.json");
    const stale = new Date(Date.now() - CACHE_TTL_MS - 1000).toISOString();
    writeCache(path, { source: "cli", fetchedAt: stale, models: [{ id: "stale/one", name: "stale/one" }] });
    const a = await loadCatalog({ cachePath: path, fetchModels: () => null });
    assert.ok(a.some((m) => m.id === "stale/one"));
    const b = await loadCatalog({ cachePath: join(dir, "none.json"), fetchModels: () => null });
    assert.ok(b.some((m) => m.id === "opencode/mimo-v2.6-flash-free"));
    assert.equal(readCache(join(dir, "none.json")).source, "static");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
