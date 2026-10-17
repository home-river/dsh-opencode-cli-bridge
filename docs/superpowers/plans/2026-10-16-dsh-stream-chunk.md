# DSH StreamChunk 转换器（子项目 2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `CliBridgeEvent` 流转换为 DSH `StreamChunk` 流（`block-start` / `text-delta` / `block-end` / `usage` / `finish`），用切块模拟流式，为子项目 3 的 `LlmAdapter.stream()` 提供就绪的输出层。

**Architecture:** 三个纯模块加一层组装：`dsh-types.ts` 逐字镜像 DSH 公共类型合同（本包不 import DSH 运行时）；`chunk-text.ts` 独立切块器（方案 A 的数据源可替换点）；`to-dsh-chunks.ts` 是无 Node API 的状态机 + 异步包装，消费 `streamCliBridge` 的事件流并产出 DSH chunk；`cli-bridge.ts` 增加 `streamDshChunks` 组合入口。

**Tech Stack:** TypeScript 5.6（strict、ESM、tsc 编译到 `lib/`）、node:test（零 runtime 依赖）、fake CLI 测试替身。

**Spec:** [2026-10-15-oc-cli-bridge-design.md](../specs/2026-10-15-oc-cli-bridge-design.md) §5.2 / §6 / §14（子项目 2）；DSH 合同原件见 [dsh-llm-contract.md](../research/dsh-llm-contract.md)（2026-10-16 从 DSH 发行版 `app.asar` 内嵌 API manifest 提取）。

## Global Constraints

- **G1 纯层无 Node API：** `src/dsh-types.ts`、`src/chunk-text.ts`、`src/to-dsh-chunks.ts` 不得 `import` 任何 `node:*` 模块，不得使用 fs/path/process/timer。
- **G2 类型逐字镜像：** `src/dsh-types.ts` 的声明必须与 [dsh-llm-contract.md](../research/dsh-llm-contract.md) 的 DSH 声明逐字一致（仅类型前缀 `Dsh` 与 brand 声明为本地等价写法）；联合成员、字段名、可选性不得增删改。
- **G3 正文边界：** 不把 prompt / 消息正文写入日志、诊断或 `LlmFailure.message`；failure 消息只用静态错误码文案表。
- **G4 回归底线：** 既有 103 条单测保持全绿；唯一验收命令 `npm test`（`tsc -p tsconfig.json && node --test test/unit/*.test.mjs`）。
- **G5 工程模式：** TS strict + ESM；相对 import 一律带 `.js` 后缀（现有代码模式）。
- **G6 提交规范：** conventional commits + 中文描述（如 `feat(dsh-chunks): ...`），每任务至少一个提交。
- **G7 YAGNI：** 只实现任务清单内的行为。`reasoning-delta` / `tool-call-delta` / 图片块 / `replayState` 不在 MVP 范围（类型镜像里保留声明，不产出）。
- **G8 终端唯一：** 一次请求的 DSH 流以 `usage` + `finish` 各恰好一条收尾，`finish` 是最后一个 chunk。多 step 产生多个 CliBridge `finish` 事件（Ruling F16）时，**折叠**为最后一个事件的 reason 与 usage（usage 本身是累计值）。

---

### Task 1: DSH 合同类型镜像 + 文本切块器

**Files:**
- Create: `src/dsh-types.ts`
- Create: `src/chunk-text.ts`
- Test: `test/unit/chunk-text.test.mjs`

**Interfaces:**
- Consumes: 无（纯新增）。
- Produces:
  - `src/dsh-types.ts` 导出类型：`DshStreamChunk`、`DshContentBlock`、`DshContentBlockType`、`DshTokenUsage`、`DshFinishReason`、`DshLlmFailure`、`DshReplayEnvelope` 等（Task 2 直接 import）。
  - `src/chunk-text.ts` 导出：`DEFAULT_CHUNK_SIZE: number`（= 24）、`chunkText(text: string, chunkSize?: number): string[]`。

- [ ] **Step 1: 写失败测试**

