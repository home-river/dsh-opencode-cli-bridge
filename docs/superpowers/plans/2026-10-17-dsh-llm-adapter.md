# DSH LlmAdapter 接入（子项目 3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 插件向 DSH 注册 `opencode-bridge` provider：实现 `LlmAdapter` 合同（模型目录 + 请求流）、插件入口与 bundle 打包合同，使 DSH 能发现模型并把请求经 CliBridge 转成 OpenCode CLI 调用、把输出以 DSH StreamChunk 回显（具备实机联调条件）。

**Architecture:** 纯层 `prompt.ts`（消息→prompt）与 `catalog.ts`（目录解析）之上：`catalog-store.ts`（CLI 获取 + 原子缓存）、`adapter.ts`（结构化实现 DSH `LlmAdapter` 七方法，依赖注入）、`plugin.ts`（`name/inject/apply` + workspace 解析 + `registerAdapter`）。不 import DSH 运行时——adapter 以结构化实现满足合同（宿主运行时 duck-typing 校验）。

**Tech Stack:** TypeScript 5.6（strict、ESM、tsc→`lib/`）、node:test、既有 CliBridge（`streamDshChunks`）与 fake CLI 测试替身。

**Spec:** [dsh-llm-contract.md](../research/dsh-llm-contract.md)（DSH 合同原件）、[dsh-plugin-contract.md](../research/dsh-plugin-contract.md)（插件入口合同调研原件，本计划 §附录 A 摘录关键行）、[2026-10-15-oc-cli-bridge-design.md](../specs/2026-10-15-oc-cli-bridge-design.md) §14 子项目 3/5。

## Global Constraints

- **G1 纯层无 Node API：** `src/prompt.ts`、`src/catalog.ts` 不得 import 任何 `node:*` 模块。
- **G2 类型镜像：** DSH 侧类型沿用 `src/dsh-types.ts`（不重复声明）；`adapter.ts` 对 `LlmAdapter` 合同做结构化实现，字段/方法名与 [dsh-llm-contract.md](../research/dsh-llm-contract.md) §3 一致。
- **G3 正文与密钥边界：** 不把 prompt / 消息正文 / 密钥写入日志、诊断、错误消息或缓存文件。
- **G4 回归底线：** 现有单测（110+ 条）保持全绿；唯一验收命令 `npm test`。
- **G5 工程模式：** TS strict + ESM；相对 import 一律带 `.js` 后缀。
- **G6 提交规范：** conventional commits + 中文（如 `feat(adapter): ...`），每任务至少一个提交。
- **G7 YAGNI：** 只实现任务清单内行为。MVP 不做：session 持久化（子项目 4）、图片/推理/工具转发、设置页、HTTP 目录层、Config schema（不引 schemastery 依赖）。
- **G9 不依赖 DSH 运行时包：** 构建期不得 import `@deepseek-ai/*`；`ctx` 与宿主对象一律结构性窄接口（只声明用到的字段），运行时用可选链防御缺失。
- **G10 workspace 解析顺序（TODO-04 裁定）：** `ctx.sessions.get(sessionId).header.cwd` → `ctx.workspaceRegistry.list()` 中 `sessionIds` 含该会话的 `path` → `process.cwd()`；解析函数集中在 `plugin.ts` 并可注入替换。

---

### Task 1: `buildPrompt` 纯函数（消息 → prompt 文本）

**Files:**
- Create: `src/prompt.ts`
- Test: `test/unit/prompt.test.mjs`

**Interfaces:**
- Consumes: 无。
- Produces（Task 4 消费，签名逐字）:

```ts
export interface PromptContentBlock { readonly type: string; readonly text?: string }
export interface PromptMessage {
  readonly role: string;
  readonly content?: readonly PromptContentBlock[];
}
export interface BuildPromptInput {
  system?: string;
  messages: readonly PromptMessage[];
}
export function buildPrompt(input: BuildPromptInput): string;
```

**行为语义：**
1. 每条消息产出一段 `<Role 标签>:\n<文本>`；多段文本块用 `\n` 连接；段与段之间用空行（`\n\n`）连接。
2. Role 标签映射：`system→System`、`developer→Developer`、`user→User`、`assistant→Assistant`、`tool→Tool`；未知 role 原样作为标签。
3. `input.system` 非空时作为第一段 `System:\n<system>`（与消息段同样分隔）。
4. 无文本块或文本块为空串的消息整段跳过；`type !== "text"` 的块跳过；不改写任何文本内容（保真拼接）。
5. 全部为空时返回空串 `""`。

