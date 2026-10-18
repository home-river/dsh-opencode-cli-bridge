import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildModelSettingsRoutes,
  filterFromSelection,
  readModelSettingsState,
  writeModelFilterSection,
  MODELS_ROUTE_PATH,
  FILTER_ROUTE_PATH,
} from "../../lib/model-settings.js";

const CATALOG = [
  { id: "opencode/a-free", name: "A" },
  { id: "opencode/b-free", name: "B" },
  { id: "opencode-go/paid", name: "Paid" },
];

function tmpConfig() {
  const dir = mkdtempSync(join(tmpdir(), "ocbridge-settings-"));
  return { dir, configPath: join(dir, "config.json") };
}

test("readModelSettingsState：全量目录 + visible 推导（默认隐藏 opencode-go/*）", async () => {
  const { dir, configPath } = tmpConfig();
  try {
    const state = await readModelSettingsState({ configPath, loadCatalog: async () => CATALOG });
    assert.deepEqual(state.models.map((m) => [m.id, m.visible]), [
      ["opencode-go/paid", false],
      ["opencode/a-free", true],
      ["opencode/b-free", true],
    ]); // 按 id 升序
    assert.deepEqual(state.filter, {});
    assert.equal(state.configError, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readModelSettingsState：配置显式 include 覆盖默认排除；坏配置给出 configError", async () => {
  const { dir, configPath } = tmpConfig();
  try {
    writeFileSync(configPath, JSON.stringify({ models: { include: ["opencode-go/*"] } }), "utf8");
    let state = await readModelSettingsState({ configPath, loadCatalog: async () => CATALOG });
    assert.deepEqual(state.models.map((m) => m.visible), [true, false, false]);

    writeFileSync(configPath, JSON.stringify({ models: { include: 42 } }), "utf8");
    state = await readModelSettingsState({ configPath, loadCatalog: async () => CATALOG });
    assert.ok(state.configError, "坏配置应带 error");
    assert.deepEqual(state.models.map((m) => m.visible), [false, true, true]); // 退回默认
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("filterFromSelection：白名单语义；空选择用 exclude:* 显式全隐藏", () => {
  assert.deepEqual(filterFromSelection(["opencode/a-free"]), { include: ["opencode/a-free"] });
  assert.deepEqual(filterFromSelection([]), { include: [], exclude: ["*"] });
});

test("writeModelFilterSection：read-modify-merge 保留未知顶层键，原子落盘", () => {
  const { dir, configPath } = tmpConfig();
  try {
    writeFileSync(configPath, JSON.stringify({ cli: { command: "x" }, models: { exclude: ["old/*"] } }), "utf8");
    const r = writeModelFilterSection(filterFromSelection(["opencode/a-free"]), configPath);
    assert.deepEqual(r, { ok: true });
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(saved.cli, { command: "x" }, "未知顶层键必须保留");
    assert.deepEqual(saved.models, { include: ["opencode/a-free"] }, "models 段被整体替换");
    assert.ok(!existsSync(`${configPath}.tmp`), "tmp 文件应收敛");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writeModelFilterSection：文件不存在时可创建；入参非法拒绝且不落盘", () => {
  const { dir, configPath } = tmpConfig();
  try {
    assert.deepEqual(writeModelFilterSection({ include: ["m1"] }, configPath), { ok: true });
    assert.ok(existsSync(configPath));

    // include 元素类型非法 -> 拒绝；既有文件保持原样
    const before = readFileSync(configPath, "utf8");
    const r = writeModelFilterSection({ include: [42] }, configPath);
    assert.equal(r.ok, false);
    assert.equal(readFileSync(configPath, "utf8"), before, "非法写入不得改动文件");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writeModelFilterSection：既有文件 JSON 损坏或根形状非法时拒绝写入", () => {
  const { dir, configPath } = tmpConfig();
  try {
    writeFileSync(configPath, "{ not json", "utf8");
    const r = writeModelFilterSection({ include: ["m1"] }, configPath);
    assert.equal(r.ok, false);
    assert.match(r.error, /read failed/);

    writeFileSync(configPath, "[1,2]", "utf8");
    const r2 = writeModelFilterSection({ include: ["m1"] }, configPath);
    assert.equal(r2.ok, false);
    assert.match(r2.error, /config root/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("写回后再读：readModelSettingsState 与写入的勾选一致（round trip）", async () => {
  const { dir, configPath } = tmpConfig();
  try {
    const selected = ["opencode-go/paid", "opencode/b-free"];
    assert.deepEqual(writeModelFilterSection(filterFromSelection(selected), configPath), { ok: true });
    const state = await readModelSettingsState({ configPath, loadCatalog: async () => CATALOG });
    assert.deepEqual(state.models.filter((m) => m.visible).map((m) => m.id).sort(), [...selected].sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildModelSettingsRoutes：读状态 / 写过滤的 HTTP 语义与错误信封", async () => {
  const { dir, configPath } = tmpConfig();
  try {
    const byPath = Object.fromEntries(
      buildModelSettingsRoutes({ configPath, loadCatalog: async () => CATALOG }).map((r) => [r.path, r]),
    );
    const req = (path, method, body) => new Request(`http://local${path}`, {
      method,
      ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }),
    });

    let res = await byPath[MODELS_ROUTE_PATH].fetch(req(MODELS_ROUTE_PATH, "GET"));
    let payload = await res.json();
    assert.equal(res.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.value.models.length, 3);

    res = await byPath[FILTER_ROUTE_PATH].fetch(req(FILTER_ROUTE_PATH, "PUT", JSON.stringify({ selected: ["opencode-go/paid"] })));
    payload = await res.json();
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.value.models.filter((m) => m.visible).map((m) => m.id), ["opencode-go/paid"]);

    for (const bad of ["not json", JSON.stringify({ selected: [1] }), JSON.stringify({ nope: 1 })]) {
      res = await byPath[FILTER_ROUTE_PATH].fetch(req(FILTER_ROUTE_PATH, "PUT", bad));
      assert.equal(res.status, 400, `应拒绝：${bad}`);
      payload = await res.json();
      assert.equal(payload.ok, false);
      assert.ok(payload.error);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