创建 `test/unit/chunk-text.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, DEFAULT_CHUNK_SIZE } from "../../lib/chunk-text.js";

test("chunkText: 空串 -> 空数组", () => {
  assert.deepEqual(chunkText(""), []);
});

test("chunkText: 短于 chunkSize -> 单片", () => {
  assert.deepEqual(chunkText("abc", 4), ["abc"]);
});

test("chunkText: 恰好整倍数 -> 等长片", () => {
  assert.deepEqual(chunkText("abcdef", 3), ["ab", "cd", "ef"]);
});

test("chunkText: 长文本 -> 各片拼接还原原文", () => {
  const text = "0123456789abcdefghij";
  const pieces = chunkText(text, 4);
  assert.equal(pieces.join(""), text);
  assert.equal(pieces.length, 5);
});

test("chunkText: 按码点切分，不拆散代理对", () => {
  const text = "😀😀😀"; // 3 个码点，6 个 UTF-16 code unit
  const pieces = chunkText(text, 2);
  assert.deepEqual(pieces, ["😀😀", "😀"]);
  assert.equal(pieces.join(""), text);
});

test("chunkText: 默认 chunkSize 为 24", () => {
  assert.equal(DEFAULT_CHUNK_SIZE, 24);
  const text = "x".repeat(25);
  const pieces = chunkText(text);
  assert.deepEqual(pieces, ["x".repeat(24), "x"]);
});

test("chunkText: 非法 chunkSize 抛 TypeError", () => {
  assert.throws(() => chunkText("a", 0), TypeError);
  assert.throws(() => chunkText("a", -1), TypeError);
  assert.throws(() => chunkText("a", 1.5), TypeError);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL，`../../lib/chunk-text.js` 模块不存在（tsc 报错或测试加载失败）。

- [ ] **Step 3: 写 `src/dsh-types.ts`**

以下声明逐字镜像 DSH 合同（[dsh-llm-contract.md](../research/dsh-llm-contract.md)），不得改动字段：

```ts
/**
 * DSH `@deepseek-ai/dsh-llm` 公共合同的本地结构镜像（逐字）。
 * 来源：DSH 发行版 app.asar 内嵌 API manifest（docs/research/dsh-llm-contract.md）。
 * 本包不 import DSH 运行时；联合成员、字段名、可选性必须与 DSH 一致。
 */

declare const BRAND: unique symbol;

export type DshBranded<B extends string> = string & { readonly [BRAND]: B };

export type DshToolCallId = DshBranded<"ToolCallId">;
export type DshProviderRequestId = DshBranded<"ProviderRequestId">;
export type DshAttachmentId = DshBranded<"AttachmentId">;

export type DshImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface DshFileAttachmentRef {
  attachmentId: DshAttachmentId;
  name: string;
  bytes: number;
}

export interface DshImageAttachmentRef {
  attachmentId: DshAttachmentId;
  mediaType: DshImageMediaType;
  bytes: number;
  width: number;
  height: number;
  name?: string;
  originalDimensions?: { width: number; height: number };
}

export interface DshTextBlock {
  type: "text";
  text: string;
}

export interface DshReasoningBlock {
  type: "reasoning";
  text: string;
}

export interface DshImageBlock {
  type: "image";
  attachment: DshImageAttachmentRef;
  offloaded?: true;
}

export interface DshFileBlock {
  type: "file";
  attachment: DshFileAttachmentRef;
}

export interface DshToolCallBlock {
  type: "tool-call";
  id: DshToolCallId;
  name: string;
  arguments: string;
}

export interface DshToolAdditionBlock {
  type: "tool-addition";
  toolName: string;
  tool?: never;
}

export interface DshToolRemovalBlock {
  type: "tool-removal";
  toolName: string;
}

/** 与 DSH `ContentBlockMap` 的 key 集合一致。 */
export type DshContentBlockType =
  | "text"
  | "reasoning"
  | "image"
  | "file"
  | "tool-call"
  | "tool-addition"
  | "tool-removal";

/** 与 DSH `ContentBlock = ContentBlockMap[ContentBlockType]` 一致。 */
export type DshContentBlock =
  | DshTextBlock
  | DshReasoningBlock
  | DshImageBlock
  | DshFileBlock
  | DshToolCallBlock
  | DshToolAdditionBlock
  | DshToolRemovalBlock;

export interface DshTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface DshLlmFailure {
  readonly message: string;
  readonly code: string;
  readonly status?: number;
  readonly providerRetryAfterMs?: number;
  readonly requestId?: DshProviderRequestId;
  readonly offloadImages?: number;
}

/** 与 DSH `FinishReasonMap[keyof FinishReasonMap]` 一致。 */
export type DshFinishReason =
  | { kind: "stop" }
  | { kind: "tool-calls" }
  | { kind: "max-tokens" }
  | { kind: "aborted"; failure: DshLlmFailure }
  | { kind: "error"; failure: DshLlmFailure };

export interface DshReplayEnvelope {
  response: unknown;
  blocks?: readonly unknown[];
}

/** 与 DSH `StreamChunk` 一致。 */
export type DshStreamChunk =
  | { type: "block-start"; index: number; blockType: DshContentBlockType }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | {
      type: "tool-call-delta";
      index: number;
      id: DshToolCallId;
      name?: string;
      argumentsDelta: string;
    }
  | { type: "block-end"; index: number; block: DshContentBlock }
  | { type: "usage"; usage: DshTokenUsage }
  | { type: "finish"; reason: DshFinishReason; replayState?: DshReplayEnvelope };