- [ ] **Step 1: 写失败测试** `test/unit/prompt.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../../lib/prompt.js";

test("单条 user 消息 -> User 段", () => {
  assert.equal(
    buildPrompt({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    "User:\nhi",
  );
});

test("system 优先成段，消息按序追加", () => {
  const prompt = buildPrompt({
    system: "be brief",
    messages: [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
    ],
  });
  assert.equal(prompt, "System:\nbe brief\n\nUser:\nq\n\nAssistant:\na");
});

test("五种 role 标签映射 + 未知 role 原样", () => {
  const prompt = buildPrompt({
    messages: [
      { role: "system", content: [{ type: "text", text: "s" }] },
      { role: "developer", content: [{ type: "text", text: "d" }] },
      { role: "tool", content: [{ type: "text", text: "t" }] },
      { role: "custom-role", content: [{ type: "text", text: "c" }] },
    ],
  });
  assert.equal(prompt, "System:\ns\n\nDeveloper:\nd\n\nTool:\nt\n\ncustom-role:\nc");
});

test("同一消息多文本块用换行连接，非 text 块跳过", () => {
  const prompt = buildPrompt({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "line1" },
        { type: "image" },
        { type: "text", text: "line2" },
      ],
    }],
  });
  assert.equal(prompt, "User:\nline1\nline2");
});

test("无文本的消息整段跳过", () => {
  assert.equal(buildPrompt({ messages: [{ role: "user", content: [{ type: "image" }] }] }), "");
  assert.equal(buildPrompt({ messages: [{ role: "user", content: [] }] }), "");
  assert.equal(buildPrompt({ messages: [] }), "");
});

test("空串 system 不产生段；文本不改写", () => {
  assert.equal(buildPrompt({ system: "", messages: [{ role: "user", content: [{ type: "text", text: "  x  " }] }] }), "User:\n  x  ");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test` — Expected: FAIL（`lib/prompt.js` 不存在）。

- [ ] **Step 3: 写 `src/prompt.ts`**

```ts
export interface PromptContentBlock {
  readonly type: string;
  readonly text?: string;
}

export interface PromptMessage {
  readonly role: string;
  readonly content?: readonly PromptContentBlock[];
}

export interface BuildPromptInput {
  system?: string;
  messages: readonly PromptMessage[];
}

const ROLE_LABELS: Record<string, string> = {
  system: "System",
  developer: "Developer",
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
};

/** 把 DSH 请求消息压平成 OpenCode CLI 的单段 prompt（保真拼接，不改写文本）。 */
export function buildPrompt(input: BuildPromptInput): string {
  const sections: string[] = [];
  if (input.system !== undefined && input.system !== "") {
    sections.push(`System:\n${input.system}`);
  }
  for (const message of input.messages) {
    const texts: string[] = [];
    for (const block of message.content ?? []) {
      if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
        texts.push(block.text);
      }
    }
    if (texts.length === 0) continue;
    const label = ROLE_LABELS[message.role] ?? message.role;
    sections.push(`${label}:\n${texts.join("\n")}`);
  }
  return sections.join("\n\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test` — Expected: PASS（新增 6 条 + 既有全绿）。

- [ ] **Step 5: 纯层检查**：`npm run typecheck` 通过；目检 `src/prompt.ts` 无 `node:` import。
- [ ] **Step 6: 提交**

```bash
git add src/prompt.ts test/unit/prompt.test.mjs
git commit -m "feat(adapter): DSH 消息压平为 prompt 文本"
```

---

### Task 2: 模型目录解析与静态回退 `src/catalog.ts`（纯层）

**Files:**
- Create: `src/catalog.ts`
- Test: `test/unit/catalog.test.mjs`

**Interfaces:**
- Consumes: 无。
- Produces（Task 3/4 消费）:

```ts
export interface CatalogModel { id: string; name: string; description?: string }
export function parseModelsOutput(stdout: string): CatalogModel[];
export const STATIC_MODELS: readonly CatalogModel[];
export function mergeVerified(models: readonly CatalogModel[]): CatalogModel[];
export function toModelInfo(provider: string, model: CatalogModel): {
  provider: string; id: string; name: string; description?: string; inputModalities: readonly string[];
};
```

