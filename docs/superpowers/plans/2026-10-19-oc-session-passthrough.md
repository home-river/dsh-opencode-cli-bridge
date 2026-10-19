# OC 会话一对一透传改造（Session Passthrough）执行计划与原因结论

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> （本计划由用户本人审查后执行；任务步骤自包含，可逐任务独立实施与验收。）

**Goal:** 把插件从「prompt 全量重建适配器」改造成「DSH 会话 ↔ OC 会话 1:1 透传桥」：DSH 消息增量透传进持久绑定的 OC 会话，OC 的正文/思考/工具产出全量回传 DSH。

**Architecture:** 新增 SessionStore（DSH 会话 ↔ OC 会话绑定 + 消息账本）；`opencode run --session` 续接 OC 自有历史（工具结果跨轮天然可见）；prompt 层从全量压平改为增量发送；回传层新增 reasoning 块（思考原生透传）与工具镜像（借 reasoning 块的皮，防 DSH 双重执行）；会话失效时回退「重建 + 全量重放」。

**Tech Stack:** TypeScript（tsc 编译至 `lib/`）、`node:test` + `node:assert/strict`、OpenCode CLI `run --format json --auto`（JSON Lines 事件流）。

**Spec:** 本文档自包含（含原因结论）。相关背景：`issues/ISSUE-008-subagent-zero-text-close.md`、`issues/ISSUE-009-startup-timer-never-cleared.md`、`docs/SUBAGENT-BEHAVIOR.md`、`docs/superpowers/specs/2026-10-15-oc-cli-bridge-design.md`（§8.1 超时分层继续有效）。

---

## 0. 原因结论（为什么改、依据是什么）

### 0.1 事故链（2026-10-19 实测）

子代理派发实测中 3 个 free 模型首轮全部「工具调用 + 零文本」收尾、结果丢失（ISSUE-008）。追根后确认是**两个独立缺陷**：

1. **33s 死刑墙（ISSUE-009，已修复）**：`run-cli.ts` 的 `startupMs`（30s）计时器注册后无人清除，杀掉一切 >30s 的回合（+3s 宽限 = 33s 墙）；超时死亡又被「陈旧 step_finish(tool-calls) + 零文本保险」伪装成正常提示语。
2. **跨回合工具结果不回灌（本计划解决）**：每轮都是全新 `opencode run`（不带 `--session`），跨轮"记忆"靠 `prompt.ts` 把 DSH 消息历史**压平成纯文本**重发，而压平只保留文本块——工具调用/结果既不在 OC 会话里、也不在文本转录里。模型只"知道跑过 bash"（来源还是那句兜底提示语），看不到输出。

### 0.2 现架构的结构性问题（证据）

| 证据 | 出处 | 结论 |
|---|---|---|
| `adapter.stream()` 调 `streamDshChunks` 时**未传 `sessionId`** → `buildArgs` 永不加 `--session` | `src/adapter.ts:135-148`、`src/cli-bridge.ts:72` | 每轮新会话，OC 历史从不复用 |
| `buildPrompt` 只保留 `block.type === "text"` | `src/prompt.ts:37-47` | 工具/思考内容在重放中消失 |
| 失败回合的历史 `Assistant:` 位置是"[OC-bridge] 本轮…"提示语 | ISSUE-008 | 回放历史失真，模型"记得"假话 |
| OC 事件自带 `sessionID`，`mapper.sessionId` 已捕获但被丢弃 | `src/map-events.ts:88-89` | 会话 id 触手可得，只缺持久化 |
| DSH 消息含 `reasoning`/`tool-call` 原生块类型 | `src/dsh-types.ts:79-126` | 回传有原生载体 |
| **tool-call 块会触发 DSH 执行工具**（`content.filter(b => b.type === "tool-call")` 非空即 `executeToolCalls`，与 finish 无关） | asar 实测 `dsh-agent-loop/lib/index.js:1164-1166` | 镜像工具**不得**发 tool-call 块，否则双重执行 |
| DSH 工具卡片默认折叠（collapsed-by-default card body） | asar 实测 `dsh-client-ui-tool/lib/client.js:2901` | 折叠/收起呈现机制存在，可借用 |
| `--format json` 整段吐，step_start→text 静默=整个生成期（800 字实测 46.5s） | `docs/superpowers/specs/2026-10-15-oc-cli-bridge-design.md` §8.1 | 超时分层沿用；真流式需 serve 二期 |

### 0.3 方案裁定（与理由）