```

- [ ] **Step 4: 写 `src/chunk-text.ts`**

```ts
/** 方案 A「切块模拟流式」的默认切片宽度（Unicode 码点数）。 */
export const DEFAULT_CHUNK_SIZE = 24;

/**
 * 把整段正文切成 text-delta 小片。
 * 按 Unicode 码点切分，绝不拆散代理对；不增删任何字符，拼接结果恒等于原文。
 */
export function chunkText(text: string, chunkSize: number = DEFAULT_CHUNK_SIZE): string[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new TypeError(`chunkSize must be a positive integer, got ${String(chunkSize)}`);
  }
  if (text === "") return [];
  const points = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < points.length; i += chunkSize) {
    out.push(points.slice(i, i + chunkSize).join(""));
  }
  return out;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test`
Expected: PASS（新增 7 条 chunk-text 测试 + 既有 103 条全绿）。

- [ ] **Step 6: 确认纯层无 Node API（G1）**

Run: `npm run typecheck && node -e "import('./lib/chunk-text.js').then(m=>console.log(typeof m.chunkText))"`
同时目检两个新文件没有 `node:` import。Expected: typecheck 通过、打印 `function`。

- [ ] **Step 7: 提交**

```bash
git add src/dsh-types.ts src/chunk-text.ts test/unit/chunk-text.test.mjs
git commit -m "feat(dsh-chunks): DSH 合同类型镜像 + 文本切块器"
```

---

### Task 2: `CliBridgeEvent` → `DshStreamChunk` 转换器

**Files:**
- Create: `src/to-dsh-chunks.ts`
- Test: `test/unit/to-dsh-chunks.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `DshStreamChunk` / `DshTokenUsage` / `DshFinishReason` / `DshLlmFailure` 与 `chunkText`；`src/types.js` 的 `CliBridgeEvent` / `CliUsage` / `ErrorCode` / `FinishReason` / `ZERO_USAGE`；`src/errors.js` 的 `CliBridgeError` / `CliBridgeAbortError`。
- Produces（Task 3 直接使用）:
  - `mapUsage(usage: CliUsage): DshTokenUsage`
  - `class DshChunkConverter`：`constructor(options?: { chunkSize?: number })`、`push(event: CliBridgeEvent): DshStreamChunk[]`、`end(): DshStreamChunk[]`、`abort(): DshStreamChunk[]`
  - `toDshChunks(events: AsyncIterable<CliBridgeEvent>, options?: { chunkSize?: number }): AsyncIterable<DshStreamChunk>`

**行为语义（本任务的验收基准）：**

1. `text` 事件 → 立即产出一个块：`block-start {index, blockType:"text"}` → 若干 `text-delta {index, text}`（`chunkText` 切片）→ `block-end {index, block:{type:"text", text:<原文>}}`；`index` 从 0 起逐块递增。
2. 空串 `text` 事件不产出任何 chunk。
3. `start` / `tool` 事件不产出任何 chunk（MVP 内部消化，G7）。
4. `finish` 事件**不立即产出** chunk，只记录「累计 usage + 结束原因」；`error` 事件记录「全零 usage + error 原因」。
5. `end()`（源流自然结束时由包装器调用）产出收尾对：`usage`（记录值，无记录则全零）→ `finish`（记录值，无记录则 `error + PROTOCOL_ERROR`）。幂等：收尾后一切 `push`/`end`/`abort` 返回 `[]`。
6. `abort()` 产出 `usage`（同上）→ `finish {kind:"aborted", failure:{code:"CANCELLED"}}`。
7. `toDshChunks` 包装器：源抛 `CliBridgeAbortError` → `abort()` 收尾后正常结束（**不向外抛**）；源抛 `CliBridgeError` → 以 `error` 语义收尾后正常结束（**不向外抛**）；其他异常原样抛出。
8. `failure.message` 只用静态文案表（G3）：

```ts
const FAILURE_MESSAGES: Record<ErrorCode, string> = {
  CLI_NOT_FOUND: "OpenCode CLI not found",
  CLI_START_FAILED: "OpenCode CLI failed to start",
  WORKSPACE_INVALID: "Invalid workspace directory",
  SESSION_INVALID: "OpenCode session is invalid",
  PROMPT_FAILED: "OpenCode CLI failed to process the prompt",
  TIMEOUT: "OpenCode CLI timed out",
  CANCELLED: "Request cancelled",
  PROTOCOL_ERROR: "OpenCode CLI output protocol error",
  UPSTREAM_ERROR: "Upstream model error",
  EMPTY_RESPONSE: "Model returned an empty response",
  TOOL_ONLY_RESPONSE: "Model returned only tool calls",
  UNKNOWN: "Unknown error",
};
```