**行为语义：**
1. `opencode models` 实测输出为**一行一个 `provider/model` id**（2026-10-17 实测）。`parseModelsOutput`：按 `\r?\n` 切行、trim；空行与不含 `/` 的行跳过；按 id 去重（保持首次出现顺序）；`name` 默认等于 `id`。
2. `STATIC_MODELS` 是目录失败时的保底，至少含已实测可调用的 `opencode/mimo-v2.6-flash-free`。
3. `mergeVerified`：把 `STATIC_MODELS` 中缺失的模型并入结果尾部（目录与真实可用性有漂移，见 memory.md 3A：不能只信 CLI 目录）；已有同 id 不重复。
4. `toModelInfo`：`inputModalities` 固定 `["text"]`（TODO-07 MVP 决策）。

- [ ] **Step 1: 写失败测试** `test/unit/catalog.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModelsOutput, mergeVerified, toModelInfo, STATIC_MODELS } from "../../lib/catalog.js";

test("parseModelsOutput: 一行一个 id，name=id", () => {
  const models = parseModelsOutput("opencode/a\nopencode/b\n");
  assert.deepEqual(models, [
    { id: "opencode/a", name: "opencode/a" },
    { id: "opencode/b", name: "opencode/b" },
  ]);
});

test("parseModelsOutput: CRLF、空行、无斜杠行、去重", () => {
  const models = parseModelsOutput("opencode/a\r\n\r\nnoise\r\nopencode/a\r\nopencode-go/b\r\n");
  assert.deepEqual(models.map((m) => m.id), ["opencode/a", "opencode-go/b"]);
});

test("parseModelsOutput: 空输出 -> 空数组", () => {
  assert.deepEqual(parseModelsOutput(""), []);
});

test("STATIC_MODELS 含已验证免费模型", () => {
  assert.ok(STATIC_MODELS.some((m) => m.id === "opencode/mimo-v2.6-flash-free"));
});

test("mergeVerified: 缺失的静态模型并入尾部，已有不重复", () => {
  const merged = mergeVerified([{ id: "opencode/x", name: "x" }]);
  assert.equal(merged[0].id, "opencode/x");
  assert.ok(merged.some((m) => m.id === "opencode/mimo-v2.6-flash-free"));
  const twice = mergeVerified([...STATIC_MODELS]);
  assert.equal(twice.filter((m) => m.id === "opencode/mimo-v2.6-flash-free").length, 1);
});

test("toModelInfo: provider 与 inputModalities 固定形态", () => {
  assert.deepEqual(toModelInfo("opencode-bridge", { id: "opencode/a", name: "A" }), {
    provider: "opencode-bridge",
    id: "opencode/a",
    name: "A",
    description: undefined,
    inputModalities: ["text"],
  });
});
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npm test` — Expected: FAIL（`lib/catalog.js` 不存在）。
- [ ] **Step 3: 写 `src/catalog.ts`**

```ts
export interface CatalogModel {
  id: string;
  name: string;
  description?: string;
}

/** 解析 `opencode models` 输出：一行一个 provider/model id（2026-10-17 实测）。 */
export function parseModelsOutput(stdout: string): CatalogModel[] {
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const id = raw.trim();
    if (id === "" || !id.includes("/")) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: id });
  }
  return out;
}

/** 目录失败时的静态保底（已实测可调用）。 */
export const STATIC_MODELS: readonly CatalogModel[] = [
  { id: "opencode/mimo-v2.6-flash-free", name: "MiMo v2.6 Flash (free)" },
];

/** 目录与真实可用性有漂移：任何来源的结果都并入已验证模型。 */
export function mergeVerified(models: readonly CatalogModel[]): CatalogModel[] {
  const out = [...models];
  const seen = new Set(out.map((m) => m.id));
  for (const model of STATIC_MODELS) {
    if (!seen.has(model.id)) out.push({ ...model });
    seen.add(model.id);
  }
  return out;
}

export function toModelInfo(
  provider: string,
  model: CatalogModel,
): { provider: string; id: string; name: string; description?: string; inputModalities: readonly string[] } {
  return {
    provider,
    id: model.id,
    name: model.name,
    description: model.description,
    inputModalities: ["text"],
  };
}
```

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS（新增 6 条 + 既有全绿）。
- [ ] **Step 5: 纯层检查**：typecheck + 目检无 `node:` import。
- [ ] **Step 6: 提交**

```bash
git add src/catalog.ts test/unit/catalog.test.mjs
git commit -m "feat(adapter): 模型目录解析与静态回退"
```

---

### Task 3: 目录缓存与 CLI 获取 `src/catalog-store.ts`（Node 层）