| 裁定 | 理由 |
|---|---|
| **传输层用 `opencode run --session`（路线 A）**，`opencode serve` + SSE 留二期 | A 改动小、复用全部现有链路，且已解决核心问题（工具结果跨轮可见）；B 是真流式完全体但引入服务生命周期/鉴权，YAGNI |
| **增量透传**：只发新消息，账本记"已送达条数" | 全量重发 + 会话续接 = 历史翻倍 |
| **回传全镜像（选 A）**：正文 + 思考 + 工具调用/结果 | 模型侧反正全量可见（OC 会话账本），镜像只决定"给人看多少"；用户裁定全量 |
| **思考走原生 `reasoning` 块** | 纯展示物，agent 循环不消费，零风险 |
| **工具镜像借 `reasoning` 块的皮**（结构化文本） | tool-call 块会触发 DSH 执行（0.2 证据），同名工具（bash/read/write…）双重执行有真实副作用；reasoning 皮同样"折叠+答完收起" |
| **system 仅在变化时随增量发送**（哈希比对） | 兼顾忠实透传与 OC 历史膨胀 |
| **会话失效回退**：重建 OC 会话 + 全量重放（现行为降级为兜底） | `--session` 对无效 id 报错（已有 probe 场景），必须有出路 |

---

## 1. 目标架构与数据流

```
DSH session (messages[])                     OC session (ses_*)
      │                                            ▲
      │ stream(options)                            │
      ▼                                            │
┌─────────────────┐  delta prompt (新消息+system)  │
│ adapter.ts      │ ────────────────────────────► │ opencode run --session
│  SessionStore   │ ◄──────────────────────────── │ JSON Lines 事件流
│  buildDelta     │  text / reasoning / tool 事件  │
└─────────────────┘                               │
      │ DshStreamChunk                            │
      ▼                                           │
DSH 会话框：text 块（正文）                        │
           reasoning 块（思考 + 工具镜像）← 折叠/收起
```

- **绑定**：首轮创建 OC 会话 → 存 `{dshSessionId → ocSessionId, sentCount, systemHash}`；续轮 `--session` 续接。
- **账本**：`sentCount` = 已送达 OC 的消息条数；首事件到达时推进（证明 OC 已接收）。
- **一致性**：DSH 消息数 < 账本（编辑/分支/回滚）→ 判定漂移 → 重建会话 + 全量重放 + 账本重置。

## 2. 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/session-store.ts` | 新建 | DSH↔OC 会话绑定、消息账本、原子落盘 |
| `src/prompt.ts` | 修改 | 新增 `buildDeltaPrompt`（增量）；保留 `buildPrompt`（全量重放，兜底用） |
| `src/types.ts` | 修改 | `CliBridgeEvent` 增 `kind: "reasoning"` |
| `src/map-events.ts` | 修改 | OC `reasoning` 事件 → `CliReasoningEvent` |
| `src/to-dsh-chunks.ts` | 修改 | reasoning 块产出；工具镜像（reasoning 皮）；保留零文本保险 |
| `src/adapter.ts` | 修改 | 编排：绑定查找、增量调度、账本推进、失效回退 |
| `test/unit/session-store.test.mjs` | 新建 | Task 1 测试 |
| 其余 `test/unit/*.test.mjs` | 修改 | 各任务对应测试 |
| `test/integration/cli-bridge.real.test.mjs` | 修改 | R12 多轮工具上下文用例 |

## 3. Global Constraints

- Node ≥ 20；TypeScript strict；编译产物在 `lib/`（测试 import `../../lib/*.js`，**改 src 后必须先 `npx tsc -p tsconfig.json` 再跑测试**）。
- 全量单测必须保持全绿（当前基线 210 条）；新增测试一律先红后绿。
- `tmp-*` 文件不入库；issue 规则见 `AGENTS.md`（关键 bug 立 issue）。
- 超时分层不动（`DEFAULT_TIMEOUTS`：startup 30s / firstEvent 45s / idle 600s / total 1800s / shutdown 3s，spec §8.1）。
- 架构原则不变：**prompt 不做工具声明**；工具执行面归属 OC。
- 提交信息格式：`feat(session): ...` / `test(session): ...` / `docs(session): ...`。

## 4. 执行任务

### Task 1: SessionStore（绑定与账本持久化）

**Files:**
- Create: `src/session-store.ts`
- Test: `test/unit/session-store.test.mjs`

