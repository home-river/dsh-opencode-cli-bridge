import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EXCLUDE,
  matchesPattern,
  filterModels,
  selectVisibleModels,
  parseModelFilterConfig,
  loadModelFilterConfig,
} from "../../lib/model-filter.js";
import { createModelLister } from "../../lib/plugin.js";
import { STATIC_MODELS } from "../../lib/catalog.js";

const MODELS = [
  { id: "opencode/mimo-v2.6-flash-free", name: "MiMo" },
  { id: "opencode/gpt-5", name: "GPT-5" },
  { id: "opencode-go/big", name: "Go Big" },
  { id: "opencode-go/small", name: "Go Small" },
];

test("默认排除：opencode-go/* 隐藏，opencode/* 保留", () => {
  assert.deepEqual(DEFAULT_EXCLUDE, ["opencode-go/*"]);
  assert.deepEqual(filterModels(MODELS).map((m) => m.id), [
    "opencode/mimo-v2.6-flash-free",
    "opencode/gpt-5",
  ]);
});

test("include 白名单：非空时只留命中项", () => {
  const out = filterModels(MODELS, { include: ["opencode/mimo*"] });
  assert.deepEqual(out.map((m) => m.id), ["opencode/mimo-v2.6-flash-free"]);
});

test("exclude 优先级最高：include 命中也会被隐藏", () => {
  const out = filterModels(MODELS, { include: ["opencode/*"], exclude: ["opencode/gpt-5"] });
  assert.deepEqual(out.map((m) => m.id), ["opencode/mimo-v2.6-flash-free"]);
});

test("include 显式写 opencode-go/* 可覆盖默认排除", () => {
  const out = filterModels(MODELS, { include: ["opencode-go/*"] });
  assert.deepEqual(out.map((m) => m.id), ["opencode-go/big", "opencode-go/small"]);
  const one = filterModels(MODELS, { include: ["opencode-go/big"] });
  assert.deepEqual(one.map((m) => m.id), ["opencode-go/big"]);
});

test("exclude 仍优先于默认排除的覆盖：显式 include 也救不回来", () => {
  const out = filterModels(MODELS, { include: ["opencode-go/*"], exclude: ["opencode-go/big"] });
  assert.deepEqual(out.map((m) => m.id), ["opencode-go/small"]);
});

test("matchesPattern：* 通配、无 * 精确、正则元字符按字面", () => {
  assert.ok(matchesPattern("opencode/a", "opencode/*"));
  assert.ok(matchesPattern("opencode/a", "*"));
  assert.ok(matchesPattern("opencode/a", "opencode/a"));
  assert.ok(!matchesPattern("opencode/ab", "opencode/a"));
  assert.ok(matchesPattern("opencode/a.b", "opencode/a.b"));
  assert.ok(!matchesPattern("opencode/axb", "opencode/a.b"));
  assert.ok(matchesPattern("opencode/(x)+", "opencode/(x)+"));
});

test("selectVisibleModels：过滤结果为空时兜底静态保底模型", () => {
  const out = selectVisibleModels(MODELS, { include: ["nothing/matches"] });
  assert.deepEqual(out.map((m) => m.id), STATIC_MODELS.map((m) => m.id));
  assert.notEqual(out[0], STATIC_MODELS[0]); // 返回副本，不外泄共享引用
  const kept = selectVisibleModels(MODELS, { include: ["opencode/gpt-5"] });
  assert.deepEqual(kept.map((m) => m.id), ["opencode/gpt-5"]);
});

test("parseModelFilterConfig：正常形状", () => {
  const parsed = parseModelFilterConfig({ models: { include: ["a/*"], exclude: ["b"] } });
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.config, { include: ["a/*"], exclude: ["b"] } );
});

test("parseModelFilterConfig：无 models 段 -> 默认配置", () => {
  assert.deepEqual(parseModelFilterConfig({}), { config: {} });
  assert.deepEqual(parseModelFilterConfig(undefined), { config: {}, error: "config root must be an object" });
});

test("parseModelFilterConfig：形状不对一律退回默认并给 error", () => {
  for (const raw of [[], "x", null, { models: "x" }, { models: [] }, { models: { include: "a" } }, { models: { exclude: [1] } }, { models: { include: [""] } }]) {
    const parsed = parseModelFilterConfig(raw);
    assert.deepEqual(parsed.config, {}, JSON.stringify(raw));
    assert.equal(typeof parsed.error, "string", JSON.stringify(raw));
  }
});

test("loadModelFilterConfig：文件缺失不算错，坏 JSON 给 error", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocbridge-filter-"));
  try {
    const missing = loadModelFilterConfig(join(dir, "nope.json"));
    assert.equal(missing.error, undefined);
    assert.deepEqual(missing.config, {});

    const broken = join(dir, "config.json");
    writeFileSync(broken, "{ not json", "utf8");
    const bad = loadModelFilterConfig(broken);
    assert.equal(typeof bad.error, "string");
    assert.deepEqual(bad.config, {});

    writeFileSync(broken, JSON.stringify({ models: { include: ["opencode/x*"] } }), "utf8");
    const ok = loadModelFilterConfig(broken);
    assert.equal(ok.error, undefined);
    assert.deepEqual(ok.config, { include: ["opencode/x*"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createModelLister：读配置 -> 取目录 -> 过滤，每次调用重读配置", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocbridge-lister-"));
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ models: { include: ["opencode/mimo*"] } }), "utf8");
    const lister = createModelLister({ configPath, loadCatalog: async () => MODELS });
    assert.deepEqual((await lister()).map((m) => m.id), ["opencode/mimo-v2.6-flash-free"]);

    writeFileSync(configPath, JSON.stringify({ models: { exclude: ["opencode/gpt-5"] } }), "utf8");
    assert.deepEqual((await lister()).map((m) => m.id), ["opencode/mimo-v2.6-flash-free"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createModelLister：配置损坏 -> 记诊断 + 退回默认过滤", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocbridge-lister-bad-"));
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, "{ broken", "utf8");
    const seen = [];
    const lister = createModelLister({
      configPath,
      loadCatalog: async () => MODELS,
      onDiagnostic: (message) => { seen.push(message); },
    });
    assert.deepEqual((await lister()).map((m) => m.id), ["opencode/mimo-v2.6-flash-free", "opencode/gpt-5"]);
    assert.equal(seen.length, 1);
    assert.match(seen[0], /config ignored/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createModelLister：过滤到空 -> 兜底静态保底模型", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocbridge-lister-empty-"));
  try {
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ models: { include: ["nothing/*"] } }), "utf8");
    const lister = createModelLister({ configPath, loadCatalog: async () => MODELS });
    assert.deepEqual((await lister()).map((m) => m.id), STATIC_MODELS.map((m) => m.id));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