- [ ] **Step 1: 写失败测试**

创建 `test/unit/to-dsh-chunks.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DshChunkConverter,
  mapUsage,
  toDshChunks,
} from "../../lib/to-dsh-chunks.js";
import { CliBridgeError, CliBridgeAbortError } from "../../lib/errors.js";
import { ZERO_USAGE } from "../../lib/types.js";

function textEvent(text, over = {}) {
  return { kind: "text", sessionId: "ses_1", text, ...over };
}

function finishEvent(over = {}) {
  return {
    kind: "finish",
    sessionId: "ses_1",
    reason: "stop",
    usage: { total: 30, input: 10, output: 15, reasoning: 3, cacheRead: 2, cacheWrite: 0 },
    cost: 0,
    ...over,
  };
}

test("mapUsage: 字段映射正确", () => {
  assert.deepEqual(mapUsage({ total: 30, input: 10, output: 15, reasoning: 3, cacheRead: 2, cacheWrite: 1 }), {
    inputTokens: 10,
    outputTokens: 15,
    totalTokens: 30,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: 3,
  });
});

test("单段 text -> block-start / text-delta* / block-end，index=0", () => {
  const c = new DshChunkConverter({ chunkSize: 4 });
  const chunks = c.push(textEvent("abcdefg"));
  assert.deepEqual(chunks, [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "abcd" },
    { type: "text-delta", index: 0, text: "efg" },
    { type: "block-end", index: 0, block: { type: "text", text: "abcdefg" } },
  ]);
});

test("多段 text -> index 递增 0,1,...", () => {
  const c = new DshChunkConverter({ chunkSize: 100 });
  c.push(textEvent("one"));
  const chunks = c.push(textEvent("two"));
  assert.equal(chunks[0].type, "block-start");
  assert.equal(chunks[0].index, 1);
  assert.equal(chunks.at(-1).type, "block-end");
  assert.equal(chunks.at(-1).index, 1);
});

test("空串 text -> 无输出", () => {
  const c = new DshChunkConverter();
  assert.deepEqual(c.push(textEvent("")), []);
});

test("start / tool 事件 -> 无输出", () => {
  const c = new DshChunkConverter();
  assert.deepEqual(c.push({ kind: "start", sessionId: "ses_1" }), []);
  assert.deepEqual(c.push({ kind: "tool", sessionId: "ses_1", raw: {} }), []);
});

test("finish 事件不立即产出，end() 产出 usage+finish(stop)", () => {
  const c = new DshChunkConverter();
  assert.deepEqual(c.push(finishEvent()), []);
  assert.deepEqual(c.end(), [
    {
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 15, totalTokens: 30, cacheReadTokens: 2, cacheWriteTokens: 0, reasoningTokens: 3 },
    },
    { type: "finish", reason: { kind: "stop" } },
  ]);
});

test("多 step 多个 finish 折叠为最后一个（reason 与 usage 都取最后）", () => {
  const c = new DshChunkConverter({ chunkSize: 100 });
  c.push(textEvent("step one"));
  c.push(finishEvent({ reason: "tool-calls", usage: { total: 100, input: 80, output: 10, reasoning: 5, cacheRead: 5, cacheWrite: 0 } }));
  c.push(textEvent("step two"));
  c.push(finishEvent({ reason: "stop", usage: { total: 200, input: 150, output: 40, reasoning: 8, cacheRead: 2, cacheWrite: 0 } }));
  const tail = c.end();
  assert.equal(tail.length, 2);
  assert.equal(tail[0].type, "usage");
  assert.equal(tail[0].usage.totalTokens, 200);
  assert.deepEqual(tail[1].reason, { kind: "stop" });
});

test("finish(max-tokens) / finish(tool-calls) 映射", () => {
  const a = new DshChunkConverter();
  a.push(finishEvent({ reason: "max-tokens" }));
  assert.deepEqual(a.end()[1].reason, { kind: "max-tokens" });
  const b = new DshChunkConverter();
  b.push(finishEvent({ reason: "tool-calls" }));
  assert.deepEqual(b.end()[1].reason, { kind: "tool-calls" });
});

test("finish(error, EMPTY_RESPONSE) -> error + 静态文案", () => {
  const c = new DshChunkConverter();
  c.push(finishEvent({ reason: "error", code: "EMPTY_RESPONSE" }));
  assert.deepEqual(c.end()[1].reason, {
    kind: "error",
    failure: { message: "Model returned an empty response", code: "EMPTY_RESPONSE" },
  });
});

test("finish(aborted) -> aborted + CANCELLED", () => {
  const c = new DshChunkConverter();
  c.push(finishEvent({ reason: "aborted" }));
  assert.deepEqual(c.end()[1].reason, {
    kind: "aborted",
    failure: { message: "Request cancelled", code: "CANCELLED" },
  });
});

test("error 事件 -> end() 时 usage 全零 + error(<event.code>)", () => {
  const c = new DshChunkConverter();
  c.push({ kind: "error", code: "UPSTREAM_ERROR", message: "whatever" });
  assert.deepEqual(c.end(), [
    { type: "usage", usage: mapUsage(ZERO_USAGE) },
    { type: "finish", reason: { kind: "error", failure: { message: "Upstream model error", code: "UPSTREAM_ERROR" } } },
  ]);
});

test("无任何终止事件 -> end() 兜底 error(PROTOCOL_ERROR)", () => {
  const c = new DshChunkConverter();
  assert.deepEqual(c.end(), [
    { type: "usage", usage: mapUsage(ZERO_USAGE) },
    { type: "finish", reason: { kind: "error", failure: { message: "OpenCode CLI output protocol error", code: "PROTOCOL_ERROR" } } },
  ]);
});

test("收尾后 push/end/abort 一律返回 []（幂等）", () => {
  const c = new DshChunkConverter();
  c.end();
  assert.deepEqual(c.push(textEvent("late")), []);
  assert.deepEqual(c.end(), []);
  assert.deepEqual(c.abort(), []);
});

test("abort() -> usage + finish(aborted, CANCELLED)", () => {
  const c = new DshChunkConverter({ chunkSize: 100 });
  c.push(textEvent("partial"));
  const tail = c.abort();
  assert.equal(tail[0].type, "usage");
  assert.deepEqual(tail[1].reason, {
    kind: "aborted",
    failure: { message: "Request cancelled", code: "CANCELLED" },
  });
});

test("toDshChunks: 异步包装产出与状态机一致，自然收尾", async () => {
  async function* source() {
    yield textEvent("hi");
    yield finishEvent();
  }
  const out = [];
  for await (const chunk of toDshChunks(source(), { chunkSize: 100 })) out.push(chunk);
  assert.deepEqual(out.map((c) => c.type), ["block-start", "text-delta", "block-end", "usage", "finish"]);
});

test("toDshChunks: 源抛 CliBridgeAbortError -> aborted 收尾，不向外抛", async () => {
  async function* source() {
    yield textEvent("partial");
    throw new CliBridgeAbortError("aborted");
  }
  const out = [];
  for await (const chunk of toDshChunks(source())) out.push(chunk);
  const finish = out.at(-1);
  assert.equal(finish.type, "finish");
  assert.equal(finish.reason.kind, "aborted");
});

test("toDshChunks: 源抛 CliBridgeError -> error 收尾，不向外抛", async () => {
  async function* source() {
    throw new CliBridgeError("WORKSPACE_INVALID", "bad workspace");
  }
  const out = [];
  for await (const chunk of toDshChunks(source())) out.push(chunk);
  const finish = out.at(-1);
  assert.equal(finish.type, "finish");
  assert.equal(finish.reason.kind, "error");
  assert.equal(finish.reason.failure.code, "WORKSPACE_INVALID");
});

test("toDshChunks: 非 CliBridge 异常原样抛出", async () => {
  async function* source() {
    throw new TypeError("boom");
  }
  await assert.rejects(async () => {
    for await (const _ of toDshChunks(source())) void _;
  }, TypeError);
});
```