**Files:**
- Create: `src/catalog-store.ts`
- Create: `test/fixtures/fake-models.mjs`
- Test: `test/unit/catalog-store.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `parseModelsOutput` / `STATIC_MODELS` / `mergeVerified` / `CatalogModel`；既有 `discoverOpencodeCli`（`src/discover-cli.ts`）。
- Produces（Task 4/5 消费）:

```ts
export const CACHE_TTL_MS: number; // 24 * 60 * 60 * 1000
export interface CatalogCacheFile { source: "cli" | "static"; fetchedAt: string; models: CatalogModel[] }
export function readCache(cachePath: string): CatalogCacheFile | null;
export function writeCache(cachePath: string, file: CatalogCacheFile): void;
export function runModelsCli(options?: { command?: string; args?: string[] }): Promise<CatalogModel[] | null>;
export function loadCatalog(options?: {
  cachePath?: string; command?: string; ttlMs?: number; now?: () => number;
  fetchModels?: () => Promise<CatalogModel[] | null> | CatalogModel[] | null;
}): Promise<CatalogModel[]>;
```

**行为语义：**
1. 缓存文件（默认 `~/.dsh-opencode-bridge/models.json`）：`{ source, fetchedAt: ISO, models }`；`readCache` 对不存在/损坏/形状不符一律返回 `null`（不抛错）；`writeCache` 先写 `<path>.tmp` 再 `renameSync`（原子）。
2. `runModelsCli`（async）：`await discoverOpencodeCli({ command })` 发现实身（已核实：返回 `Promise<DiscoveredCli>`，字段 `{ command, source }`，失败抛 `CliBridgeError("CLI_NOT_FOUND")`）→ `spawnSync(found.command, args ?? ["models"], { encoding: "utf8", windowsHide: true, shell: false, timeout: 15_000 })`；发现失败（catch）或非零退出或空输出 → `null`（调用方回退，不抛错）。stdout 用 `parseModelsOutput` 解析。
3. `loadCatalog` 回退链：**新鲜缓存（now - fetchedAt < ttlMs）→ fetchModels（默认 runModelsCli）→ 陈旧缓存 → STATIC_MODELS**；任何来源结果都过 `mergeVerified`；fetch 成功时写缓存（source:"cli"），全部失败时用 STATIC 且写缓存（source:"static"）。返回 Promise（与 `listModels` 合同对齐，内部同步 I/O）。
4. 缓存与日志不含 prompt/正文（G3）。

- [ ] **Step 1: 写失败测试** `test/unit/catalog-store.test.mjs`（先写 fixture）：

`test/fixtures/fake-models.mjs`：

```js
process.stdout.write("opencode/fake-one\nopencode/fake-two\n");
```

`test/unit/catalog-store.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL（`lib/catalog-store.js` 不存在）。
- [ ] **Step 3: 写 `src/catalog-store.ts`**

```ts
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
```

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS（新增 7 条 + 既有全绿）。
- [ ] **Step 5: 提交**

```bash
git add src/catalog-store.ts test/fixtures/fake-models.mjs test/unit/catalog-store.test.mjs
git commit -m "feat(adapter): 模型目录 CLI 获取与原子缓存"
```

---

### Task 4: `OpencodeBridgeAdapter`（LlmAdapter 结构化实现）

**Files:**
- Create: `src/adapter.ts`
- Test: `test/unit/adapter.test.mjs`

**Interfaces:**
- Consumes: `buildPrompt`（Task 1）、`toModelInfo`/`CatalogModel`（Task 2）、`streamDshChunks`（既有）、`DshStreamChunk`（`src/dsh-types.ts`）、`CliDiagnostic`（`src/types.ts`）。
- Produces（Task 5 消费，签名逐字）:

```ts
export interface AdapterGenerateOptions {
  provider: string;
  model: string;
  system?: string;
  messages: readonly PromptMessage[];
  signal?: AbortSignal;
  sessionId?: string;
}
export interface OpencodeBridgeDeps {
  resolveWorkspace: (sessionId?: string) => string;
  listModelEntries: () => Promise<readonly CatalogModel[]>;
  cli?: { command?: string; extraArgs?: string[]; timeouts?: Partial<import("./types.js").CliTimeouts> };
  onDiagnostic?: (d: CliDiagnostic) => void;
}
export class OpencodeBridgeAdapter {
  constructor(deps: OpencodeBridgeDeps);
  providerInfo(provider: string): { id: string; name: string };
  providerRetryPolicy(): undefined;
  imageRequestPricing(): undefined;
  listModels(provider: string): Promise<readonly ReturnType<typeof toModelInfo>[]>;
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<ReturnType<typeof toModelInfo>>;
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{ model: ReturnType<typeof toModelInfo>; stream: (options: AdapterGenerateOptions) => AsyncIterable<DshStreamChunk> }>;
  stream(options: AdapterGenerateOptions): AsyncIterable<DshStreamChunk>;
}
```