**Interfaces:**
- Produces（后续任务依赖，签名以此为准）:
  - `interface SessionBinding { dshSessionId: string; ocSessionId: string; workspace: string; sentCount: number; systemHash: string; updatedAt: string }`
  - `class SessionStore { constructor(file: string); get(dshSessionId: string): SessionBinding | undefined; save(binding: SessionBinding): void; delete(dshSessionId: string): void }`
  - `function hashText(text: string): string`（导出，Task 2/6 复用；实现用 `node:crypto` 的 sha1 截断 16 hex）

- [ ] **Step 1: 写失败测试** `test/unit/session-store.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, hashText } from "../../lib/session-store.js";

function tmp() { return mkdtempSync(join(tmpdir(), "ocbridge-sess-")); }

test("get/save/delete 往返", () => {
  const dir = tmp();
  try {
    const file = join(dir, "sessions.json");
    const store = new SessionStore(file);
    assert.equal(store.get("ses_dsh_1"), undefined);
    store.save({ dshSessionId: "ses_dsh_1", ocSessionId: "ses_oc_1", workspace: dir, sentCount: 3, systemHash: hashText("sys"), updatedAt: new Date().toISOString() });
    assert.equal(store.get("ses_dsh_1").ocSessionId, "ses_oc_1");
    // 重新打开（模拟进程重启）后仍可读
    const reopened = new SessionStore(file);
    assert.equal(reopened.get("ses_dsh_1").sentCount, 3);
    reopened.delete("ses_dsh_1");
    assert.equal(new SessionStore(file).get("ses_dsh_1"), undefined);
    assert.ok(existsSync(file));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("save 覆盖同 id 旧绑定（账本推进）", () => {
  const dir = tmp();
  try {
    const store = new SessionStore(join(dir, "sessions.json"));
    store.save({ dshSessionId: "a", ocSessionId: "oc", workspace: dir, sentCount: 1, systemHash: "", updatedAt: "" });
    store.save({ dshSessionId: "a", ocSessionId: "oc", workspace: dir, sentCount: 5, systemHash: "h", updatedAt: "" });
    assert.equal(store.get("a").sentCount, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("hashText 稳定且区分内容", () => {
  assert.equal(hashText("x"), hashText("x"));
  assert.notEqual(hashText("x"), hashText("y"));
});
```

- [ ] **Step 2: 跑测试确认失败**：`node test/unit/session-store.test.mjs` → 期望 `Cannot find module '../../lib/session-store.js'`
- [ ] **Step 3: 实现** `src/session-store.ts`