注意：`CliBridgeError` 的构造签名以 `src/errors.ts` 现状为准；若与测试中的 `new CliBridgeError(code, message)` 不符，以 `src/errors.ts` 为准调整测试调用方式，不改 `errors.ts`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL，`../../lib/to-dsh-chunks.js` 不存在。

- [ ] **Step 3: 写 `src/to-dsh-chunks.ts`**

```ts
import type { CliBridgeEvent, CliUsage, ErrorCode, FinishReason } from "./types.js";
import { ZERO_USAGE } from "./types.js";
import { CliBridgeAbortError, CliBridgeError } from "./errors.js";
import { chunkText, DEFAULT_CHUNK_SIZE } from "./chunk-text.js";
import type {
  DshFinishReason,
  DshLlmFailure,
  DshStreamChunk,
  DshTokenUsage,
} from "./dsh-types.js";

export interface DshChunkOptions {
  chunkSize?: number;
}

const FAILURE_MESSAGES: Record<ErrorCode, string> = {
  CLI_NOT_FOUND: "OpenCode CLI not found",
  CLI_START_FAILED: "OpenCode CLI failed to start",
  WORKSPACE_INVALID: "Invalid workspace directory",
  SESSION_INVALID: "OpenCode session is invalid",
  PROMPT_FAILED: "OpenCode CLI failed to process the prompt",
  TIMEOUT: "OpenCode CLI timed out",
  CANCELLED: "Request cancelled",
  PROTOCOL_ERROR: "OpenCode CLI output protocol error",
  UPSTREAM_ERROR: "Upstream model error",
  EMPTY_RESPONSE: "Model returned an empty response",
  TOOL_ONLY_RESPONSE: "Model returned only tool calls",
  UNKNOWN: "Unknown error",
};

/** CliUsage -> DSH TokenUsage 的字段映射（TODO-13）。 */
export function mapUsage(usage: CliUsage): DshTokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.total,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    reasoningTokens: usage.reasoning,
  };
}

function toFailure(code: ErrorCode): DshLlmFailure {
  return { message: FAILURE_MESSAGES[code], code };
}

function toDshFinish(reason: FinishReason, code?: ErrorCode): DshFinishReason {
  switch (reason) {
    case "stop":
      return { kind: "stop" };
    case "max-tokens":
      return { kind: "max-tokens" };
    case "tool-calls":
      return { kind: "tool-calls" };
    case "aborted":
      return { kind: "aborted", failure: toFailure(code ?? "CANCELLED") };
    case "error":
      return { kind: "error", failure: toFailure(code ?? "UNKNOWN") };
  }
}

/**
 * CliBridgeEvent -> DshStreamChunk 的纯状态机。
 * text 立即成块；finish/error 只记录终端状态，由 end()/abort() 收尾，
 * 保证一次请求恰好一条 usage + 一条 finish（G8，兼容多 step 多 finish 的 F16 语义）。
 */
export class DshChunkConverter {
  readonly #chunkSize: number;
  #index = 0;
  #usage: DshTokenUsage | null = null;
  #finish: DshFinishReason | null = null;
  #ended = false;

  constructor(options: DshChunkOptions = {}) {
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new TypeError(`chunkSize must be a positive integer, got ${String(chunkSize)}`);
    }
    this.#chunkSize = chunkSize;
  }

  push(event: CliBridgeEvent): DshStreamChunk[] {
    if (this.#ended) return [];
    switch (event.kind) {
      case "start":
      case "tool":
        return [];
      case "text": {
        if (event.text === "") return [];
        const index = this.#index++;
        const chunks: DshStreamChunk[] = [
          { type: "block-start", index, blockType: "text" },
        ];
        for (const piece of chunkText(event.text, this.#chunkSize)) {
          chunks.push({ type: "text-delta", index, text: piece });
        }
        chunks.push({ type: "block-end", index, block: { type: "text", text: event.text } });
        return chunks;
      }
      case "finish":
        this.#usage = mapUsage(event.usage);
        this.#finish = toDshFinish(event.reason, event.code);
        return [];
      case "error":
        this.#usage = mapUsage(ZERO_USAGE);
        this.#finish = { kind: "error", failure: toFailure(event.code) };
        return [];
    }
  }

  /** 源流自然结束的收尾；幂等。无终端记录时兜底 error(PROTOCOL_ERROR)。 */
  end(): DshStreamChunk[] {
    return this.#finalize({
      kind: "error",
      failure: toFailure("PROTOCOL_ERROR"),
    }, false);
  }

  /** 取消收尾；幂等。取消语义优先（Ruling P10）：无论有无 finish 记录都产出 aborted。 */
  abort(): DshStreamChunk[] {
    return this.#finalize({
      kind: "aborted",
      failure: toFailure("CANCELLED"),
    }, true);
  }

  #finalize(fallback: DshFinishReason, forceFallback: boolean): DshStreamChunk[] {
    if (this.#ended) return [];
    this.#ended = true;
    return [
      { type: "usage", usage: this.#usage ?? mapUsage(ZERO_USAGE) },
      { type: "finish", reason: forceFallback ? fallback : (this.#finish ?? fallback) },
    ];
  }
}

/**
 * 把 CliBridgeEvent 异步流包装成 DshStreamChunk 异步流。
 * 源的取消/失败异常在此转化为终止 finish（DSH 合同：迭代失败落成终止 chunk）；
 * 其他异常原样抛给调用方。
 */
export async function* toDshChunks(
  events: AsyncIterable<CliBridgeEvent>,
  options: DshChunkOptions = {},
): AsyncIterable<DshStreamChunk> {
  const converter = new DshChunkConverter(options);
  try {
    for await (const event of events) {
      yield* converter.push(event);
    }
  } catch (error) {
    if (error instanceof CliBridgeAbortError) {
      yield* converter.abort();
      return;
    }
    if (error instanceof CliBridgeError) {
      yield* converter.push({ kind: "error", code: error.code, message: error.message });
      yield* converter.end();
      return;
    }
    throw error;
  }
  yield* converter.end();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（新增约 17 条 + 既有全绿）。

- [ ] **Step 5: 确认纯层无 Node API（G1）**

Run: `npm run typecheck`
目检 `src/to-dsh-chunks.ts` 无 `node:` import。Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add src/to-dsh-chunks.ts test/unit/to-dsh-chunks.test.mjs
git commit -m "feat(dsh-chunks): CliBridgeEvent -> DSH StreamChunk 转换器"
```