**行为语义：**
1. `providerInfo` → `{ id: provider, name: "OpenCode Bridge" }`。
2. `providerRetryPolicy` / `imageRequestPricing` 返回 `undefined`（交给 DSH 默认）。
3. `listModels`：`deps.listModelEntries()` → `toModelInfo(provider, entry)` 逐项映射。
4. `resolveModel`：在 `listModels` 结果中找 `id === model`；找不到返回 `{ provider, id: model, name: model, inputModalities: ["text"] }`（MVP 不因目录缺失拒绝请求——目录成员资格只是 GUI 建议）。
5. `prepareCall`：返回 `{ model: await resolveModel(...), stream: (o) => this.stream(o) }`。
6. `stream`：
   - `prompt = buildPrompt({ system: options.system, messages: options.messages })`；空 prompt → 立即产出 `usage`（全零）+ `finish {kind:"error", failure:{message:"Empty request", code:"PROMPT_FAILED"}}` 的终止流，**不 spawn CLI**；
   - `workspace = deps.resolveWorkspace(options.sessionId)`；
   - 返回 `streamDshChunks({ workspace, model: options.model, prompt, signal: options.signal, onDiagnostic: deps.onDiagnostic, ...deps.cli }, {})`；
   - 执行期失败/取消由 `streamDshChunks` 落成终止 finish，本方法不抛（G2/DSH 合同）。
7. `options.model` 透传为 CLI `--model`（目录 id 即 `provider/model` 全形）。

- [ ] **Step 1: 写失败测试** `test/unit/adapter.test.mjs`（fake CLI 调用范式沿用 `test/unit/cli-bridge.test.mjs`）：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { OpencodeBridgeAdapter } from "../../lib/adapter.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(here, "..", "fixtures", "fake-opencode.mjs");

function makeAdapter(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ocbridge-adapter-"));
  writeFileSync(join(dir, "alpha.txt"), "alpha\n");
  const deps = {
    resolveWorkspace: (sessionId) => { deps.seenSessionId = sessionId; return dir; },
    listModelEntries: async () => [{ id: "opencode/mimo-v2.6-flash-free", name: "MiMo Flash" }],
    cli: {
      command: process.execPath,
      extraArgs: [FAKE, "mode:normal"],
      timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 5000, totalMs: 15000, shutdownMs: 1000 },
    },
    ...over,
  };
  return { dir, adapter: new OpencodeBridgeAdapter(deps), deps };
}

const MESSAGES = [{ role: "user", content: [{ type: "text", text: "hello" }] }];

test("providerInfo / providerRetryPolicy / imageRequestPricing", () => {
  const { adapter } = makeAdapter();
  assert.deepEqual(adapter.providerInfo("opencode-bridge"), { id: "opencode-bridge", name: "OpenCode Bridge" });
  assert.equal(adapter.providerRetryPolicy(), undefined);
  assert.equal(adapter.imageRequestPricing(), undefined);
});