```ts
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export interface SessionBinding {
  dshSessionId: string;
  ocSessionId: string;
  workspace: string;
  sentCount: number;
  systemHash: string;
  updatedAt: string;
}

export function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** 进程内单例缓存 + 整文件原子写（tmp + rename）；DSH 单进程内并发请求安全。 */
export class SessionStore {
  readonly #file: string;
  readonly #map = new Map<string, SessionBinding>();

  constructor(file: string) {
    this.#file = file;
    if (existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8")) as { bindings?: SessionBinding[] };
        for (const b of data.bindings ?? []) this.#map.set(b.dshSessionId, b);
      } catch { /* 损坏文件按空库处理，触发上层重同步 */ }
    }
  }

  get(dshSessionId: string): SessionBinding | undefined {
    return this.#map.get(dshSessionId);
  }

  save(binding: SessionBinding): void {
    this.#map.set(binding.dshSessionId, binding);
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = join(dirname(this.#file), `.sessions.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ bindings: [...this.#map.values()] }, null, 2));
    renameSync(tmp, this.#file);
  }

  delete(dshSessionId: string): void {
    this.#map.delete(dshSessionId);
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = join(dirname(this.#file), `.sessions.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ bindings: [...this.#map.values()] }, null, 2));
    renameSync(tmp, this.#file);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**：`node test/unit/session-store.test.mjs` → PASS
- [ ] **Step 5: 提交**：`git add src/session-store.ts test/unit/session-store.test.mjs && git commit -m "feat(session): SessionStore 会话绑定与消息账本"`

### Task 2: 增量 prompt 构建器

**Files:**
- Modify: `src/prompt.ts`
- Test: `test/unit/prompt.test.mjs`（已存在，追加用例）

**Interfaces:**
- Consumes: `hashText`（Task 1）
- Produces:
  - `interface BuildDeltaInput { system?: string; messages: readonly PromptMessage[]; sentCount: number; systemHash: string }`
  - `interface DeltaPrompt { text: string; nextSentCount: number; nextSystemHash: string }`
  - `function buildDeltaPrompt(input: BuildDeltaInput): DeltaPrompt`

- [ ] **Step 1: 写失败测试**（追加到 `test/unit/prompt.test.mjs`）

```js
import { buildDeltaPrompt } from "../../lib/prompt.js";
import { hashText } from "../../lib/session-store.js";

test("buildDeltaPrompt：只发新消息，system 变化才随发", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "第一问" }] },
    { role: "assistant", content: [{ type: "text", text: "第一答" }] },
    { role: "user", content: [{ type: "text", text: "第二问" }] },
  ];
  // 从账本 0 起步、system 首次发送
  const first = buildDeltaPrompt({ system: "S1", messages: msgs, sentCount: 0, systemHash: "" });
  assert.ok(first.text.includes("System:\nS1"));
  assert.ok(first.text.includes("第一问") && first.text.includes("第二问"));
  assert.equal(first.nextSentCount, 3);
  assert.equal(first.nextSystemHash, hashText("S1"));
  // 已送 2 条、system 未变：只发第三条、无 System 段
  const second = buildDeltaPrompt({ system: "S1", messages: msgs, sentCount: 2, systemHash: hashText("S1") });
  assert.ok(!second.text.includes("System:"));
  assert.ok(second.text.includes("第二问") && !second.text.includes("第一问"));
  assert.equal(second.nextSentCount, 3);
});

test("buildDeltaPrompt：system 变化时随增量重发 system 段", () => {
  const msgs = [{ role: "user", content: [{ type: "text", text: "q" }] }];
  const d = buildDeltaPrompt({ system: "S2", messages: msgs, sentCount: 0, systemHash: hashText("S1") });
  assert.ok(d.text.includes("System:\nS2"));
});
```

- [ ] **Step 2: 跑测试确认失败**：`node test/unit/prompt.test.mjs` → `buildDeltaPrompt is not a function`
- [ ] **Step 3: 实现**（`src/prompt.ts` 末尾追加；`hashText` 从 `./session-store.js` 导入）

```ts
export interface BuildDeltaInput {
  system?: string;
  messages: readonly PromptMessage[];
  sentCount: number;
  systemHash: string;
}
export interface DeltaPrompt {
  text: string;
  nextSentCount: number;
  nextSystemHash: string;
}

/** 增量透传：只渲染 [sentCount, end) 的新消息；system 仅在内容变化时随发。 */
export function buildDeltaPrompt(input: BuildDeltaInput): DeltaPrompt {
  const sections: string[] = [];
  const sys = input.system ?? "";
  const sysHash = sys === "" ? input.systemHash : hashText(sys);
  if (sys !== "" && sysHash !== input.systemHash) {
    sections.push(`System:\n${sys}`);
  }
  for (const message of input.messages.slice(input.sentCount)) {
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
  return {
    text: sections.join("\n\n"),
    nextSentCount: input.messages.length,
    nextSystemHash: sysHash,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**：`node test/unit/prompt.test.mjs` → PASS
- [ ] **Step 5: 提交**：`git add src/prompt.ts test/unit/prompt.test.mjs && git commit -m "feat(session): 增量 prompt 构建器 buildDeltaPrompt"`

### Task 3: reasoning 事件映射

**Files:**
- Modify: `src/types.ts`、`src/map-events.ts`
- Test: `test/unit/map-events.test.mjs`（追加）

**Interfaces:**
- Produces: `interface CliReasoningEvent { kind: "reasoning"; sessionId: string; messageId?: string; text: string }`（加入 `CliBridgeEvent` 联合）

- [ ] **Step 1: 写失败测试**（追加到 `test/unit/map-events.test.mjs`）

```js
test("reasoning 事件 -> CliReasoningEvent（part.text 透传）", () => {
  const m = new OpenCodeEventMapper();
  const r = m.push({ type: "reasoning", sessionID: "ses_1", part: { type: "reasoning", text: "思考内容" } });
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "reasoning");
  assert.equal(r.events[0].text, "思考内容");
  assert.equal(r.diagnostics.length, 0, "reasoning 不得再落 unknown-event 诊断");
});
```

- [ ] **Step 2: 跑测试确认失败**：`node test/unit/map-events.test.mjs` → 断言失败（当前 reasoning 落 unknown-event）
- [ ] **Step 3: 实现**：
  - `src/types.ts`：`CliBridgeEvent` 联合中增加 `CliReasoningEvent`（字段见 Interfaces）；
  - `src/map-events.ts` 的 `switch (raw.type)` 增加：

```ts
      case "reasoning": {
        const text = typeof part.text === "string" ? part.text : "";
        events.push({ kind: "reasoning", sessionId, messageId, text });
        break;
      }
```

- [ ] **Step 4: 跑测试确认通过**：`node test/unit/map-events.test.mjs` → PASS
- [ ] **Step 5: 提交**：`git add src/types.ts src/map-events.ts test/unit/map-events.test.mjs && git commit -m "feat(session): reasoning 事件映射"`

### Task 4: 回传映射——reasoning 块 + 工具镜像（reasoning 皮）

**Files:**
- Modify: `src/to-dsh-chunks.ts`
- Test: `test/unit/to-dsh-chunks.test.mjs`、`test/unit/stream-dsh-chunks.test.mjs`（更新既有断言 + 新增）

**Interfaces:**
- Consumes: `CliReasoningEvent`（Task 3）；既有 `tool` 事件的 `raw`（`part.tool` / `part.callID` / `part.state.{status,input,output}`）
- Produces: `DshStreamChunk` 新增 `blockType: "reasoning"` 的 block-start / `reasoning-delta` / block-end 序列；工具镜像文本格式（约定）：

```
🔧 <tool> <input 摘要≤200字符>
└─ <status> | <output 截断至 2000 字符>
```

- [ ] **Step 1: 写失败测试**（追加到 `test/unit/to-dsh-chunks.test.mjs`）

```js
test("reasoning 事件 -> reasoning 块（reasoning-delta 序列）", () => {
  const c = new DshChunkConverter({ chunkSize: 64 });
  const out = [
    ...c.push({ kind: "reasoning", sessionId: "s", text: "思考一二三" }),
    ...c.end(),
  ];
  assert.equal(out[0].type, "block-start");
  assert.equal(out[0].blockType, "reasoning");
  assert.equal(out.filter((x) => x.type === "reasoning-delta").map((x) => x.text).join(""), "思考一二三");
});

test("工具镜像：tool_use 完成态 -> reasoning 皮镜像块（含工具名/输出），不再裸产 🔧 行", () => {
  const c = new DshChunkConverter({ chunkSize: 64 });
  const out = [
    ...c.push({
      kind: "tool", sessionId: "s",
      raw: { type: "tool_use", part: { tool: "bash", callID: "c1",
        state: { status: "completed", input: { command: "ls" }, output: "a.txt" } } },
    }),
    ...c.end(),
  ];
  const body = out.filter((x) => x.type === "reasoning-delta").map((x) => x.text).join("");
  assert.ok(body.includes("🔧 bash"), body);
  assert.ok(body.includes("a.txt"), body);
  // 不得再出现旧的独立文本进度块
  assert.ok(!out.some((x) => x.type === "text-delta" && x.text.includes("🔧")));
});

test("工具镜像输出截断至 2000 字符", () => {
  const c = new DshChunkConverter();
  const out = c.push({
    kind: "tool", sessionId: "s",
    raw: { type: "tool_use", part: { tool: "bash", callID: "c1",
      state: { status: "completed", input: {}, output: "x".repeat(5000) } } },
  });
  const body = out.filter((x) => x.type === "reasoning-delta").map((x) => x.text).join("");
  assert.ok(body.length <= 2200, String(body.length));
});
```

- [ ] **Step 2: 跑测试确认失败**：`node test/unit/to-dsh-chunks.test.mjs` → 新用例红
- [ ] **Step 3: 实现**（`DshChunkConverter.push` 内）：
  - `case "reasoning"`：与 `case "text"` 同构，但块类型为 `"reasoning"`、delta 为 `reasoning-delta`，`#sawText` **不**置位（思考不算正文）；
  - `case "tool"`：删除原 🔧 文本行产出，改为：事件 `raw.type !== "tool_result"` 且 `part.state?.status === "completed"`（或 `raw.type === "tool_result"`）时，按 Interfaces 的格式合成镜像文本，产出 reasoning 块；callID 去重保留（同一 callID 只镜像一次，取最终完成态）；
  - 零文本保险**保持不变**（真·工具轮零正文仍以提示语收尾，其 `#sawText` 语义不受 reasoning 影响）。

> 注意：既有测试「工具事件回流：tool_use 产出可见进度块（🔧 行）…」「fake tool-only -> 工具进度可见 + 零文本保险」等断言了旧的 🔧 文本行形态，需同步更新为 reasoning 皮断言（保留"可见进度 + 零文本保险 + finish(stop)"的语义，只换载体）。

- [ ] **Step 4: 跑测试确认通过**：`npx tsc -p tsconfig.json && node test/unit/to-dsh-chunks.test.mjs && node test/unit/stream-dsh-chunks.test.mjs` → 全 PASS
- [ ] **Step 5: 提交**：`git add src/to-dsh-chunks.ts test/unit/to-dsh-chunks.test.mjs test/unit/stream-dsh-chunks.test.mjs && git commit -m "feat(session): 回传映射 reasoning 块 + 工具镜像"`

### Task 5: adapter 编排——绑定、增量调度、账本推进、失效回退

**Files:**
- Modify: `src/adapter.ts`
- Test: `test/unit/adapter.test.mjs`（追加）

**Interfaces:**
- Consumes: `SessionStore`/`hashText`（Task 1）、`buildDeltaPrompt`（Task 2）
- Produces: `OpencodeBridgeAdapter` 构造 deps 新增 `sessionStore: SessionStore`（必填）；`stream(options)` 语义见下

**语义（核心决策，实现必须逐条满足）：**

1. 查绑定：`binding = sessionStore.get(options.sessionId ?? "")`。
2. 漂移检测：`options.messages.length < binding.sentCount` → 丢弃绑定（`sessionStore.delete`），按全量重放处理（`sentCount=0`）。
3. 增量：`buildDeltaPrompt({...})`；`delta.text === ""` 且无绑定 → 维持现状 `errorFinishStream("PROMPT_FAILED", "Empty request")`；`delta.text === ""` 且有绑定（重试/无新消息）→ 重发最后一条消息（接受 OC 历史重复，见 §6 局限）。
4. 调度：`streamDshChunks({ workspace, model, prompt: delta.text, sessionId: binding?.ocSessionId, variant, signal, ...cli })`。
5. 账本推进：流中**首个 OC 事件**（任意 kind 且带 `sessionId`）到达时，`sessionStore.save({ ...binding, ocSessionId: <事件里的 sessionId>, sentCount: delta.nextSentCount, systemHash: delta.nextSystemHash, updatedAt: now })`；若之后回合失败，账本不再回退（消息已送达 OC，重发会重复）。
6. 失效回退：终态为 `error` 且 `failure.code === "SESSION_INVALID"`（或 `UPSTREAM_ERROR` 且 stderr 含 "Session not found"）→ `sessionStore.delete` + 以**全量重放**（`buildPrompt` 全历史）重试**一次**（新 OC 会话）。
7. `onRequestStart` 取证钩子的 info 增加 `ocSessionId?: string` 字段（便于 requests.log 追踪绑定）。

- [ ] **Step 1: 写失败测试**（追加到 `test/unit/adapter.test.mjs`；沿用其 `makeAdapter` 辅助，注入 `sessionStore` 到 tmp 目录）

```js
test("绑定复用：第二轮把 OC 会话 id 经 --session 传给 CLI", async () => {
  const { dir, adapter, deps } = makeAdapter({ cli: { command: process.execPath, extraArgs: [FAKE, "mode:session-echo"] } });
  deps.sessionStore = new SessionStore(join(dir, "sessions.json"));
  const msgs = (n) => [{ role: "user", content: [{ type: "text", text: `msg-${n}` }] }];
  const run = async (list) => {
    const out = [];
    for await (const c of adapter.stream({ provider: "opencode-bridge", model: "opencode/mimo-v2.6-flash-free", messages: list, sessionId: "dsh-s1" })) out.push(c);
    return out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
  };
  await run(msgs(1));
  assert.ok(deps.sessionStore.get("dsh-s1").sentCount === 1);
  const t2 = await run([...msgs(1), { role: "assistant", content: [{ type: "text", text: "a" }] }, ...msgs(2)]);
  assert.ok(t2.includes("SESSION="), t2); // session-echo 回显 --session 收到的值
});

test("漂移回退：消息数小于账本 -> 重建会话全量重放", async () => {
  const { dir, adapter, deps } = makeAdapter({ cli: { command: process.execPath, extraArgs: [FAKE, "mode:session-echo"] } });
  deps.sessionStore = new SessionStore(join(dir, "sessions.json"));
  deps.sessionStore.save({ dshSessionId: "dsh-s2", ocSessionId: "ses_old", workspace: dir, sentCount: 99, systemHash: "", updatedAt: "" });
  const out = [];
  for await (const c of adapter.stream({ provider: "opencode-bridge", model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], sessionId: "dsh-s2" })) out.push(c);
  const text = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
  assert.ok(text.includes("SESSION=null") || text.includes("SESSION=undefined"), text);
});

test("会话失效：SESSION_INVALID -> 删除绑定并全量重放一次", async () => {
  const { dir, adapter, deps } = makeAdapter({ cli: { command: process.execPath, extraArgs: [FAKE, "mode:session-not-found"] } });
  deps.sessionStore = new SessionStore(join(dir, "sessions.json"));
  deps.sessionStore.save({ dshSessionId: "dsh-s3", ocSessionId: "ses_dead", workspace: dir, sentCount: 1, systemHash: "", updatedAt: "" });
  const out = [];
  for await (const c of adapter.stream({ provider: "opencode-bridge", model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }, { role: "user", content: [{ type: "text", text: "again" }] }], sessionId: "dsh-s3" })) out.push(c);
  assert.equal(deps.sessionStore.get("dsh-s3"), undefined, "失效绑定应被清除（重放后按新绑定重建由首事件推进）");
});
```

- [ ] **Step 2: 跑测试确认失败**：`node test/unit/adapter.test.mjs` → 新用例红（deps 无 sessionStore 等）
- [ ] **Step 3: 实现**（按上面「语义」七条逐条落码；`deps` 类型补 `sessionStore: SessionStore`）。`stream()` 核心草图（与现有 `#wrapSummary` 取证钩子合并）：

```ts
stream(options: AdapterGenerateOptions): AsyncIterable<DshStreamChunk> {
  const dshId = options.sessionId ?? "";
  const store = this.#deps.sessionStore;
  let binding = store.get(dshId);
  // 语义 2：漂移检测
  if (binding && options.messages.length < binding.sentCount) {
    store.delete(dshId);
    binding = undefined;
  }
  // 语义 3：增量构建
  const delta = buildDeltaPrompt({
    system: options.system,
    messages: options.messages,
    sentCount: binding?.sentCount ?? 0,
    systemHash: binding?.systemHash ?? "",
  });
  const prompt = delta.text !== ""
    ? delta.text
    : (binding ? buildPrompt({ messages: options.messages.slice(-1) }) : ""); // 语义 3 后半：无新消息时重发末条
  if (prompt === "") return errorFinishStream("PROMPT_FAILED", "Empty request");
  const workspace = this.#deps.resolveWorkspace(options.sessionId);
  let advanced = false;
  const advance = (ocSessionId: string) => {           // 语义 5：首事件推进账本
    if (advanced || !options.messages.length) return;
    advanced = true;
    store.save({
      dshSessionId: dshId, ocSessionId, workspace,
      sentCount: delta.nextSentCount, systemHash: delta.nextSystemHash,
      updatedAt: new Date().toISOString(),
    });
  };
  const inner = streamDshChunks({
    workspace, model: options.model, prompt,
    sessionId: binding?.ocSessionId,                 // 语义 4：--session 续接
    variant: variantForEffort(options.reasoningEffort),
    signal: options.signal,
    onDiagnostic: this.#deps.onDiagnostic,
    ...this.#deps.cli,
  }, {});
  return this.#wrapSummary(withSessionCapture(inner, advance, () => this.#resyncOnce(options)), options.model);
  // 语义 6：#resyncOnce —— 终态 error 且 code ∈ {SESSION_INVALID, UPSTREAM_ERROR(含 "Session not found")}
  // 时 store.delete(dshId)，用 buildPrompt 全历史 + 无 sessionId 重跑一次（新 OC 会话），只补一次。
}
```

（`withSessionCapture` 为小工具生成器：透传 chunk，见首个带 `sessionId` 的事件时调 `advance`；实现放在 `adapter.ts` 内部即可，无需新文件。）
- [ ] **Step 4: 跑测试确认通过**：`npx tsc -p tsconfig.json && node test/unit/adapter.test.mjs` → PASS
- [ ] **Step 5: 全量回归**：`npm test` → 210 基线 + 新增全绿
- [ ] **Step 6: 提交**：`git add src/adapter.ts test/unit/adapter.test.mjs && git commit -m "feat(session): adapter 会话绑定与增量调度"`

### Task 6: 端到端验收 + 集成用例 + 文档

**Files:**
- Modify: `test/integration/cli-bridge.real.test.mjs`（追加 R12）
- Modify: `memory.md`、`README.md`

- [ ] **Step 1: 集成用例 R12（真实 CLI，`OCBRIDGE_IT=1` 门控）**，追加到 `test/integration/cli-bridge.real.test.mjs`（沿用文件内 `RUN`/`mkws`/`cleanup`/`SLOW` 辅助）：

```js
RUN("R12 多轮工具上下文：第二轮可见第一轮的工具输出", async () => {
  const dir = mkws();
  try {
    // 第一轮：诱导工具调用（列目录），工具会看到 alpha.txt / beta.md
    const a = await runCliBridge({
      workspace: dir, model: MODEL, timeouts: SLOW,
      prompt: "请用工具列出当前目录下的文件，然后只回复：已列出",
    });
    assert.equal(a.finishReason, "stop");
    // 第二轮：追问工具输出内容 —— 只有 OC 会话账本里带着 tool 结果才答得出
    const b = await runCliBridge({
      workspace: dir, model: MODEL, timeouts: SLOW,
      sessionId: a.sessionId,
      prompt: "你上一轮列目录的输出里出现了哪些文件名？只返回文件名，逗号分隔",
    });
    assert.ok(b.text.includes("alpha.txt"), b.text);
    assert.ok(b.text.includes("beta.md"), b.text);
  } finally { await cleanup(dir); }
});
```

判定要点：若退回"每轮新会话+文本压平"的老行为，第二轮必然答不出文件名（工具输出不在上下文）——此用例即问题 2 的回归护栏。

- [ ] **Step 2: 手工 E2E（复刻事故现场）**：
  1. 重启 DSH（junction 安装，须重载插件）；
  2. 派 opencode 子代理执行 `test/simulation/subagent-sim.test.mjs` 并回报（复刻 ISSUE-008 现场）→ 期望完整报告；
  3. 对同一子代理**追问**「你上一轮 bash 输出的汇总行是什么？」→ 期望**引用真实输出**（问题 2 治愈的验收点）；
  4. 检查 `~/.dsh-opencode-bridge/sessions.json` 出现绑定、`requests.log` 新增 ocSessionId 字段。
- [ ] **Step 3: 文档**：`memory.md` 追加本轮记录；`README.md` 补「会话绑定」说明；若遇新关键 bug 按 AGENTS.md 立 issue。
- [ ] **Step 4: 提交**：`git add test/integration/ memory.md README.md && git commit -m "docs(session): R12 多轮工具上下文验收与文档"`

## 5. 验收标准（全部满足才算完成）

- [ ] `npm test` 全绿（210 基线 + 新增）；`npm run typecheck` 无错误。
- [ ] R12（或手工 E2E 第 3 步）证明：**追问时模型能引用上一轮的工具输出**。
- [ ] 子代理复刻现场：工具 + 报告同回合完整交付（不再出现伪装提示语）。
- [ ] `sessions.json` 中 DSH↔OC 绑定正确；`requests.log` 可追踪 ocSessionId。
- [ ] 失效回退演练：手工删掉 OC 会话（或指向无效 id）后，下一轮自动重建并正常回答。

## 6. 已知局限与后续（本轮不做）

1. **重试重复追加**：回合失败后 DSH 重试可能把同一消息再送一次（OC 历史出现重复 user 消息）。既有原则「产出过正文即不重试」大幅降低触发面；彻底解法需 OC 侧幂等键，留待观察。
2. **真流式**：`run --format json` 整段吐，打字机是模拟节奏。二期换 `opencode serve` + SSE（真 token 流 + 常驻会话）。
3. **工具镜像无真工具卡片**：借 reasoning 皮（折叠/收起）。长期正解是给 DSH 上游提「display-only tool-call 块」需求（渲染但不执行）。
4. **OC 历史中的 system 段累积**：system 变化即随发；OC 侧长会话治理靠其自身 compaction。
5. **glm-5.3-flash-free 出字慢**：体验问题非架构问题，交付型任务建议 deepseek-v4.1 / mimo-v2.6。
6. **上游 error 原文不透传**（旧裁定延续）：网关 403 等上游错误目前只报 generic failure（`Upstream model error`），原文进了 diagnostics 但不进会话。透传化后建议跟进（error 事件原文以文本块回传一次再收 error finish），本轮不动，避免与错误语义改造纠缠。