---

### Task 3: `streamDshChunks` 组装 + 导出面 + fake CLI 端到端 + 文档回写

**Files:**
- Modify: `src/cli-bridge.ts`（追加 `streamDshChunks`）
- Modify: `src/index.ts`（追加导出）
- Test: `test/unit/stream-dsh-chunks.test.mjs`
- Docs: `README.md`（开发状态）、`todo.md`（TODO-15/16 结论、§0 链路状态表）

**Interfaces:**
- Consumes: Task 2 的 `toDshChunks`；既有 `streamCliBridge(opts: CliBridgeOptions)`。
- Produces: `streamDshChunks(opts: CliBridgeOptions, options?: DshChunkOptions): AsyncIterable<DshStreamChunk>`；`index.ts` 新增导出 `streamDshChunks`、`toDshChunks`、`DshChunkConverter`、`mapUsage`、`chunkText`、`DEFAULT_CHUNK_SIZE` 与 `dsh-types.ts` 的全部类型。

- [ ] **Step 1: 写失败测试（fake CLI 端到端）**

创建 `test/unit/stream-dsh-chunks.test.mjs`（fake CLI 调用范式沿用 `test/unit/cli-bridge.test.mjs`）：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { streamDshChunks } from "../../lib/cli-bridge.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(here, "..", "fixtures", "fake-opencode.mjs");