test("listModels/resolveModel 映射目录", async () => {
  const { dir, adapter } = makeAdapter();
  try {
    const models = await adapter.listModels("opencode-bridge");
    assert.deepEqual(models, [{
      provider: "opencode-bridge",
      id: "opencode/mimo-v2.6-flash-free",
      name: "MiMo Flash",
      description: undefined,
      inputModalities: ["text"],
    }]);
    const resolved = await adapter.resolveModel("opencode-bridge", "opencode/mimo-v2.6-flash-free");
    assert.equal(resolved.id, "opencode/mimo-v2.6-flash-free");
    const unknown = await adapter.resolveModel("opencode-bridge", "opencode/unknown");
    assert.deepEqual(unknown, { provider: "opencode-bridge", id: "opencode/unknown", name: "opencode/unknown", inputModalities: ["text"] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stream: fake CLI 走通 -> 块 + usage + finish(stop)，workspace/sessionId 接线", async () => {
  const { dir, adapter, deps } = makeAdapter();
  try {
    const chunks = [];
    for await (const c of adapter.stream({
      provider: "opencode-bridge",
      model: "opencode/mimo-v2.6-flash-free",
      messages: MESSAGES,
      sessionId: "ses_dsh_1",
    })) chunks.push(c);
    assert.equal(deps.seenSessionId, "ses_dsh_1");
    assert.equal(chunks[0].type, "block-start");
    assert.equal(chunks.at(-2).type, "usage");
    assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stream: 空请求 -> 直接 error finish，不 spawn", async () => {
  const { dir, adapter } = makeAdapter({ cli: { command: resolve(here, "no-such-exe") } });
  try {
    const chunks = [];
    for await (const c of adapter.stream({ provider: "p", model: "m", messages: [] })) chunks.push(c);
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks[1].reason, {
      kind: "error",
      failure: { message: "Empty request", code: "PROMPT_FAILED" },
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prepareCall 返回 model + stream，stream 行为一致", async () => {
  const { dir, adapter } = makeAdapter();
  try {
    const prepared = await adapter.prepareCall("opencode-bridge", "opencode/mimo-v2.6-flash-free");
    assert.equal(prepared.model.id, "opencode/mimo-v2.6-flash-free");
    const chunks = [];
    for await (const c of prepared.stream({
      provider: "opencode-bridge",
      model: "opencode/mimo-v2.6-flash-free",
      messages: MESSAGES,
    })) chunks.push(c);
    assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL（`lib/adapter.js` 不存在）。
- [ ] **Step 3: 写 `src/adapter.ts`**

```ts
import type { DshStreamChunk, DshTokenUsage } from "./dsh-types.js";
import type { CliDiagnostic, CliTimeouts } from "./types.js";
import { ZERO_USAGE } from "./types.js";
import { buildPrompt } from "./prompt.js";
import type { PromptMessage } from "./prompt.js";
import { toModelInfo } from "./catalog.js";
import type { CatalogModel } from "./catalog.js";
import { streamDshChunks } from "./cli-bridge.js";

export interface AdapterGenerateOptions {
  provider: string;
  model: string;
  system?: string;
  messages: readonly PromptMessage[];
  signal?: AbortSignal;
  sessionId?: string;
}

export interface OpencodeBridgeDeps {
  resolveWorkspace: (sessionId?: string) => string;
  listModelEntries: () => Promise<readonly CatalogModel[]>;
  cli?: { command?: string; extraArgs?: string[]; timeouts?: Partial<CliTimeouts> };
  onDiagnostic?: (d: CliDiagnostic) => void;
}

const ZERO_TOKEN_USAGE: DshTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

async function* errorFinishStream(code: string, message: string): AsyncIterable<DshStreamChunk> {
  yield { type: "usage", usage: ZERO_TOKEN_USAGE };
  yield { type: "finish", reason: { kind: "error", failure: { message, code } } };
}

/**
 * DSH LlmAdapter 的结构化实现（不 import DSH 运行时；G2/G9）。
 * 七个方法与 @deepseek-ai/dsh-llm 的 LlmAdapter 合同同名同形。
 */
export class OpencodeBridgeAdapter {
  readonly #deps: OpencodeBridgeDeps;

  constructor(deps: OpencodeBridgeDeps) {
    this.#deps = deps;
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: "OpenCode Bridge" };
  }

  providerRetryPolicy(): undefined {
    return undefined;
  }

  imageRequestPricing(): undefined {
    return undefined;
  }

  async listModels(provider: string): Promise<readonly ReturnType<typeof toModelInfo>[]> {
    const entries = await this.#deps.listModelEntries();
    return entries.map((entry) => toModelInfo(provider, entry));
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<ReturnType<typeof toModelInfo>> {
    const models = await this.listModels(provider);
    return models.find((m) => m.id === model) ?? {
      provider,
      id: model,
      name: model,
      inputModalities: ["text"],
    };
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: AdapterGenerateOptions) => this.stream(options),
    };
  }

  stream(options: AdapterGenerateOptions): AsyncIterable<DshStreamChunk> {
    const prompt = buildPrompt({ system: options.system, messages: options.messages });
    if (prompt === "") return errorFinishStream("PROMPT_FAILED", "Empty request");
    const workspace = this.#deps.resolveWorkspace(options.sessionId);
    return streamDshChunks(
      {
        workspace,
        model: options.model,
        prompt,
        signal: options.signal,
        onDiagnostic: this.#deps.onDiagnostic,
        ...this.#deps.cli,
      },
      {},
    );
  }
}
```

（`ZERO_USAGE` 与 `ZERO_TOKEN_USAGE` 语义不同：前者是 `CliUsage`。若不消费 `ZERO_USAGE` 就删掉该 import——G7。）

- [ ] **Step 4: 跑测试确认通过** — Expected: PASS（新增 5 条 + 既有全绿）。
- [ ] **Step 5: 提交**

```bash
git add src/adapter.ts test/unit/adapter.test.mjs
git commit -m "feat(adapter): OpencodeBridgeAdapter（LlmAdapter 结构化实现）"
```

---

### Task 5: 插件入口 + bundle 打包合同 + 文档回写

**Files:**
- Create: `src/plugin.ts`
- Modify: `src/index.ts`（追加插件导出）
- Modify: `package.json`（加 `dsh.bundle.patch`）
- Create: `cordis.patch.yml`
- Test: `test/unit/plugin.test.mjs`
- Docs: `README.md`、`todo.md`

**Interfaces:**
- Consumes: Task 3 `loadCatalog`、Task 4 `OpencodeBridgeAdapter`。
- Produces: 插件入口导出 `name` / `inject` / `apply`（DSH Host 合同，见附录 A）。

**行为语义：**
1. `export const name = "llm-opencode-bridge"`；`export const inject = ["llm"]`（拿 `ctx.llm`）；**不导出 `Config`**（G7，不引 schemastery）。
2. `apply(ctx)`：
   - 构造 adapter：`resolveWorkspace` 用 G10 顺序（`ctx.get("sessions")` → `ctx.get("workspaceRegistry")` → `process.cwd()`，全部可选链防御）；`listModelEntries` 用 `loadCatalog()`；
   - `const registration = ctx.llm.registerAdapter(["opencode-bridge"], adapter)`；返回 `registration`（disposer，宿主 fiber 销毁时自动回收，参考实现亦只留句柄）。
3. `cordis.patch.yml` 用附录 A 的 insert 形态；`package.json` 增加 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。
4. 文档回写：README 开发状态勾选「DSH LlmAdapter 合同 / 插件入口与配置 / 模型目录与缓存」并更新「当前阶段」；todo.md 在 TODO-01/02/03/04/25 各追加结论段（引用 `docs/research/dsh-llm-contract.md` 与 `docs/research/dsh-plugin-contract.md`），§0 链路状态表更新前两行与模型目录行。

- [ ] **Step 1: 写失败测试** `test/unit/plugin.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { name, inject, apply, resolveWorkspace } from "../../lib/plugin.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("导出合同：name/inject 形态正确", () => {
  assert.equal(name, "llm-opencode-bridge");
  assert.deepEqual(inject, ["llm"]);
});

test("apply 注册 opencode-bridge 路由并返回 disposer", () => {
  let registered = null;
  const fakeHandle = () => {};
  const ctx = {
    llm: { registerAdapter: (providers, adapter) => { registered = { providers, adapter }; return fakeHandle; } },
    get: () => undefined,
  };
  const returned = apply(ctx);
  assert.deepEqual(registered.providers, ["opencode-bridge"]);
  assert.equal(typeof registered.adapter.stream, "function");
  assert.equal(returned, fakeHandle);
});

test("resolveWorkspace：sessions cwd -> registry path -> process.cwd()", () => {
  const ctxSessions = {
    get: (id) => (id === "ses_1" ? { header: { cwd: "F:/project/A" } } : undefined),
  };
  const ctxRegistry = {
    list: () => [{ path: "F:/project/B", sessionIds: ["ses_2"] }],
  };
  assert.equal(resolveWorkspace({ get: (k) => (k === "sessions" ? ctxSessions : k === "workspaceRegistry" ? ctxRegistry : undefined) }, "ses_1"), "F:/project/A");
  assert.equal(resolveWorkspace({ get: (k) => (k === "sessions" ? ctxSessions : k === "workspaceRegistry" ? ctxRegistry : undefined) }, "ses_2"), "F:/project/B");
  assert.equal(resolveWorkspace({ get: () => undefined }, "ses_3"), process.cwd());
  assert.equal(resolveWorkspace({ get: () => undefined }, undefined), process.cwd());
});

test("打包合同：package.json 声明 bundle patch，cordis.patch.yml 含插件行", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  const patch = readFileSync(resolve(root, "cordis.patch.yml"), "utf8");
  assert.match(patch, /id:\s*llm-opencode-bridge/);
  assert.match(patch, /name:\s*'@home-river\/dsh-opencode-bridge'/);
});
```

- [ ] **Step 2: 跑测试确认失败** — Expected: FAIL（`lib/plugin.js` 不存在）。
- [ ] **Step 3: 写 `src/plugin.ts`**

```ts
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
```

- [ ] **Step 4: 修改 `src/index.ts` 与 `package.json`、创建 `cordis.patch.yml`**

`src/index.ts` 顶部追加（保留既有导出）：

```ts
export { name, inject, apply, resolveWorkspace } from "./plugin.js";
export type { PluginContext } from "./plugin.js";
```

`package.json` 增加（与既有 `exports`/`files` 并列）：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

`cordis.patch.yml` 新建：

```yaml
# dsh-opencode-bridge：OpenCode CLI 模型桥（LlmAdapter 插件）
- insert:
    - id: llm-opencode-bridge
      name: '@home-river/dsh-opencode-bridge'
```

- [ ] **Step 5: 跑测试确认通过** — Expected: PASS（新增 4 条 + 既有全绿）。
- [ ] **Step 6: 文档回写**

1. `README.md`：「开发状态」勾选 `DSH LlmAdapter 合同`、`插件入口与配置`、`模型目录与缓存` 三项；「当前阶段」补一段：子项目 3 完成，剩 DSH 实机联调（TODO-27~30）。
2. `todo.md`：
   - TODO-01 追加结论：`ctx.llm.registerAdapter(["opencode-bridge"], adapter)`，`inject:["llm"]`，句柄随 fiber 销毁；
   - TODO-02 追加结论：七方法合同逐字见 `docs/research/dsh-llm-contract.md` §3，本包结构化实现；
   - TODO-03 追加结论：`GenerateOptions` 真实字段逐字见研究件 §4，**无 workspace 字段**；
   - TODO-04 追加结论：workspace 途径 `ctx.sessions.get(sessionId).header.cwd` → `workspaceRegistry` → `process.cwd()`（G10）；
   - TODO-25 追加结论：bundle 合同（`dsh.bundle.patch` + `cordis.patch.yml` insert 行）已落地；
   - §0 链路状态表：前两行更新为「部分验证（代码完成，待实机）」。

- [ ] **Step 7: 提交**

```bash
git add src/plugin.ts src/index.ts package.json cordis.patch.yml test/unit/plugin.test.mjs README.md todo.md
git commit -m "feat(adapter): 插件入口、bundle 打包合同与文档回写"
```

---

## 附录 A：插件入口合同关键摘录（调研原件的约束来源）

- 导出形态（asar 292559-292562）：`export function apply(ctx, config)` + 可选 `export const inject` / `export const Config`，或默认导出 service class，二选一。
- 参考实现（855428-855431）：`const name = "llm-deepseek-account"; const inject = ["llm"]; function apply(ctx, config) {...}`。
- 注册（858695）：`const registration = ctx.llm.registerAdapter([provider], adapter);`；服务端 `ctx.effect(...)` 托管、`Disposed with the fiber`（865524）。
- bundle manifest（292520-292527）：`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。
- patch 插入模板（292532-292537）：`- insert:\n    - id: my-plugin\n      name: '@local/my-plugin'\n      config: {}`。
- workspace 途径（287612-287613 / 1074999 / 290288）：`ctx.sessions.get(options.sessionId)?.header.cwd`；`ctx.workspaceRegistry.list().filter(w => w.sessionIds.includes(id))`。

## Self-Review 记录

1. **Spec 覆盖：** 子项目 3 的四件套——LlmAdapter 合同（Task 4）、插件入口（Task 5）、模型目录与缓存（Task 2/3）、消息压平（Task 1）——各有任务承接；spec 子项目 5 的 HTTP 层按 G7 砍掉（CLI→cache→static 三级）。缺口：无。
2. **占位符扫描：** 无 TBD/占位步骤；`discoverOpencodeCli` 的返回形态已核实（async + `{ command, source }` + 失败抛 `CliBridgeError`），Task 3 代码与之一致。
3. **类型一致性：** `CatalogModel`/`toModelInfo`（Task 2）被 Task 3/4 消费；`OpencodeBridgeDeps`/`AdapterGenerateOptions`（Task 4）被 Task 5 消费；`name`/`inject`/`apply`/`resolveWorkspace`（Task 5）与测试一致。
4. **裁定记录：** ①不导出 `Config`（避免 schemastery 依赖）；②不做 session 持久化（子项目 4）；③`resolveModel` 目录未命中不拒绝（目录仅建议）；④空请求不 spawn CLI、直接 error finish；⑤`listModels` 结果恒过 `mergeVerified`（目录漂移防护）。