function baseOpts(mode, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ocbridge-dsh-"));
  writeFileSync(join(dir, "alpha.txt"), "alpha\n");
  const defaults = {
    workspace: dir,
    model: "opencode/mimo-v2.6-flash-free",
    prompt: "hello",
    command: process.execPath,
    extraArgs: [FAKE, `mode:${mode}`],
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 5000, totalMs: 15000, shutdownMs: 1000 },
  };
  return { dir, opts: { ...defaults, ...over } };
}

async function collect(opts, options) {
  const chunks = [];
  for await (const c of streamDshChunks(opts, options)) chunks.push(c);
  return chunks;
}

test("fake normal -> 块 + usage + finish(stop)，正文还原", async () => {
  const { dir, opts } = baseOpts("normal");
  try {
    const chunks = await collect(opts, { chunkSize: 8 });
    const types = chunks.map((c) => c.type);
    assert.equal(types[0], "block-start");
    assert.equal(types.at(-2), "usage");
    assert.equal(types.at(-1), "finish");
    const deltas = chunks.filter((c) => c.type === "text-delta");
    assert.ok(deltas.length >= 1);
    const text = deltas.map((c) => c.text).join("");
    assert.equal(text, "FAKE_NORMAL_OK");
    const end = chunks.find((c) => c.type === "block-end");
    assert.deepEqual(end.block, { type: "text", text: "FAKE_NORMAL_OK" });
    assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fake multiline -> 多块 index 递增，正文拼接还原", async () => {
  const { dir, opts } = baseOpts("multiline");
  try {
    const chunks = await collect(opts, { chunkSize: 64 });
    const starts = chunks.filter((c) => c.type === "block-start");
    assert.equal(starts.length, 3);
    assert.deepEqual(starts.map((c) => c.index), [0, 1, 2]);
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
    assert.equal(text, "part-A part-B part-C");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fake multi-step -> 只有一条 usage+finish，reason 取最后（stop）", async () => {
  const { dir, opts } = baseOpts("multi-step");
  try {
    const chunks = await collect(opts, { chunkSize: 64 });
    assert.equal(chunks.filter((c) => c.type === "finish").length, 1);
    assert.equal(chunks.filter((c) => c.type === "usage").length, 1);
    assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fake tool-only -> 无块 + finish(tool-calls, TOOL_ONLY_RESPONSE)", async () => {
  const { dir, opts } = baseOpts("tool-only");
  try {
    const chunks = await collect(opts);
    assert.equal(chunks.filter((c) => c.type === "block-start").length, 0);
    assert.deepEqual(chunks.at(-1).reason, {
      kind: "tool-calls",
      failure: undefined, // 占位，见下一行断言
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fake empty -> finish(error, EMPTY_RESPONSE)", async () => {
  const { dir, opts } = baseOpts("empty");
  try {
    const chunks = await collect(opts);
    const finish = chunks.at(-1);
    assert.equal(finish.reason.kind, "error");
    assert.equal(finish.reason.failure.code, "EMPTY_RESPONSE");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

注意 Step 3 落地后修正 `tool-only` 用例的断言：`tool-calls` 是无 failure 的分支，应断言 `assert.deepEqual(chunks.at(-1).reason, { kind: "tool-calls" })`；上文的 `failure: undefined` 行只是提醒占位，测试代码里不允许保留。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL，`lib/cli-bridge.js` 无 `streamDshChunks` 导出。

- [ ] **Step 3: 写 `streamDshChunks` 组装与导出面**

`src/cli-bridge.ts` 顶部 import 并追加（放在 `runCliBridge` 之后）：

```ts
import { toDshChunks } from "./to-dsh-chunks.js";
import type { DshChunkOptions } from "./to-dsh-chunks.js";
import type { DshStreamChunk } from "./dsh-types.js";

/**
 * 端到端入口：OpenCode CLI 事件流 -> DSH StreamChunk 流。
 * 取消/超时/失败都落成终止 finish（aborted/error），不会向外抛（建立期参数错误除外）。
 */
export function streamDshChunks(
  opts: CliBridgeOptions,
  options: DshChunkOptions = {},
): AsyncIterable<DshStreamChunk> {
  return toDshChunks(streamCliBridge(opts), options);
}
```

`src/index.ts` 追加导出：

```ts
export { streamDshChunks } from "./cli-bridge.js";
export { toDshChunks, DshChunkConverter, mapUsage } from "./to-dsh-chunks.js";
export type { DshChunkOptions } from "./to-dsh-chunks.js";
export { chunkText, DEFAULT_CHUNK_SIZE } from "./chunk-text.js";
export type {
  DshStreamChunk,
  DshContentBlock,
  DshContentBlockType,
  DshTokenUsage,
  DshFinishReason,
  DshLlmFailure,
  DshReplayEnvelope,
} from "./dsh-types.js";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（修正后的 5 条端到端 + 既有全部）。

- [ ] **Step 5: 文档回写**

1. `README.md`「开发状态」：把 `[ ] DSH StreamChunk 转换` 改为 `[x] DSH StreamChunk 转换（切块模拟流式，多 finish 折叠）`；「当前阶段」段落补一句子项目 2 已完成。
2. `todo.md`：
   - §0 链路状态表「插件内部事件 → DSH chunk」由「未实现」改为「已实现（子项目 2，切块模拟流式）」；
   - TODO-15 追加结论：DSH `StreamChunk` 真实合同已从 `app.asar` API manifest 提取（`docs/research/dsh-llm-contract.md`），`index` 为块序号从 0 递增、每块 `block-start → text-delta* → block-end`、`usage` 在 `finish` 前、`finish` 唯一；
   - TODO-16 追加结论：转换器 `src/to-dsh-chunks.ts` 已实现，多 step 多 `finish` 折叠为最后一个。
3. 不改 `docs/research/dsh-llm-contract.md`（研究件只读）。

- [ ] **Step 6: 提交**

```bash
git add src/cli-bridge.ts src/index.ts test/unit/stream-dsh-chunks.test.mjs README.md todo.md
git commit -m "feat(dsh-chunks): streamDshChunks 组装、导出面与 fake CLI 端到端测试"
```

---

## Self-Review 记录

1. **Spec 覆盖：** spec §14 子项目 2 的两个交付物——「`CliBridgeEvent` → DSH chunk 转换」（Task 2）与「切块模拟流式」（Task 1 chunk-text + Task 2 集成）——各有任务承接；§5.3 I1/I4 的「不悬挂、不乱抛」由 Task 2 行为语义 5/7 承接。缺口：无。
2. **占位符扫描：** 全文无 TBD/TODO 类占位；Task 3 测试里 `failure: undefined` 是已注明要在 Step 3 修正的占位断言，Step 1 注意事项已明令删除。
3. **类型一致性：** `mapUsage`/`DshChunkConverter`/`toDshChunks`/`DshChunkOptions` 在 Task 2 定义、Task 3 消费，签名一致；`DshStreamChunk` 等类型名 Task 1 定义、Task 2/3 消费，一致。
4. **与既有语义的冲突裁定（Ruling）：** spec §5.3 I2 原文「finish 最多产出一次」已被 CliBridge 的 Ruling F16 修订（每个 `step_finish` 一个 `finish` 事件）。本计划 G8 在 DSH 侧恢复「一次请求恰好一条 DSH finish」，以折叠方式兼容两者——这是本计划的绑定裁定，实现不得输出多条 DSH `finish`。
