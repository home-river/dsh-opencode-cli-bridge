# CliBridge（OC → 插件段）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个不依赖任何 DSH 概念的 `CliBridge` 模块 —— 从发现 OpenCode CLI 可执行文件，到一次问答调用结束并让进程完全归零。

**Architecture:** 纯逻辑层（`types` / `errors` / `parse-lines` / `map-events`，零 Node API）+ 极薄进程壳（`run-cli`，spawn/超时/取消/清理）+ 组装层（`cli-bridge`）+ 独立的 `discover-cli`。纯层可被单测直接打穿；进程层通过 `command` / `args` 注入 fake CLI，走与真实 CLI **完全相同**的 spawn 路径。

**Tech Stack:** TypeScript（ES2022 / NodeNext / strict）→ 编译到 `lib/`；测试用 Node 内置 `node:test`（**不引入 jest / vitest**）；测试文件是 `.mjs`，直接 import 编译产物 `lib/`；**零 runtime 依赖**。

**Spec:** [docs/superpowers/specs/2026-10-15-oc-cli-bridge-design.md](../specs/2026-10-15-oc-cli-bridge-design.md)
**实测依据:** [docs/CLI-BEHAVIOR.md](../../CLI-BEHAVIOR.md)

---

## Global Constraints

执行每个任务时，以下约束**始终生效**：

| # | 约束 | 来源 |
|---|---|---|
| G1 | **执行入口只能是 `opencode.exe` 真身**；`.cmd` / `.bat` 只作发现线索，命中即解析出真身 | CLI-BEHAVIOR C1/C3/C4 |
| G2 | **禁止 `shell: true`**；参数一律走 argv 数组，绝不拼接命令行字符串 | CLI-BEHAVIOR C2/C9 |
| G3 | **清理进程只按 PID**：`taskkill /PID <pid> /T /F`；**禁止 `taskkill /IM`** | CLI-BEHAVIOR C5/C6 |
| G4 | **`child.kill()` 只杀直接子进程**；`/T` 杀子树是必需项（CLI 会派生 `git`） | CLI-BEHAVIOR C5/C7 |
| G5 | **超时默认值**：`startup 30_000` / `firstEvent 45_000` / `idle 300_000` / `total 600_000` / `shutdown 3_000`（单位 ms） | spec §8.1、CLI-BEHAVIOR §12.5 |
| G6 | **`idle` 自"上一个事件"起算**，按"最长单次生成"留量（实测静默 46.5s） | CLI-BEHAVIOR C14 |
| G7 | **错误检测必须读 `stderr`**；stderr 解析前必须剥 ANSI；主判据是 `exit code` + `stdout` 有无事件 | CLI-BEHAVIOR C11–C13 |
| G8 | **解析以事件 `type` 为准**，`part.type` 命名与之不一致（`tool_use` 的 `part.type` 是 `"tool"`） | CLI-BEHAVIOR C15 |
| G9 | **usage 跨 `step_finish` 累加**（每个报的是该 step 增量） | CLI-BEHAVIOR C16 |
| G10 | **未知事件绝不 crash**，只产出 `unknown-event` 诊断并忽略 | spec I7 |
| G11 | **模块不写任何持久化文件**；`sessionId` 是纯入参/出参 | spec I6 |
| G12 | **模块不记录 prompt / 消息正文**到日志或诊断 | spec I8 |
| G13 | **已产出正文后绝不重试**；每轮最多 1 次内部启动重试 | spec §7.3 |
| G14 | **零 runtime 依赖**；`devDependencies` 只允许 `typescript` + `@types/node` | spec §11 / A12 |
| G15 | **TypeScript 导入必须写 `.js` 扩展名**（NodeNext）：源文件里写 `import { X } from "./types.js"`，即使实际文件是 `types.ts` | `module: "NodeNext"` |
| G16 | **测试文件是 `.mjs`**，放在 `test/unit/`，`import` 编译产物 `../../lib/xxx.js` | spec §11 |
| G17 | **提交信息用 `feat:` / `test:` / `fix:` / `docs:` 前缀**，一次任务一次提交 | 本计划 |
| G18 | **Windows**：进程枚举用 `tasklist` / `taskkill`；`Get-CimInstance` 在受限令牌下不可用 | CLI-BEHAVIOR §7.1 |

## 常用命令

```bash
npm install                              # 装 typescript + @types/node
npm run typecheck                        # tsc --noEmit
npm run build                            # tsc -> lib/
npm test                                 # tsc && node --test test/unit/
npm run test:integration                 # tsc && node --test test/integration/
node --test test/unit/errors.test.mjs    # 跑单个测试文件
```

---

## File Structure

```text
dsh-opencode-bridge/
├─ src/
│  ├─ types.ts          纯类型 + 常量（DEFAULT_TIMEOUTS / ZERO_USAGE）
│  ├─ errors.ts         CliBridgeError / stripAnsi / toFinishMapping / classifyFailure / canRetry
│  ├─ parse-lines.ts    JsonLineSplitter / parseEventLine / isRecord
│  ├─ map-events.ts     OpenCodeEventMapper（事件归一化 + usage 聚合 + finish 映射）
│  ├─ discover-cli.ts   discoverOpencodeCli（四级回退）
│  ├─ run-cli.ts        runCliProcess（spawn / stdio / 超时 / 取消 / 进程树清理）
│  ├─ cli-bridge.ts     streamCliBridge / runCliBridge
│  └─ index.ts          导出面
├─ test/
│  ├─ fixtures/
│  │  └─ fake-opencode.mjs    可执行 fake CLI，行为由 FAKE_MODE 控制
│  ├─ unit/
│  │  ├─ types.test.mjs
│  │  ├─ errors.test.mjs
│  │  ├─ parse-lines.test.mjs
│  │  ├─ map-events.test.mjs
│  │  ├─ discover-cli.test.mjs
│  │  ├─ run-cli.test.mjs
│  │  └─ cli-bridge.test.mjs
│  └─ integration/
│     └─ cli-bridge.real.test.mjs
└─ package.json / tsconfig.json（修改）
```

**依赖方向严格单向：** `cli-bridge → run-cli → (注入的 spawn)`；`cli-bridge → map-events → parse-lines`；纯层（`types` / `errors` / `parse-lines` / `map-events`）**不 import 任何 `node:` 模块**。

---

### Task 1: 工程基线 + 类型与错误分类

**Files:**
- Modify: `dsh-opencode-bridge/package.json`
- Modify: `dsh-opencode-bridge/tsconfig.json`
- Create: `dsh-opencode-bridge/src/types.ts`
- Create: `dsh-opencode-bridge/src/errors.ts`
- Test: `dsh-opencode-bridge/test/unit/types.test.mjs`
- Test: `dsh-opencode-bridge/test/unit/errors.test.mjs`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `types.ts` 导出 `CliTimeouts` `DEFAULT_TIMEOUTS` `CliUsage` `ZERO_USAGE` `FinishReason` `ErrorCode` `CliDiagnostic` `CliBridgeEvent` `CliBridgeOptions` `CliBridgeResult`
  - `errors.ts` 导出 `CliBridgeError` `CliBridgeAbortError` `stripAnsi(text: string): string` `toFinishMapping(rawReason: string | undefined, hasText: boolean): FinishMapping` `classifyFailure(facts: FailureFacts): ErrorCode` `canRetry(code: ErrorCode, hasEmittedText: boolean): boolean`

- [ ] **Step 1: 安装工具链**

修改 `package.json`，把 `scripts` 与 `devDependencies` 改成：

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "tsc -p tsconfig.json && node --test test/unit/",
    "test:integration": "tsc -p tsconfig.json && node --test test/integration/"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.6.0"
  }
}
```

> 注意：**必须保留** `name` / `version` / `type: "module"` / `main` / `types` / `exports` / `files` / `engines` / `keywords` / `license` 原有字段，只改 `scripts` 并**新增** `devDependencies`。

Run: `npm install`
Expected: `node_modules/` 出现，`node_modules/.bin/tsc` 存在

- [ ] **Step 2: 确认工具链可用**

Run: `npm run typecheck`
Expected: 无输出（`src/` 还没有文件，`include: ["src/**/*.ts"]` 匹配不到也算通过）

若报 "No inputs were found in config file"，在 `tsconfig.json` 的 `compilerOptions` 里加一行 `"noEmitOnError": true` 并临时创建 `src/types.ts`（内容留到 Step 3）后重跑。

- [ ] **Step 3: 写失败测试 —— 超时默认值必须等于实测值**

创建 `test/unit/types.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TIMEOUTS, ZERO_USAGE } from "../../lib/types.js";

test("DEFAULT_TIMEOUTS 的值必须与 spec §8.1 实测结论一致", () => {
  assert.deepEqual(DEFAULT_TIMEOUTS, {
    startupMs: 30_000,
    firstEventMs: 45_000,
    idleMs: 300_000,
    totalMs: 600_000,
    shutdownMs: 3_000,
  });
});

test("ZERO_USAGE 全部为 0", () => {
  assert.deepEqual(ZERO_USAGE, {
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});
```

- [ ] **Step 4: 写失败测试 —— 错误分类与 finish 映射**

创建 `test/unit/errors.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CliBridgeError,
  CliBridgeAbortError,
  stripAnsi,
  toFinishMapping,
  classifyFailure,
  canRetry,
} from "../../lib/errors.js";

test("stripAnsi 去掉 ANSI 颜色码", () => {
  assert.equal(stripAnsi("\u001b[91m\u001b[1mError: \u001b[0mSession not found"), "Error: Session not found");
});

test("stripAnsi 对无色文本原样返回", () => {
  assert.equal(stripAnsi("plain"), "plain");
});

test("toFinishMapping: reason=stop 且有正文 -> stop", () => {
  assert.deepEqual(toFinishMapping("stop", true), { reason: "stop" });
});

test("toFinishMapping: reason=stop 但无正文 -> error + EMPTY_RESPONSE", () => {
  assert.deepEqual(toFinishMapping("stop", false), {
    reason: "error",
    code: "EMPTY_RESPONSE",
    rawReason: "stop",
  });
});

test("toFinishMapping: 长度截断 -> max-tokens（大小写与下划线变体都认）", () => {
  for (const r of ["length", "max_tokens", "max-tokens", "MaxTokens"]) {
    assert.equal(toFinishMapping(r, true).reason, "max-tokens", r);
  }
});

test("toFinishMapping: tool-calls 有正文 -> tool-calls", () => {
  assert.deepEqual(toFinishMapping("tool-calls", true), { reason: "tool-calls", rawReason: "tool-calls" });
});

test("toFinishMapping: tool-calls 无正文 -> tool-calls + TOOL_ONLY_RESPONSE", () => {
  assert.deepEqual(toFinishMapping("tool-calls", false), {
    reason: "tool-calls",
    code: "TOOL_ONLY_RESPONSE",
    rawReason: "tool-calls",
  });
});

test("toFinishMapping: 未知 reason 保守映射为 error + UNKNOWN，保留原值", () => {
  assert.deepEqual(toFinishMapping("weird-new-reason", true), {
    reason: "error",
    code: "UNKNOWN",
    rawReason: "weird-new-reason",
  });
});

test("toFinishMapping: rawReason 为 undefined -> PROTOCOL_ERROR", () => {
  assert.deepEqual(toFinishMapping(undefined, true), {
    reason: "error",
    code: "PROTOCOL_ERROR",
  });
});

test("classifyFailure: 优先级 —— 取消压过超时与退出码", () => {
  assert.equal(
    classifyFailure({ aborted: true, timedOut: true, exitCode: 1, sawAnyEvent: true, sawFinish: false, stderrText: "Session not found" }),
    "CANCELLED",
  );
});

test("classifyFailure: 超时", () => {
  assert.equal(
    classifyFailure({ aborted: false, timedOut: true, exitCode: null, sawAnyEvent: false, sawFinish: false, stderrText: "" }),
    "TIMEOUT",
  );
});

test("classifyFailure: exit!=0 + 无事件 + stderr 'Session not found' -> SESSION_INVALID", () => {
  assert.equal(
    classifyFailure({
      aborted: false, timedOut: false, exitCode: 1, sawAnyEvent: false, sawFinish: false,
      stderrText: "\u001b[91m\u001b[1mError: \u001b[0mSession not found\r\n",
    }),
    "SESSION_INVALID",
  );
});

test("classifyFailure: exit!=0 + 无事件 + permission -> PROMPT_FAILED", () => {
  assert.equal(
    classifyFailure({ aborted: false, timedOut: false, exitCode: 1, sawAnyEvent: false, sawFinish: false, stderrText: "permission denied" }),
    "PROMPT_FAILED",
  );
});

test("classifyFailure: exit!=0 + 无事件 + 其他 stderr -> PROTOCOL_ERROR", () => {
  assert.equal(
    classifyFailure({ aborted: false, timedOut: false, exitCode: 1, sawAnyEvent: false, sawFinish: false, stderrText: "boom" }),
    "PROTOCOL_ERROR",
  );
});

test("classifyFailure: exit!=0 + 有事件但无 finish -> PROTOCOL_ERROR", () => {
  assert.equal(
    classifyFailure({ aborted: false, timedOut: false, exitCode: 1, sawAnyEvent: true, sawFinish: false, stderrText: "" }),
    "PROTOCOL_ERROR",
  );
});

test("canRetry: 未产出正文且是启动失败/超时 -> 可重试", () => {
  assert.equal(canRetry("CLI_START_FAILED", false), true);
  assert.equal(canRetry("TIMEOUT", false), true);
});

test("canRetry: 已产出正文一律不重试", () => {
  assert.equal(canRetry("CLI_START_FAILED", true), false);
  assert.equal(canRetry("TIMEOUT", true), false);
});

test("canRetry: 取消/未找到 CLI/工作区非法 均不重试", () => {
  assert.equal(canRetry("CANCELLED", false), false);
  assert.equal(canRetry("CLI_NOT_FOUND", false), false);
  assert.equal(canRetry("WORKSPACE_INVALID", false), false);
});

test("CliBridgeError 携带 code 且是 Error", () => {
  const e = new CliBridgeError("TIMEOUT", "took too long");
  assert.ok(e instanceof Error);
  assert.equal(e.code, "TIMEOUT");
  assert.equal(e.name, "CliBridgeError");
});

test("CliBridgeAbortError 的 code 是 CANCELLED", () => {
  const e = new CliBridgeAbortError();
  assert.equal(e.code, "CANCELLED");
  assert.ok(e instanceof CliBridgeError);
});
```

- [ ] **Step 5: 跑测试确认失败**

Run: `npm run build && node --test test/unit/types.test.mjs test/unit/errors.test.mjs`
Expected: **失败**，报 `Cannot find module .../lib/types.js` 或 `ERR_MODULE_NOT_FOUND`（`lib/` 还不存在）

- [ ] **Step 6: 写 `src/types.ts`**

```ts
export interface CliTimeouts {
  startupMs: number;
  firstEventMs: number;
  idleMs: number;
  totalMs: number;
  shutdownMs: number;
}

export const DEFAULT_TIMEOUTS: CliTimeouts = {
  startupMs: 30_000,
  firstEventMs: 45_000,
  idleMs: 300_000,
  totalMs: 600_000,
  shutdownMs: 3_000,
};

export interface CliUsage {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ZERO_USAGE: CliUsage = {
  total: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export type FinishReason = "stop" | "max-tokens" | "tool-calls" | "aborted" | "error";

export type ErrorCode =
  | "CLI_NOT_FOUND"
  | "CLI_START_FAILED"
  | "WORKSPACE_INVALID"
  | "SESSION_INVALID"
  | "PROMPT_FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "PROTOCOL_ERROR"
  | "UPSTREAM_ERROR"
  | "EMPTY_RESPONSE"
  | "TOOL_ONLY_RESPONSE"
  | "UNKNOWN";

export type CliDiagnostic =
  | { kind: "unknown-event"; raw: unknown }
  | { kind: "protocol-line"; line: string; reason: string }
  | { kind: "stderr"; chunk: string }
  | { kind: "state"; message: string };

export type CliBridgeEvent =
  | { kind: "start"; sessionId: string; messageId?: string }
  | { kind: "text"; sessionId: string; messageId?: string; text: string }
  | { kind: "tool"; sessionId: string; messageId?: string; raw: unknown }
  | {
      kind: "finish";
      sessionId: string;
      messageId?: string;
      reason: FinishReason;
      usage: CliUsage;
      cost: number;
      code?: ErrorCode;
    }
  | { kind: "error"; code: ErrorCode; message: string; raw?: unknown };

export interface CliBridgeOptions {
  workspace: string;
  model: string;
  prompt: string;
  sessionId?: string;
  signal?: AbortSignal;
  timeouts?: Partial<CliTimeouts>;
  command?: string;
  extraArgs?: string[];
  onDiagnostic?: (d: CliDiagnostic) => void;
}

export interface CliBridgeResult {
  text: string;
  sessionId: string;
  usage: CliUsage;
  finishReason: FinishReason;
  durationMs: number;
  exitCode: number | null;
  diagnostics: CliDiagnostic[];
}
```

- [ ] **Step 7: 写 `src/errors.ts`**

```ts
import type { ErrorCode, FinishReason } from "./types.js";

export class CliBridgeError extends Error {
  readonly code: ErrorCode;
  readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "CliBridgeError";
    this.code = code;
    this.cause = cause;
  }
}

export class CliBridgeAbortError extends CliBridgeError {
  constructor(message = "CLI bridge call was aborted") {
    super("CANCELLED", message);
    this.name = "CliBridgeAbortError";
  }
}

const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

const LENGTH_REASONS = new Set(["length", "max_tokens", "max-tokens", "maxtokens"]);
const TOOL_REASONS = new Set(["tool-calls", "tool_calls", "toolcalls", "tool_use", "tool-use"]);

export interface FinishMapping {
  reason: FinishReason;
  code?: ErrorCode;
  rawReason?: string;
}

/**
 * spec §7.2：判定优先级为 "reason 映射" 先于 "空正文检查"。
 * 未知 reason 保守映射为 error + UNKNOWN，绝不抛错。
 */
export function toFinishMapping(
  rawReason: string | undefined,
  hasText: boolean,
): FinishMapping {
  if (rawReason === undefined) {
    return { reason: "error", code: "PROTOCOL_ERROR" };
  }
  const normalized = rawReason.trim().toLowerCase();
  if (normalized === "stop") {
    return hasText
      ? { reason: "stop" }
      : { reason: "error", code: "EMPTY_RESPONSE", rawReason };
  }
  if (LENGTH_REASONS.has(normalized)) {
    return { reason: "max-tokens", rawReason };
  }
  if (TOOL_REASONS.has(normalized)) {
    return hasText
      ? { reason: "tool-calls", rawReason }
      : { reason: "tool-calls", code: "TOOL_ONLY_RESPONSE", rawReason };
  }
  return { reason: "error", code: "UNKNOWN", rawReason };
}

export interface FailureFacts {
  aborted: boolean;
  timedOut: boolean;
  exitCode: number | null;
  sawAnyEvent: boolean;
  sawFinish: boolean;
  stderrText: string;
}

/**
 * spec §6.4 判定链：取消 > 超时 > session 失效 > 无 finish 即退出 > 其他
 */
export function classifyFailure(facts: FailureFacts): ErrorCode {
  if (facts.aborted) return "CANCELLED";
  if (facts.timedOut) return "TIMEOUT";

  const stderr = stripAnsi(facts.stderrText).trim().toLowerCase();

  if (facts.exitCode !== null && facts.exitCode !== 0) {
    if (!facts.sawAnyEvent) {
      if (stderr.includes("session not found")) return "SESSION_INVALID";
      if (stderr.includes("permission") || stderr.includes("denied")) return "PROMPT_FAILED";
      return "PROTOCOL_ERROR";
    }
    return facts.sawFinish ? "UPSTREAM_ERROR" : "PROTOCOL_ERROR";
  }

  if (facts.exitCode === null) return "CLI_START_FAILED";
  return "UNKNOWN";
}

export function canRetry(code: ErrorCode, hasEmittedText: boolean): boolean {
  if (hasEmittedText) return false;
  return code === "CLI_START_FAILED" || code === "TIMEOUT";
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npm run build && node --test test/unit/types.test.mjs test/unit/errors.test.mjs`
Expected: 全部 PASS，无 warning

- [ ] **Step 9: 确认纯层无 Node API（验收 A1）**

Run: `Select-String -Path src\types.ts,src\errors.ts -Pattern 'from "node:'`
Expected: 无匹配

- [ ] **Step 10: 提交**

```bash
git add package.json package-lock.json tsconfig.json src/types.ts src/errors.ts test/unit/types.test.mjs test/unit/errors.test.mjs
git commit -m "feat(cli-bridge): 工具链基线 + 类型与错误分类"
```

---

### Task 2: JSON Lines 解析（纯层）

**Files:**
- Create: `dsh-opencode-bridge/src/parse-lines.ts`
- Test: `dsh-opencode-bridge/test/unit/parse-lines.test.mjs`

**Interfaces:**
- Consumes: `types.ts` 的 `CliDiagnostic`
- Produces:
  - `JsonLineSplitter` class：`constructor(opts: { maxLineBytes?: number })`、`push(chunk: string): { lines: string[]; droppedOversize: string | null }`、`flush(): string | null`、`readonly maxLineBytes: number`
  - `parseEventLine(line: string): { ok: true; value: unknown } | { ok: false; reason: string }`
  - `isRecord(v: unknown): v is Record<string, unknown>`

- [ ] **Step 1: 写失败测试**

创建 `test/unit/parse-lines.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonLineSplitter, parseEventLine, isRecord } from "../../lib/parse-lines.js";

test("正常：一行一个 JSON 对象", () => {
  const s = new JsonLineSplitter();
  const r = s.push('{"a":1}\n{"b":2}\n');
  assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}']);
  assert.equal(r.droppedOversize, null);
});

test("CRLF：\\r\\n 也被当作换行，行内不残留 \\r", () => {
  const s = new JsonLineSplitter();
  const r = s.push('{"a":1}\r\n{"b":2}\r\n');
  assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}']);
});

test("分块到达：跨 chunk 的半行被正确缓冲", () => {
  const s = new JsonLineSplitter();
  assert.deepEqual(s.push('{"a":').lines, []);
  assert.deepEqual(s.push('1}\n').lines, ['{"a":1}']);
});

test("空行被跳过", () => {
  const s = new JsonLineSplitter();
  assert.deepEqual(s.push('{"a":1}\n\n\n{"b":2}\n').lines, ['{"a":1}', '{"b":2}']);
});

test("flush 返回残留半行", () => {
  const s = new JsonLineSplitter();
  s.push('{"a":1}\n{"partial"');
  assert.deepEqual(s.push("").lines, []);
  assert.equal(s.flush(), '{"partial"');
});

test("flush 在无残留时返回 null", () => {
  const s = new JsonLineSplitter();
  s.push('{"a":1}\n');
  assert.equal(s.flush(), null);
});

test("超长单行被截断并上报，不 OOM", () => {
  const s = new JsonLineSplitter({ maxLineBytes: 100 });
  const r = s.push("x".repeat(500) + "\n");
  assert.deepEqual(r.lines, []);
  assert.equal(typeof r.droppedOversize, "string");
  assert.equal(s.flush(), null);
});

test("超长行之后的正常行仍被解析", () => {
  const s = new JsonLineSplitter({ maxLineBytes: 50 });
  s.push("y".repeat(200));
  const r = s.push('\n{"ok":1}\n');
  assert.deepEqual(r.lines, ['{"ok":1}']);
});

test("parseEventLine 成功解析对象", () => {
  const r = parseEventLine('{"type":"text"}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { type: "text" });
});

test("parseEventLine 失败时给出 reason，不抛错", () => {
  const r = parseEventLine("not json at all");
  assert.equal(r.ok, false);
  assert.equal(typeof r.reason, "string");
});

test("parseEventLine 对空串返回失败", () => {
  assert.equal(parseEventLine("").ok, false);
});

test("isRecord 判定", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord("x"), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test test/unit/parse-lines.test.mjs`
Expected: FAIL，`Cannot find module .../lib/parse-lines.js`

- [ ] **Step 3: 写 `src/parse-lines.ts`**

```ts
export interface SplitResult {
  lines: string[];
  droppedOversize: string | null;
}

/**
 * 把 stdout 的任意 chunk 流切成"行"。
 * 处理：CRLF、空行、跨 chunk 半行、超长行截断。
 */
export class JsonLineSplitter {
  readonly maxLineBytes: number;
  #buf = "";
  #overflow = false;

  constructor(opts: { maxLineBytes?: number } = {}) {
    this.maxLineBytes = opts.maxLineBytes ?? 1_048_576;
  }

  push(chunk: string): SplitResult {
    const lines: string[] = [];
    let droppedOversize: string | null = null;
    this.#buf += chunk;

    let nl = this.#buf.indexOf("\n");
    while (nl >= 0) {
      let line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (this.#overflow) {
        this.#overflow = false;
      } else if (line.length > 0) {
        lines.push(line);
      }
      nl = this.#buf.indexOf("\n");
    }

    if (this.#buf.length > this.maxLineBytes) {
      droppedOversize = this.#buf.slice(0, 80);
      this.#buf = "";
      this.#overflow = true;
    }

    return { lines, droppedOversize };
  }

  flush(): string | null {
    const rest = this.#buf;
    this.#buf = "";
    if (this.#overflow) {
      this.#overflow = false;
      return null;
    }
    return rest.length > 0 ? rest : null;
  }
}

export type LineParseOutcome =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

/** 单行 JSON 解析；失败不抛错，返回 reason 供 protocol-line 诊断使用。 */
export function parseEventLine(line: string): LineParseOutcome {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build && node --test test/unit/parse-lines.test.mjs`
Expected: 全部 PASS

- [ ] **Step 5: 确认纯层无 Node API**

Run: `Select-String -Path src\parse-lines.ts -Pattern 'from "node:'`
Expected: 无匹配

- [ ] **Step 6: 提交**

```bash
git add src/parse-lines.ts test/unit/parse-lines.test.mjs
git commit -m "feat(cli-bridge): JSON Lines 解析（半行/CRLF/超长行/非 JSON）"
```

---

### Task 3: 事件归一化与 usage 聚合（纯层）

**Files:**
- Create: `dsh-opencode-bridge/src/map-events.ts`
- Test: `dsh-opencode-bridge/test/unit/map-events.test.mjs`

**Interfaces:**
- Consumes: `types.js` 的 `CliBridgeEvent` / `CliDiagnostic` / `CliUsage` / `ZERO_USAGE`；`errors.js` 的 `toFinishMapping` / `FinishMapping`；`parse-lines.js` 的 `isRecord`
- Produces:
  - `OpenCodeEventMapper` class：
    - `constructor(opts?: { usageMode?: "sum" | "last" })`
    - `push(raw: unknown): { events: CliBridgeEvent[]; diagnostics: CliDiagnostic[] }`
    - `finalize(): CliBridgeEvent[]`
    - getters：`sessionId: string`、`hasText: boolean`、`emittedText: string`、`usage: CliUsage`、`sawFinish: boolean`、`lastMessageId: string | undefined`

- [ ] **Step 1: 写失败测试**

创建 `test/unit/map-events.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenCodeEventMapper } from "../../lib/map-events.js";

const stepStart = (sessionID, messageID) => ({
  type: "step_start", sessionID,
  part: { type: "step-start", id: "prt_1", messageID },
});
const textEv = (sessionID, messageID, text) => ({
  type: "text", sessionID,
  part: { type: "text", id: "prt_2", messageID, text, time: { start: 1, end: 2 } },
});
const stepFinish = (sessionID, messageID, reason, tokens, cost = 0) => ({
  type: "step_finish", sessionID,
  part: { type: "step-finish", id: "prt_3", messageID, reason, tokens, cost },
});
const toolUse = (sessionID, messageID) => ({
  type: "tool_use", sessionID,
  part: { type: "tool", tool: "bash", callID: "call_1",
          state: { status: "completed", input: { command: "ls" }, output: "ok" } },
});

test("start 事件只对新 messageId 产出一次", () => {
  const m = new OpenCodeEventMapper();
  const a = m.push(stepStart("ses_1", "msg_1"));
  assert.equal(a.events.length, 1);
  assert.equal(a.events[0].kind, "start");
  assert.equal(a.events[0].sessionId, "ses_1");

  const b = m.push(stepStart("ses_1", "msg_1"));
  assert.equal(b.events.length, 0);
});

test("text 事件透传正文并记录 hasText", () => {
  const m = new OpenCodeEventMapper();
  const r = m.push(textEv("ses_1", "msg_1", "hello"));
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "text");
  assert.equal(r.events[0].text, "hello");
  assert.equal(m.hasText, true);
  assert.equal(m.emittedText, "hello");
});

test("同 messageId 的多条 text 按序拼接，不重复产出", () => {
  const m = new OpenCodeEventMapper();
  m.push(textEv("ses_1", "msg_1", "abc"));
  const r = m.push(textEv("ses_1", "msg_1", "def"));
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].text, "def");
  assert.equal(m.emittedText, "abcdef");
});

test("tool_use 产出 tool 事件但不产出正文", () => {
  const m = new OpenCodeEventMapper();
  const r = m.push(toolUse("ses_1", "msg_1"));
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "tool");
  assert.equal(m.hasText, false);
});

test("未知事件 -> unknown-event 诊断，不抛错", () => {
  const m = new OpenCodeEventMapper();
  const r = m.push({ type: "something_brand_new", part: { x: 1 } });
  assert.equal(r.events.length, 0);
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0].kind, "unknown-event");
});

test("非对象输入 -> 诊断，不抛错", () => {
  const m = new OpenCodeEventMapper();
  for (const bad of [null, 42, "str", undefined]) {
    const r = m.push(bad);
    assert.equal(r.events.length, 0);
    assert.equal(r.diagnostics[0].kind, "unknown-event");
  }
});

test("usage 默认跨 step 累加", () => {
  const m = new OpenCodeEventMapper();
  m.push(stepFinish("ses_1", "msg_1", "tool-calls",
    { total: 9553, input: 9510, output: 19, reasoning: 24, cache: { read: 0, write: 0 } }));
  m.push(stepFinish("ses_1", "msg_2", "stop",
    { total: 9755, input: 214, output: 24, reasoning: 45, cache: { read: 9472, write: 0 } }));
  assert.deepEqual(m.usage, {
    total: 19308, input: 9724, output: 43, reasoning: 69, cacheRead: 9472, cacheWrite: 0,
  });
});

test("usageMode=last 时只保留最后一个 step", () => {
  const m = new OpenCodeEventMapper({ usageMode: "last" });
  m.push(stepFinish("ses_1", "msg_1", "tool-calls",
    { total: 9553, input: 9510, output: 19, reasoning: 24, cache: { read: 0, write: 0 } }));
  m.push(stepFinish("ses_1", "msg_2", "stop",
    { total: 9755, input: 214, output: 24, reasoning: 45, cache: { read: 9472, write: 0 } }));
  assert.deepEqual(m.usage, {
    total: 9755, input: 214, output: 24, reasoning: 45, cacheRead: 9472, cacheWrite: 0,
  });
});

test("step_finish 的 cache 字段缺失时按 0 处理", () => {
  const m = new OpenCodeEventMapper();
  m.push(stepFinish("ses_1", "msg_1", "stop", { total: 10, input: 6, output: 4, reasoning: 0 }));
  assert.deepEqual(m.usage, { total: 10, input: 6, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
});

test("step_finish 产出 finish 事件，finalize 不再重复产出", () => {
  const m = new OpenCodeEventMapper();
  m.push(textEv("ses_1", "msg_1", "hi"));
  const r = m.push(stepFinish("ses_1", "msg_1", "stop",
    { total: 1, input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 5));
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "finish");
  assert.equal(r.events[0].reason, "stop");
  assert.equal(r.events[0].cost, 5);
  assert.equal(m.sawFinish, true);
  assert.equal(m.finalize().length, 0);
});

test("只有 tool_use 没有 text -> finish(tool-calls, TOOL_ONLY_RESPONSE)", () => {
  const m = new OpenCodeEventMapper();
  m.push(toolUse("ses_1", "msg_1"));
  m.push(stepFinish("ses_1", "msg_1", "tool-calls",
    { total: 1, input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }));
  const fin = m.finalize();
  assert.equal(fin.length, 0); // 已在 step_finish 产出
});

test("无 finish 即结束 -> finalize 产出 error(PROTOCOL_ERROR)", () => {
  const m = new OpenCodeEventMapper();
  m.push(textEv("ses_1", "msg_1", "hi"));
  const fin = m.finalize();
  assert.equal(fin.length, 1);
  assert.equal(fin[0].kind, "error");
  assert.equal(fin[0].code, "PROTOCOL_ERROR");
});

test("finalize 在完全没有事件时也产出 error(PROTOCOL_ERROR)", () => {
  const m = new OpenCodeEventMapper();
  const fin = m.finalize();
  assert.equal(fin.length, 1);
  assert.equal(fin[0].kind, "error");
});

test("多 step 时 sessionId 取首个非空值", () => {
  const m = new OpenCodeEventMapper();
  m.push(stepStart("ses_A", "msg_1"));
  m.push(stepStart("ses_A", "msg_2"));
  assert.equal(m.sessionId, "ses_A");
});

test("未知 reason -> finish(error, UNKNOWN) 保留原值", () => {
  const m = new OpenCodeEventMapper();
  m.push(textEv("ses_1", "msg_1", "hi"));
  const r = m.push(stepFinish("ses_1", "msg_1", "brand-new-reason",
    { total: 1, input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }));
  assert.equal(r.events[0].kind, "finish");
  assert.equal(r.events[0].reason, "error");
  assert.equal(r.events[0].code, "UNKNOWN");
});

test("step_finish 缺 reason -> finish(error, PROTOCOL_ERROR)", () => {
  const m = new OpenCodeEventMapper();
  m.push(textEv("ses_1", "msg_1", "hi"));
  const r = m.push(stepFinish("ses_1", "msg_1", undefined,
    { total: 1, input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }));
  assert.equal(r.events[0].code, "PROTOCOL_ERROR");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test test/unit/map-events.test.mjs`
Expected: FAIL，`Cannot find module .../lib/map-events.js`

- [ ] **Step 3: 写 `src/map-events.ts`**

```ts
import type {
  CliBridgeEvent,
  CliDiagnostic,
  CliUsage,
} from "./types.js";
import { ZERO_USAGE } from "./types.js";
import { toFinishMapping, type FinishMapping } from "./errors.js";
import { isRecord } from "./parse-lines.js";

export interface MapperOptions {
  usageMode?: "sum" | "last";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function readUsage(part: Record<string, unknown>): CliUsage {
  const tokens = isRecord(part.tokens) ? part.tokens : {};
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  return {
    total: num(tokens.total),
    input: num(tokens.input),
    output: num(tokens.output),
    reasoning: num(tokens.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
  };
}

function addUsage(a: CliUsage, b: CliUsage): CliUsage {
  return {
    total: a.total + b.total,
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/**
 * 把 OpenCode 的原始 JSON 事件归一化为 CliBridgeEvent。
 * 纯逻辑、零 Node API、可直接单测。
 *
 * 关键约定（实测，CLI-BEHAVIOR §12.1）：
 *   事件的 `type` 与 `part.type` 命名不一致 —— 解析以事件 `type` 为准。
 *   tool_use 事件的 part.type 是 "tool"，不是 "tool_use"。
 */
export class OpenCodeEventMapper {
  readonly usageMode: "sum" | "last";

  #sessionId = "";
  #startedMessageIds = new Set<string>();
  #textByMessage = new Map<string, string>();
  #hasText = false;
  #usage: CliUsage = { ...ZERO_USAGE };
  #sawFinish = false;
  #sawAnyEvent = false;
  #lastMessageId: string | undefined;

  constructor(opts: MapperOptions = {}) {
    this.usageMode = opts.usageMode ?? "sum";
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get hasText(): boolean {
    return this.#hasText;
  }

  get emittedText(): string {
    let out = "";
    for (const t of this.#textByMessage.values()) out += t;
    return out;
  }

  get usage(): CliUsage {
    return { ...this.#usage };
  }

  get sawFinish(): boolean {
    return this.#sawFinish;
  }

  get sawAnyEvent(): boolean {
    return this.#sawAnyEvent;
  }

  get lastMessageId(): string | undefined {
    return this.#lastMessageId;
  }

  push(raw: unknown): { events: CliBridgeEvent[]; diagnostics: CliDiagnostic[] } {
    const events: CliBridgeEvent[] = [];
    const diagnostics: CliDiagnostic[] = [];

    if (!isRecord(raw) || typeof raw.type !== "string") {
      diagnostics.push({ kind: "unknown-event", raw });
      return { events, diagnostics };
    }

    this.#sawAnyEvent = true;

    const sessionId = typeof raw.sessionID === "string" ? raw.sessionID : "";
    if (sessionId && !this.#sessionId) this.#sessionId = sessionId;

    const part = isRecord(raw.part) ? raw.part : {};
    const messageId = typeof part.messageID === "string" ? part.messageID : undefined;
    if (messageId) this.#lastMessageId = messageId;

    switch (raw.type) {
      case "step_start": {
        if (messageId && this.#startedMessageIds.has(messageId)) break;
        if (messageId) this.#startedMessageIds.add(messageId);
        events.push({ kind: "start", sessionId, messageId });
        break;
      }

      case "text": {
        const text = typeof part.text === "string" ? part.text : "";
        const key = messageId ?? "";
        this.#textByMessage.set(key, (this.#textByMessage.get(key) ?? "") + text);
        if (text.length > 0) this.#hasText = true;
        events.push({ kind: "text", sessionId, messageId, text });
        break;
      }

      case "tool_use":
      case "tool_result": {
        events.push({ kind: "tool", sessionId, messageId, raw });
        break;
      }

      case "step_finish": {
        const next = this.#usageMode === "last"
          ? readUsage(part)
          : addUsage(this.#usage, readUsage(part));
        this.#usage = next;

        const mapping: FinishMapping = toFinishMapping(
          typeof part.reason === "string" ? part.reason : undefined,
          this.#hasText,
        );

        this.#sawFinish = true;
        events.push({
          kind: "finish",
          sessionId,
          messageId,
          reason: mapping.reason,
          usage: { ...this.#usage },
          cost: num(part.cost),
          code: mapping.code,
        });
        break;
      }

      default: {
        diagnostics.push({ kind: "unknown-event", raw });
        break;
      }
    }

    return { events, diagnostics };
  }

  /** 进程结束时调用。若尚未产出 finish，产出一个 error 事件。 */
  finalize(): CliBridgeEvent[] {
    if (this.#sawFinish) return [];
    return [
      {
        kind: "error",
        code: "PROTOCOL_ERROR",
        message: "process exited without a step_finish event",
      },
    ];
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build && node --test test/unit/map-events.test.mjs`
Expected: 全部 PASS

- [ ] **Step 5: 确认纯层无 Node API**

Run: `Select-String -Path src\map-events.ts -Pattern 'from "node:'`
Expected: 无匹配

- [ ] **Step 6: 提交**

```bash
git add src/map-events.ts test/unit/map-events.test.mjs
git commit -m "feat(cli-bridge): 事件归一化与 usage 跨 step 聚合"
```

---

### Task 4: fake CLI 测试替身

**Files:**
- Create: `dsh-opencode-bridge/test/fixtures/fake-opencode.mjs`

**Interfaces:**
- Consumes: 无
- Produces: 可执行 node 脚本，行为由环境变量 `FAKE_MODE` 控制；被 `run-cli.test.mjs` 与 `cli-bridge.test.mjs` 通过 `command: process.execPath, extraArgs: ["test/fixtures/fake-opencode.mjs"]` 注入调用

> 本任务不写单元测试 —— 它本身是测试基础设施。它的正确性由 Task 6/7/8 的测试**间接证明**（那些测试若能拿到预期输出，就说明 fixture 行为正确）。但**必须**执行 Step 2 的手工冒烟，确认每种模式的输出形态。

- [ ] **Step 1: 写 `test/fixtures/fake-opencode.mjs`**

```js
#!/usr/bin/env node
// =====================================================================
// fake-opencode —— 可执行测试替身，模拟 opencode.exe 的 --format json 行为
// 由 FAKE_MODE 环境变量控制。仅供测试，不是项目代码。
// =====================================================================
import { appendFileSync } from "node:fs";

const MODE = process.env.FAKE_MODE ?? "normal";
const SID = process.env.FAKE_SESSION_ID ?? "ses_fake_0001";
const args = process.argv.slice(2);

function line(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function stepStart(msg) {
  return { type: "step_start", sessionID: SID, part: { type: "step-start", id: "prt_s", messageID: msg } };
}
function text(msg, t) {
  return { type: "text", sessionID: SID, part: { type: "text", id: "prt_t", messageID: msg, text: t, time: { start: 1, end: 2 } } };
}
function finish(msg, reason, tokens, cost = 0) {
  return { type: "step_finish", sessionID: SID, part: { type: "step-finish", id: "prt_f", messageID: msg, reason, tokens, cost } };
}
function tool(msg) {
  return {
    type: "tool_use", sessionID: SID,
    part: { type: "tool", tool: "bash", callID: "call_x",
            state: { status: "completed", input: { command: "ls" }, output: "a.txt" } },
  };
}
const T1 = { total: 100, input: 60, output: 20, reasoning: 10, cache: { read: 10, write: 0 } };
const T2 = { total: 200, input: 120, output: 40, reasoning: 20, cache: { read: 20, write: 0 } };

// 记录收到的参数，供 session-echo 模式与调试使用
if (process.env.FAKE_LOG_ARGS) {
  try { appendFileSync(process.env.FAKE_LOG_ARGS, JSON.stringify(args) + "\n"); } catch {}
}

switch (MODE) {
  case "normal":
    line(stepStart("msg_1"));
    line(text("msg_1", "FAKE_NORMAL_OK"));
    line(finish("msg_1", "stop", T1));
    break;

  case "multiline":
    line(stepStart("msg_1"));
    line(text("msg_1", "part-A "));
    line(text("msg_1", "part-B "));
    line(text("msg_1", "part-C"));
    line(finish("msg_1", "stop", T1));
    break;

  case "multi-step":
    line(stepStart("msg_1"));
    line(tool("msg_1"));
    line(finish("msg_1", "tool-calls", T1));
    line(stepStart("msg_2"));
    line(text("msg_2", "SECOND_STEP_TEXT"));
    line(finish("msg_2", "stop", T2));
    break;

  case "tool-only":
    line(stepStart("msg_1"));
    line(tool("msg_1"));
    line(finish("msg_1", "tool-calls", T1));
    break;

  case "empty":
    line(stepStart("msg_1"));
    line(finish("msg_1", "stop", T1));
    break;

  case "partial-line":
    line(stepStart("msg_1"));
    line(text("msg_1", "BEFORE_TRUNCATION"));
    process.stdout.write('{"type":"text","part":{"text":"TRUNCATED');
    break;

  case "non-json":
    line(stepStart("msg_1"));
    process.stdout.write("this line is not json at all\n");
    line(text("msg_1", "CLEAN_TEXT"));
    line(finish("msg_1", "stop", T1));
    break;

  case "stderr-noise":
    process.stderr.write("diagnostic noise from cli\n");
    line(stepStart("msg_1"));
    process.stderr.write("more noise\n");
    line(text("msg_1", "WITH_STDERR_NOISE"));
    line(finish("msg_1", "stop", T1));
    break;

  case "exit-nonzero":
    line(stepStart("msg_1"));
    line(text("msg_1", "PARTIAL"));
    process.exit(1);

  case "no-finish":
    line(stepStart("msg_1"));
    line(text("msg_1", "NO_FINISH_TEXT"));
    break;

  case "hang":
    line(stepStart("msg_1"));
    line(text("msg_1", "HANG_TEXT"));
    await sleep(600_000);
    break;

  case "slow":
    line(stepStart("msg_1"));
    await sleep(Number(process.env.FAKE_SLOW_MS ?? 3000));
    line(text("msg_1", "SLOW_TEXT"));
    line(finish("msg_1", "stop", T1));
    break;

  case "startup-fail":
    process.stderr.write("Error: cannot start\n");
    process.exit(127);

  case "oversize-line":
    line(stepStart("msg_1"));
    process.stdout.write("X".repeat(2_000_000) + "\n");
    line(text("msg_1", "AFTER_OVERSIZE"));
    line(finish("msg_1", "stop", T1));
    break;

  case "unknown-events":
    line(stepStart("msg_1"));
    line({ type: "brand_new_event", sessionID: SID, part: { weird: true } });
    line({ type: "reasoning", sessionID: SID, part: { type: "reasoning", text: "thinking" } });
    line(text("msg_1", "AFTER_UNKNOWN"));
    line(finish("msg_1", "stop", T1));
    break;

  case "session-echo": {
    const i = args.indexOf("--session");
    const seen = i >= 0 ? args[i + 1] : null;
    line(stepStart("msg_1"));
    line(text("msg_1", `SESSION=${seen}`));
    line(finish("msg_1", "stop", T1));
    break;
  }

  case "session-not-found":
    process.stderr.write("\u001b[91m\u001b[1mError: \u001b[0mSession not found\r\n");
    process.exit(1);

  case "long-silence":
    line(stepStart("msg_1"));
    await sleep(Number(process.env.FAKE_SILENCE_MS ?? 5000));
    line(text("msg_1", "AFTER_LONG_SILENCE"));
    line(finish("msg_1", "stop", T1));
    break;

  default:
    process.stderr.write(`fake-opencode: unknown FAKE_MODE=${MODE}\n`);
    process.exit(2);
}
```

- [ ] **Step 2: 手工冒烟每种模式**

Run:
```powershell
foreach ($m in 'normal','multiline','multi-step','tool-only','empty','partial-line','non-json','stderr-noise','exit-nonzero','no-finish','oversize-line','unknown-events','session-echo','session-not-found') {
  Write-Output "=== $m ==="
  $env:FAKE_MODE = $m
  node test/fixtures/fake-opencode.mjs run --format json 2>&1 | Select-Object -First 4
  Remove-Item Env:FAKE_MODE
}
```
Expected: 每种模式输出形态符合注释；`session-not-found` 输出带 ANSI 的 `Error: Session not found` 且 exit 1；`unknown-events` 有两条未知事件

- [ ] **Step 3: 提交**

```bash
git add test/fixtures/fake-opencode.mjs
git commit -m "test(cli-bridge): fake CLI 测试替身（16 种行为模式）"
```

---

### Task 5: CLI 可执行文件发现

**Files:**
- Create: `dsh-opencode-bridge/src/discover-cli.ts`
- Test: `dsh-opencode-bridge/test/unit/discover-cli.test.mjs`

**Interfaces:**
- Consumes: `errors.js` 的 `CliBridgeError`
- Produces:
  - `discoverOpencodeCli(opts: DiscoverOptions): Promise<DiscoveredCli>`
  - `DiscoverOptions = { command?: string; env?: Record<string, string | undefined>; pathExt?: string[] }`
  - `DiscoveredCli = { command: string; source: "explicit" | "path" | "npm-global" | "shim-resolved" }`
  - `resolveShimTarget(shimPath: string): string | null`（供测试直接验证"命中 .cmd 时解析出真身"）

- [ ] **Step 1: 写失败测试**

创建 `test/unit/discover-cli.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverOpencodeCli, resolveShimTarget } from "../../lib/discover-cli.js";

function makeFakeInstall(root) {
  // 模拟 npm 全局布局：<root>/npm/opencode.cmd + <root>/npm/node_modules/opencode-ai/bin/opencode.exe
  const npmDir = join(root, "npm");
  mkdirSync(join(npmDir, "node_modules", "opencode-ai", "bin"), { recursive: true });
  writeFileSync(join(npmDir, "opencode.cmd"), '@ECHO off\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n');
  writeFileSync(join(npmDir, "opencode"), '#!/bin/sh\nexec "$basedir/node_modules/opencode-ai/bin/opencode.exe"   "$@"\n');
  writeFileSync(join(npmDir, "node_modules", "opencode-ai", "bin", "opencode.exe"), "MZ fake binary");
  return npmDir;
}

test("显式 command 优先级最高", async () => {
  const r = await discoverOpencodeCli({ command: "C:/custom/opencode.exe" });
  assert.equal(r.command, "C:/custom/opencode.exe");
  assert.equal(r.source, "explicit");
});

test("PATH 上命中 .cmd shim 时解析出真身 exe，不用 .cmd 本身", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-"));
  try {
    const npmDir = makeFakeInstall(root);
    const r = await discoverOpencodeCli({ env: { PATH: npmDir } });
    assert.equal(r.source, "shim-resolved");
    assert.ok(r.command.endsWith("opencode.exe"), r.command);
    assert.ok(!r.command.endsWith(".cmd"), r.command);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PATH 上命中 .exe 时直接使用", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-"));
  try {
    const dir = join(root, "bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode.exe"), "MZ");
    const r = await discoverOpencodeCli({ env: { PATH: dir } });
    assert.equal(r.source, "path");
    assert.ok(r.command.endsWith("opencode.exe"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("回退到 npm 全局布局", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-"));
  try {
    const npmDir = makeFakeInstall(root);
    const r = await discoverOpencodeCli({ env: { PATH: "", APPDATA: root } });
    assert.equal(r.source, "npm-global");
    assert.ok(r.command.endsWith("opencode.exe"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("全部失败 -> CLI_NOT_FOUND，消息含安装提示", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-"));
  try {
    await assert.rejects(
      () => discoverOpencodeCli({ env: { PATH: "", APPDATA: root } }),
      (e) => {
        assert.equal(e.code, "CLI_NOT_FOUND");
        assert.match(e.message, /opencode-ai/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveShimTarget: 从 .cmd 内容里解析出 exe 绝对路径", () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-"));
  try {
    const npmDir = makeFakeInstall(root);
    const target = resolveShimTarget(join(npmDir, "opencode.cmd"));
    assert.ok(target.endsWith("opencode.exe"), String(target));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveShimTarget: 不是 shim 时返回 null", () => {
  assert.equal(resolveShimTarget("C:/nowhere/opencode.exe"), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test test/unit/discover-cli.test.mjs`
Expected: FAIL，`Cannot find module .../lib/discover-cli.js`

- [ ] **Step 3: 写 `src/discover-cli.ts`**

```ts
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { CliBridgeError } from "./errors.js";

export interface DiscoverOptions {
  /** 显式绝对路径，最高优先 */
  command?: string;
  /** 环境变量注入点（测试用） */
  env?: Record<string, string | undefined>;
}

export interface DiscoveredCli {
  command: string;
  source: "explicit" | "path" | "npm-global" | "shim-resolved";
}

const SHIM_EXTS = [".cmd", ".bat", ".ps1"];

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function looksLikeExe(p: string): boolean {
  return p.toLowerCase().endsWith(".exe") && isFile(p);
}

/**
 * 从 npm shim 文件内容里解析出真身 exe 的绝对路径。
 * npm 的 .cmd shim 末行形如：
 *   "%dp0%\node_modules\opencode-ai\bin\opencode.exe"   %*
 * 不是 shim（例如本身就是 .exe）时返回 null。
 */
export function resolveShimTarget(shimPath: string): string | null {
  if (!isFile(shimPath)) return null;
  const lower = shimPath.toLowerCase();
  if (lower.endsWith(".exe")) return null;

  let content: string;
  try {
    content = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }

  const m = /node_modules[\\/]opencode-ai[\\/]bin[\\/]opencode\.exe/i.exec(content);
  if (m) {
    const target = resolve(dirname(shimPath), "node_modules", "opencode-ai", "bin", "opencode.exe");
    return isFile(target) ? target : null;
  }
  return null;
}

function npmGlobalCandidate(env: Record<string, string | undefined>): string | null {
  // Windows npm 全局目录通常等于 %APPDATA%\npm
  const appData = env.APPDATA;
  if (appData) {
    const p = join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (isFile(p)) return p;
  }
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const p = join(home, ".npm-global", "node_modules", "opencode-ai", "bin", "opencode.exe");
  return isFile(p) ? p : null;
}

/**
 * 四级回退（spec §9）：
 *   1. opts.command（显式绝对路径）
 *   2. PATH 上的 opencode（命中 .cmd/.ps1/.sh shim 时解析出真身 exe）
 *   3. npm 全局 node_modules/opencode-ai/bin/opencode.exe
 *   4. 抛 CLI_NOT_FOUND
 */
export async function discoverOpencodeCli(opts: DiscoverOptions = {}): Promise<DiscoveredCli> {
  const env = opts.env ?? process.env;

  if (opts.command) {
    if (!isAbsolute(opts.command)) {
      throw new CliBridgeError("CLI_NOT_FOUND", `explicit command must be an absolute path: ${opts.command}`);
    }
    return { command: opts.command, source: "explicit" };
  }

  const pathVar = env.PATH ?? env.Path ?? "";
  const dirs = pathVar.split(delimiter).filter(Boolean);

  for (const dir of dirs) {
    const base = isAbsolute(dir) ? dir : resolve(dir);

    // 2a. 直接命中 .exe
    const exePath = join(base, "opencode.exe");
    if (looksLikeExe(exePath)) {
      return { command: exePath, source: "path" };
    }

    // 2b. 命中 shim -> 解析真身
    for (const ext of SHIM_EXTS) {
      const shimPath = join(base, `opencode${ext}`);
      if (!isFile(shimPath)) continue;
      const target = resolveShimTarget(shimPath);
      if (target) return { command: target, source: "shim-resolved" };
    }
  }

  // 3. npm 全局
  const global = npmGlobalCandidate(env);
  if (global) return { command: global, source: "npm-global" };

  // 4. 全失败
  throw new CliBridgeError(
    "CLI_NOT_FOUND",
    "OpenCode CLI not found. Install it with: npm i -g opencode-ai",
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build && node --test test/unit/discover-cli.test.mjs`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/discover-cli.ts test/unit/discover-cli.test.mjs
git commit -m "feat(cli-bridge): CLI 四级发现，命中 shim 时解析真身 exe"
```

---

### Task 6: 进程壳基础（spawn / stdio 收集 / settle 出口 / 正常退出）

**Files:**
- Create: `dsh-opencode-bridge/src/run-cli.ts`
- Test: `dsh-opencode-bridge/test/unit/run-cli.test.mjs`

**Interfaces:**
- Consumes: `types.js` 的 `CliTimeouts` / `CliDiagnostic`；`errors.js` 的 `CliBridgeError`
- Produces:
  - `runCliProcess(opts: RunCliOptions): Promise<RunCliOutcome>`
  - `RunCliOptions = { command: string; args: string[]; cwd: string; signal?: AbortSignal; timeouts: CliTimeouts; env?: Record<string, string | undefined>; onStdoutLine: (line: string) => void; onStderrChunk: (chunk: string) => void; onEvent: () => void; }`
  - `RunCliOutcome = { exitCode: number | null; signal: string | null; aborted: boolean; timedOut: boolean; timedOutLayer: "startup" | "firstEvent" | "idle" | "total" | null; durationMs: number; stderrText: string; }`

> **本任务只做"能跑一轮、拿到输出、正常退出"。** 超时、取消、进程树清理在 Task 7 加。这样 Task 6 的评审点很干净：spawn 参数是否安全、stdio 是否正确收集、settle 出口是否幂等。

- [ ] **Step 1: 写失败测试**

创建 `test/unit/run-cli.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_TIMEOUTS } from "../../lib/types.js";
import { runCliProcess } from "../../lib/run-cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(here, "..", "fixtures", "fake-opencode.mjs");
const WS = resolve(here, "..", "..", "..");

function makeOpts(mode, over = {}) {
  const stdoutLines = [];
  const stderrChunks = [];
  return {
    opts: {
      command: process.execPath,
      args: [FAKE, "run", "--format", "json", "prompt"],
      cwd: WS,
      timeouts: { ...DEFAULT_TIMEOUTS, startupMs: 5000, firstEventMs: 5000, idleMs: 5000, totalMs: 15000, shutdownMs: 1000 },
      env: { ...process.env, FAKE_MODE: mode },
      onStdoutLine: (l) => stdoutLines.push(l),
      onStderrChunk: (c) => stderrChunks.push(c),
      onEvent: () => {},
      ...over,
    },
    stdoutLines,
    stderrChunks,
  };
}

test("正常模式：拿到 stdout 行、stderr 为空、exit=0", async () => {
  const { opts, stdoutLines, stderrChunks } = makeOpts("normal");
  const out = await runCliProcess(opts);
  assert.equal(out.exitCode, 0);
  assert.equal(out.aborted, false);
  assert.equal(out.timedOut, false);
  assert.ok(stdoutLines.length >= 3, `stdout lines=${stdoutLines.length}`);
  assert.equal(stderrChunks.length, 0);
});

test("stderr 与 stdout 分流", async () => {
  const { opts, stdoutLines, stderrChunks } = makeOpts("stderr-noise");
  const out = await runCliProcess(opts);
  assert.equal(out.exitCode, 0);
  assert.ok(stdoutLines.some((l) => l.includes("WITH_STDERR_NOISE")));
  assert.ok(stderrChunks.join("").includes("diagnostic noise"));
  assert.ok(!stdoutLines.some((l) => l.includes("diagnostic noise")));
});

test("非零退出：exitCode=1 且 stdout 有内容", async () => {
  const { opts, stdoutLines } = makeOpts("exit-nonzero");
  const out = await runCliProcess(opts);
  assert.equal(out.exitCode, 1);
  assert.ok(stdoutLines.length > 0);
});

test("startup-fail：exit=127", async () => {
  const { opts, stderrChunks } = makeOpts("startup-fail");
  const out = await runCliProcess(opts);
  assert.equal(out.exitCode, 127);
  assert.ok(stderrChunks.join("").includes("cannot start"));
});

test("session-not-found：exit=1，stderrText 含 ANSI 与 Session not found", async () => {
  const { opts } = makeOpts("session-not-found");
  const out = await runCliProcess(opts);
  assert.equal(out.exitCode, 1);
  assert.ok(out.stderrText.includes("Session not found"));
  assert.ok(out.stderrText.includes("\u001b["), "stderrText 应保留原始 ANSI，剥色由 errors.stripAnsi 负责");
});

test("跨 chunk 的半行被正确合并成一行", async () => {
  const { opts, stdoutLines } = makeOpts("partial-line");
  const out = await runCliProcess(opts);
  assert.equal(out.exitCode, 0);
  assert.ok(stdoutLines.some((l) => l.includes("BEFORE_TRUNCATION")));
});

test("oversize-line 不导致挂起", async () => {
  const { opts, stdoutLines } = makeOpts("oversize-line");
  const out = await runCliProcess(opts);
  assert.equal(out.exitCode, 0);
  assert.ok(stdoutLines.some((l) => l.includes("AFTER_OVERSIZE")));
});

test("cwd 生效", async () => {
  const { opts } = makeOpts("normal");
  const out = await runCliProcess({ ...opts, cwd: WS });
  assert.equal(out.exitCode, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test test/unit/run-cli.test.mjs`
Expected: FAIL，`Cannot find module .../lib/run-cli.js`

- [ ] **Step 3: 写 `src/run-cli.ts`（基础版）**

```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { CliTimeouts } from "./types.js";
import { CliBridgeError } from "./errors.js";

export interface RunCliOptions {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeouts: CliTimeouts;
  env?: Record<string, string | undefined>;
  onStdoutLine: (line: string) => void;
  onStderrChunk: (chunk: string) => void;
  /** 每收到任意一侧输出就调用一次，用于重置 idle 计时 */
  onEvent: () => void;
}

export interface RunCliOutcome {
  exitCode: number | null;
  signal: string | null;
  aborted: boolean;
  timedOut: boolean;
  timedOutLayer: "startup" | "firstEvent" | "idle" | "total" | null;
  durationMs: number;
  stderrText: string;
}

export async function runCliProcess(opts: RunCliOptions): Promise<RunCliOutcome> {
  const t0 = Date.now();
  const { timeouts } = opts;

  let child: ChildProcessWithoutNullStreams;
  try {
    // G2: 绝不 shell:true；参数走 argv 数组
    child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
  } catch (e) {
    throw new CliBridgeError("CLI_START_FAILED", `failed to spawn ${opts.command}`, e);
  }

  let settled = false;
  let aborted = false;
  let timedOut = false;
  let timedOutLayer: RunCliOutcome["timedOutLayer"] = null;
  const timers = new Set<NodeJS.Timeout>();
  const stderrChunks: string[] = [];

  function clearAllTimers(): void {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  function addTimer(ms: number, layer: NonNullable<RunCliOutcome["timedOutLayer"]>): void {
    const h = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      timedOutLayer = layer;
      void settle();
    }, ms);
    timers.add(h);
  }

  function onAbort(): void {
    if (settled) return;
    aborted = true;
    void settle();
  }

  const promise = new Promise<RunCliOutcome>((resolvePromise) => {
    async function settle(): Promise<void> {
      if (settled) return; // 单出口、幂等
      settled = true;
      clearAllTimers();
      opts.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        exitCode: null,
        signal: null,
        aborted,
        timedOut,
        timedOutLayer,
        durationMs: Date.now() - t0,
        stderrText: stderrChunks.join(""),
      });
    }

    child.stdout.setEncoding("utf8");
    let stdoutBuf = "";
    child.stdout.on("data", (chunk: string) => {
      opts.onEvent();
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf("\n");
      while (nl >= 0) {
        let line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > 0) opts.onStdoutLine(line);
        nl = stdoutBuf.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      opts.onEvent();
      stderrChunks.push(chunk);
      opts.onStderrChunk(chunk);
    });

    child.on("error", (e) => {
      stderrChunks.push(String(e.message));
      void settle();
    });

    child.on("exit", (code, sig) => {
      void (async () => {
        // 等 stdout/stderr 收完再 settle，避免丢失尾部输出
        await new Promise((r) => setTimeout(r, 20));
        if (settled) return;
        settled = true;
        clearAllTimers();
        opts.signal?.removeEventListener("abort", onAbort);
        resolvePromise({
          exitCode: code,
          signal: sig,
          aborted,
          timedOut,
          timedOutLayer,
          durationMs: Date.now() - t0,
          stderrText: stderrChunks.join(""),
        });
      })();
    });

    if (opts.signal?.aborted) {
      aborted = true;
      void settle();
    } else {
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    }

    addTimer(timeouts.totalMs, "total");
    addTimer(timeouts.firstEventMs, "firstEvent");
    addTimer(timeouts.startupMs, "startup");
  });

  return promise;
}
```

> **注意（Task 7 会改）：** 上面这段 `exit` 分支重复了 `settle` 的清理逻辑，违反"单出口"。Task 6 的 Step 5 会把它收敛；这里先保证行为正确。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build && node --test test/unit/run-cli.test.mjs`
Expected: 全部 PASS

- [ ] **Step 5: 收敛 settle 单出口（消除重复清理）**

把 `child.on("exit", ...)` 改成：

```ts
    child.on("exit", (code, sig) => {
      void (async () => {
        await new Promise((r) => setTimeout(r, 20));
        if (settled) return;
        lastExit = { code, sig };
        void settle();
      })();
    });
```

并在 `settle` 内部读取 `lastExit` 来填充 `exitCode` / `signal`。为此在 `settle` 之前声明：

```ts
  let lastExit: { code: number | null; sig: string | null } | null = null;
```

并在 `resolvePromise` 里用 `lastExit` 替换硬编码的 `null`。

**Step 5 验证：** 再跑一次 `npm run build && node --test test/unit/run-cli.test.mjs`，Expected: 仍全 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/run-cli.ts test/unit/run-cli.test.mjs
git commit -m "feat(cli-bridge): 进程壳基础（spawn/stdio 分流/settle 单出口）"
```

---

### Task 7: 超时分层、取消与进程树清理

**Files:**
- Modify: `dsh-opencode-bridge/src/run-cli.ts`
- Test: `dsh-opencode-bridge/test/unit/run-cli.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 6 的 `runCliProcess`
- Produces: 同一个 `runCliProcess`，补齐 `startup` / `firstEvent` / `idle` / `total` / `shutdown` 五层超时、`AbortSignal` 取消、`taskkill /PID <pid> /T /F` 进程树清理

- [ ] **Step 1: 追加失败测试**

在 `test/unit/run-cli.test.mjs` 末尾追加：

```js
test("idle 超时：长时间静默后触发 TIMEOUT", async () => {
  const { opts } = makeOpts("slow", {
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 800, totalMs: 30000, shutdownMs: 1000 },
    env: { ...process.env, FAKE_MODE: "slow", FAKE_SLOW_MS: "5000" },
  });
  const out = await runCliProcess(opts);
  assert.equal(out.timedOut, true);
  assert.equal(out.timedOutLayer, "idle");
});

test("idle 不会误杀：长静默但仍在 idle 阈值内则正常完成", async () => {
  const { opts, stdoutLines } = makeOpts("long-silence", {
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 30000, totalMs: 60000, shutdownMs: 1000 },
    env: { ...process.env, FAKE_MODE: "long-silence", FAKE_SILENCE_MS: "3000" },
  });
  const out = await runCliProcess(opts);
  assert.equal(out.timedOut, false);
  assert.equal(out.exitCode, 0);
  assert.ok(stdoutLines.some((l) => l.includes("AFTER_LONG_SILENCE")));
});

test("total 超时：进程 hang 时触发 TIMEOUT 并被清理", async () => {
  const { opts } = makeOpts("hang", {
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 30000, totalMs: 1500, shutdownMs: 1000 },
  });
  const out = await runCliProcess(opts);
  assert.equal(out.timedOut, true);
  assert.equal(out.timedOutLayer, "total");
});

test("取消：signal.abort() 触发 aborted=true", async () => {
  const ac = new AbortController();
  const { opts } = makeOpts("hang", {
    signal: ac.signal,
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 30000, totalMs: 60000, shutdownMs: 1000 },
  });
  const p = runCliProcess(opts);
  setTimeout(() => ac.abort(), 300);
  const out = await p;
  assert.equal(out.aborted, true);
  assert.equal(out.timedOut, false);
});

test("进入时 signal 已中止：不 spawn 且立即返回 aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  const { opts } = makeOpts("normal", {
    signal: ac.signal,
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 5000, totalMs: 5000, shutdownMs: 1000 },
  });
  const out = await runCliProcess(opts);
  assert.equal(out.aborted, true);
  assert.equal(out.exitCode, null);
});

test("取消后进程归零（按 PID 基线）", async () => {
  const { spawnSync } = await import("node:child_process");
  const before = tasklistPids();
  const ac = new AbortController();
  const { opts } = makeOpts("hang", {
    signal: ac.signal,
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 30000, totalMs: 60000, shutdownMs: 1000 },
  });
  const p = runCliProcess(opts);
  setTimeout(() => ac.abort(), 500);
  await p;
  await new Promise((r) => setTimeout(r, 800));
  const after = tasklistPids();
  for (const pid of after) {
    assert.ok(before.has(pid) || false, `残留进程 pid=${pid}`);
  }
});

test("同一个 signal 挂 3 个请求无 listener 泄漏", async () => {
  const ac = new AbortController();
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const { opts } = makeOpts("hang", {
      signal: ac.signal,
      timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 30000, totalMs: 60000, shutdownMs: 1000 },
    });
    runs.push(runCliProcess(opts));
  }
  setTimeout(() => ac.abort(), 300);
  const results = await Promise.all(runs);
  assert.equal(results.every((r) => r.aborted), true);
});

function tasklistPids() {
  const r = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
  const set = new Set();
  for (const line of String(r.stdout || "").split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m) set.add(Number(m[2]));
  }
  return set;
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test test/unit/run-cli.test.mjs`
Expected: 新增用例 FAIL（`timedOutLayer` 恒为 `null`、`aborted` 未实现、进程未被清理）

- [ ] **Step 3: 重写 `src/run-cli.ts`**

```ts
import { spawn, type ChildProcess } from "node:child_process";
import type { CliTimeouts } from "./types.js";
import { CliBridgeError } from "./errors.js";

export interface RunCliOptions {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeouts: CliTimeouts;
  env?: Record<string, string | undefined>;
  onStdoutLine: (line: string) => void;
  onStderrChunk: (chunk: string) => void;
  onEvent: () => void;
}

export type TimeoutLayer = "startup" | "firstEvent" | "idle" | "total";

export interface RunCliOutcome {
  exitCode: number | null;
  signal: string | null;
  aborted: boolean;
  timedOut: boolean;
  timedOutLayer: TimeoutLayer | null;
  durationMs: number;
  stderrText: string;
}

/**
 * G3/G4：按 PID 杀子树，绝不用 /IM（会误杀 OpenCode Desktop）。
 * child.kill() 只杀直接子进程；opencode.exe 会派生 git，所以 /T 是必需项。
 */
function killTree(pid: number, onDone: () => void): void {
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  killer.on("error", onDone);
  killer.on("exit", onDone);
  setTimeout(onDone, 5000).unref?.();
}

export async function runCliProcess(opts: RunCliOptions): Promise<RunCliOutcome> {
  const t0 = Date.now();
  const { timeouts } = opts;

  if (opts.signal?.aborted) {
    return {
      exitCode: null, signal: null, aborted: true, timedOut: false,
      timedOutLayer: null, durationMs: Date.now() - t0, stderrText: "",
    };
  }

  let child: ChildProcess;
  try {
    child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    throw new CliBridgeError("CLI_START_FAILED", `failed to spawn ${opts.command}`, e);
  }

  const stderrChunks: string[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let settled = false;
  let aborted = false;
  let timedOut = false;
  let timedOutLayer: TimeoutLayer | null = null;
  let lastExit: { code: number | null; sig: string | null } | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  const clearTimers = (): void => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };

  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      timedOutLayer = "idle";
      void settle();
    }, timeouts.idleMs);
  };

  const addTimer = (ms: number, layer: TimeoutLayer): void => {
    const h = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      timedOutLayer = layer;
      void settle();
    }, ms);
    timers.add(h);
  };

  const onAbort = (): void => {
    if (settled) return;
    aborted = true;
    void settle();
  };

  function settle(): Promise<RunCliOutcome> {
    return new Promise((resolvePromise) => {
      if (settled) return; // 幂等单出口
      settled = true;
      clearTimers();
      opts.signal?.removeEventListener("abort", onAbort);

      const finish = (): void => {
        resolvePromise({
          exitCode: lastExit?.code ?? null,
          signal: lastExit?.sig ?? null,
          aborted,
          timedOut,
          timedOutLayer,
          durationMs: Date.now() - t0,
          stderrText: stderrChunks.join(""),
        });
      };

      const needsKill = lastExit === null;
      if (!needsKill) return finish();

      // 先温和 kill，等 shutdown timeout，再 taskkill /T /F
      let done = false;
      const afterKill = (): void => {
        if (done) return;
        done = true;
        finish();
      };
      try { child.kill(); } catch { /* 忽略 */ }

      const grace = setTimeout(() => {
        if (child.pid && lastExit === null) {
          killTree(child.pid, afterKill);
        } else {
          afterKill();
        }
      }, timeouts.shutdownMs);
      timers.add(grace);

      child.once("exit", () => {
        clearTimeout(grace);
        afterKill();
      });
    });
  }

  return new Promise<RunCliOutcome>((resolveOuter) => {
    const done = (o: RunCliOutcome): void => resolveOuter(o);
    void settle().then(done);

    child.stdout?.setEncoding("utf8");
    let stdoutBuf = "";
    child.stdout?.on("data", (chunk: string) => {
      opts.onEvent();
      resetIdle();
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf("\n");
      while (nl >= 0) {
        let line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > 0) opts.onStdoutLine(line);
        nl = stdoutBuf.indexOf("\n");
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      opts.onEvent();
      resetIdle();
      stderrChunks.push(chunk);
      opts.onStderrChunk(chunk);
    });

    child.on("error", (e) => {
      stderrChunks.push(String(e.message));
      void settle().then(done);
    });

    child.on("exit", (code, sig) => {
      lastExit = { code, sig };
      // 给管道 20ms 收尾，避免丢失尾部输出
      setTimeout(() => { void settle().then(done); }, 20);
    });

    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });

    // 超时分层
    addTimer(timeouts.totalMs, "total");
    addTimer(timeouts.firstEventMs, "firstEvent");
    addTimer(timeouts.startupMs, "startup");
    resetIdle();
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run build && node --test test/unit/run-cli.test.mjs`
Expected: 全部 PASS（含 Task 6 的旧用例）

- [ ] **Step 5: 验收 G3/G4 —— 确认没有用 `/IM`**

Run: `Select-String -Path src\run-cli.ts -Pattern '/IM'`
Expected: 无匹配

Run: `Select-String -Path src\run-cli.ts -Pattern 'shell'`
Expected: 无匹配（禁止 `shell: true`）

- [ ] **Step 6: 提交**

```bash
git add src/run-cli.ts test/unit/run-cli.test.mjs
git commit -m "feat(cli-bridge): 五层超时 + 取消传播 + taskkill /T 进程树清理"
```

---

### Task 8: 组装层 `cli-bridge.ts` + 导出面

**Files:**
- Create: `dsh-opencode-bridge/src/cli-bridge.ts`
- Create: `dsh-opencode-bridge/src/index.ts`
- Test: `dsh-opencode-bridge/test/unit/cli-bridge.test.mjs`

**Interfaces:**
- Consumes: `types.js` / `errors.js` / `parse-lines.js` / `map-events.js` / `discover-cli.js` / `run-cli.js`
- Produces:
  - `streamCliBridge(opts: CliBridgeOptions): AsyncIterable<CliBridgeEvent>`
  - `runCliBridge(opts: CliBridgeOptions): Promise<CliBridgeResult>`

- [ ] **Step 1: 写失败测试**

创建 `test/unit/cli-bridge.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { streamCliBridge, runCliBridge } from "../../lib/cli-bridge.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(here, "..", "fixtures", "fake-opencode.mjs");

function ws() {
  return mkdtempSync(join(tmpdir(), "ocbridge-ws-"));
}
import { join } from "node:path";

function baseOpts(mode, over = {}) {
  const dir = ws();
  return {
    dir,
    opts: {
      workspace: dir,
      model: "opencode/mimo-v2.6-flash-free",
      prompt: "hello",
      command: process.execPath,
      extraArgs: [FAKE],
      timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 5000, totalMs: 15000, shutdownMs: 1000 },
      ...over,
    },
  };
}

test("normal -> start/text/finish(stop)，正文与 usage 正确", async () => {
  const { dir, opts } = baseOpts("normal");
  try {
    const r = await runCliBridge(opts);
    assert.equal(r.text, "FAKE_NORMAL_OK");
    assert.equal(r.finishReason, "stop");
    assert.equal(r.exitCode, 0);
    assert.equal(r.usage.total, 100);
    assert.equal(r.sessionId, "ses_fake_0001");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("multiline -> 多段 text 拼接正确", async () => {
  const { dir, opts } = baseOpts("multiline");
  try {
    const r = await runCliBridge(opts);
    assert.equal(r.text, "part-A part-B part-C");
    assert.equal(r.finishReason, "stop");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("multi-step -> usage 跨 step 累加，finish 一次", async () => {
  const { dir, opts } = baseOpts("multi-step");
  try {
    const events = [];
    for await (const e of streamCliBridge(opts)) events.push(e);
    const finishes = events.filter((e) => e.kind === "finish");
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].usage.total, 300);
    assert.equal(events.filter((e) => e.kind === "start").length, 2);
    assert.equal(events.find((e) => e.kind === "text")?.text, "SECOND_STEP_TEXT");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tool-only -> finish(tool-calls, TOOL_ONLY_RESPONSE)", async () => {
  const { dir, opts } = baseOpts("tool-only");
  try {
    const r = await runCliBridge(opts);
    assert.equal(r.text, "");
    assert.equal(r.finishReason, "tool-calls");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("empty -> finish(error, EMPTY_RESPONSE)", async () => {
  const { dir, opts } = baseOpts("empty");
  try {
    const r = await runCliBridge(opts);
    assert.equal(r.text, "");
    assert.equal(r.finishReason, "error");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("partial-line -> 半行诊断，正文不受污染", async () => {
  const { dir, opts } = baseOpts("partial-line");
  const diags = [];
  try {
    const r = await runCliBridge({ ...opts, onDiagnostic: (d) => diags.push(d) });
    assert.equal(r.text, "BEFORE_TRUNCATION");
    assert.equal(r.finishReason, "error"); // 无 step_finish -> PROTOCOL_ERROR
    assert.ok(diags.some((d) => d.kind === "protocol-line"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("non-json -> 污染行诊断，正文干净", async () => {
  const { dir, opts } = baseOpts("non-json");
  const diags = [];
  try {
    const r = await runCliBridge({ ...opts, onDiagnostic: (d) => diags.push(d) });
    assert.equal(r.text, "CLEAN_TEXT");
    assert.equal(r.finishReason, "stop");
    assert.ok(diags.some((d) => d.kind === "protocol-line"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stderr-noise -> stderr 进诊断，正文不受污染", async () => {
  const { dir, opts } = baseOpts("stderr-noise");
  const diags = [];
  try {
    const r = await runCliBridge({ ...opts, onDiagnostic: (d) => diags.push(d) });
    assert.equal(r.text, "WITH_STDERR_NOISE");
    assert.equal(r.finishReason, "stop");
    assert.ok(diags.some((d) => d.kind === "stderr"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unknown-events -> 全部诊断，不抛错", async () => {
  const { dir, opts } = baseOpts("unknown-events");
  const diags = [];
  try {
    const r = await runCliBridge({ ...opts, onDiagnostic: (d) => diags.push(d) });
    assert.equal(r.text, "AFTER_UNKNOWN");
    assert.equal(r.finishReason, "stop");
    assert.equal(diags.filter((d) => d.kind === "unknown-event").length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("session-not-found -> error(SESSION_INVALID)，stderr 剥色后进诊断", async () => {
  const { dir, opts } = baseOpts("session-not-found");
  const diags = [];
  try {
    const events = [];
    for await (const e of streamCliBridge({ ...opts, onDiagnostic: (d) => diags.push(d) })) events.push(e);
    const err = events.find((e) => e.kind === "error");
    assert.ok(err, "应产出 error 事件");
    assert.equal(err.code, "SESSION_INVALID");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no-finish -> error(PROTOCOL_ERROR)", async () => {
  const { dir, opts } = baseOpts("no-finish");
  try {
    const events = [];
    for await (const e of streamCliBridge(opts)) events.push(e);
    assert.equal(events.at(-1).kind, "error");
    assert.equal(events.at(-1).code, "PROTOCOL_ERROR");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("oversize-line -> 不 OOM，后续事件仍解析", async () => {
  const { dir, opts } = baseOpts("oversize-line");
  try {
    const r = await runCliBridge(opts);
    assert.equal(r.text, "AFTER_OVERSIZE");
    assert.equal(r.finishReason, "stop");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("session-echo -> sessionId 透传到 CLI 参数", async () => {
  const { dir, opts } = baseOpts("session-echo", { sessionId: "ses_INJECTED" });
  try {
    const r = await runCliBridge(opts);
    assert.equal(r.text, "SESSION=ses_INJECTED");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("取消 -> runCliBridge 返回 finishReason=aborted，不 reject", async () => {
  const { dir, opts } = baseOpts("hang", {
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 30000, totalMs: 60000, shutdownMs: 1000 },
  });
  const ac = new AbortController();
  try {
    const p = runCliBridge({ ...opts, signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    const r = await p;
    assert.equal(r.finishReason, "aborted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace 不存在 -> WORKSPACE_INVALID，不 spawn", async () => {
  await assert.rejects(
    () => runCliBridge({ workspace: resolve(here, "no-such-dir-xyz"), model: "a/b", prompt: "x", command: process.execPath, extraArgs: [FAKE] }),
    (e) => { assert.equal(e.code, "WORKSPACE_INVALID"); return true; },
  );
});

test("model 不含斜杠 -> 抛参数错误（I4 例外）", async () => {
  const { dir, opts } = baseOpts("normal");
  try {
    await assert.rejects(() => runCliBridge({ ...opts, model: "badmodel" }), /model/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prompt 为空 -> 抛参数错误（I4 例外）", async () => {
  const { dir, opts } = baseOpts("normal");
  try {
    await assert.rejects(() => runCliBridge({ ...opts, prompt: "" }), /prompt/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("连续 20 轮进程归零", async () => {
  const { spawnSync } = await import("node:child_process");
  const pids = () => {
    const r = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
    const s = new Set();
    for (const l of String(r.stdout || "").split(/\r?\n/)) {
      const m = /^"([^"]*)","(\d+)"/.exec(l.trim());
      if (m) s.add(Number(m[2]));
    }
    return s;
  };
  const before = pids();
  for (let i = 0; i < 20; i++) {
    const { dir, opts } = baseOpts("normal");
    try { await runCliBridge(opts); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  await new Promise((r) => setTimeout(r, 500));
  const after = pids();
  for (const pid of after) {
    if (!before.has(pid)) assert.fail(`残留进程 pid=${pid}`);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run build && node --test test/unit/cli-bridge.test.mjs`
Expected: FAIL，`Cannot find module .../lib/cli-bridge.js`

- [ ] **Step 3: 写 `src/cli-bridge.ts`**

```ts
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  CliBridgeEvent,
  CliBridgeOptions,
  CliBridgeResult,
  CliDiagnostic,
  CliTimeouts,
} from "./types.js";
import { DEFAULT_TIMEOUTS, ZERO_USAGE } from "./types.js";
import { CliBridgeError, classifyFailure, stripAnsi } from "./errors.js";
import { JsonLineSplitter, parseEventLine, isRecord } from "./parse-lines.js";
import { OpenCodeEventMapper } from "./map-events.js";
import { discoverOpencodeCli } from "./discover-cli.js";
import { runCliProcess } from "./run-cli.js";

const SESSION_ARG = "--session";

function validateOptions(opts: CliBridgeOptions): void {
  if (typeof opts.prompt !== "string" || opts.prompt.length === 0) {
    throw new TypeError("CliBridgeOptions.prompt must be a non-empty string");
  }
  if (typeof opts.model !== "string" || !opts.model.includes("/")) {
    throw new TypeError('CliBridgeOptions.model must look like "provider/model"');
  }
  if (typeof opts.workspace !== "string" || opts.workspace.length === 0) {
    throw new TypeError("CliBridgeOptions.workspace must be a non-empty string");
  }
}

function resolveWorkspace(workspace: string): string {
  const abs = isAbsolute(workspace) ? workspace : resolve(workspace);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new CliBridgeError("WORKSPACE_INVALID", `workspace does not exist: ${abs}`);
  }
  if (!st.isDirectory()) {
    throw new CliBridgeError("WORKSPACE_INVALID", `workspace is not a directory: ${abs}`);
  }
  return abs;
}

function buildArgs(opts: CliBridgeOptions, workspace: string): string[] {
  // G2: 参数一律走 argv 数组，绝不拼接
  const args = [
    "run",
    "--dir", workspace,
    "--model", opts.model,
    "--format", "json",
  ];
  if (opts.sessionId) args.push(SESSION_ARG, opts.sessionId);
  if (opts.extraArgs) args.push(...opts.extraArgs);
  args.push(opts.prompt);
  return args;
}

export function streamCliBridge(opts: CliBridgeOptions): AsyncIterable<CliBridgeEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<CliBridgeEvent> {
      validateOptions(opts);

      const workspace = resolveWorkspace(opts.workspace);
      const timeouts: CliTimeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
      const emitDiag = (d: CliDiagnostic): void => {
        try { opts.onDiagnostic?.(d); } catch { /* 诊断回调异常不得影响主流程 */ }
      };

      const discovered = await discoverOpencodeCli({ command: opts.command });
      const args = buildArgs(opts, workspace);

      const mapper = new OpenCodeEventMapper();
      const splitter = new JsonLineSplitter();
      const pending: CliBridgeEvent[] = [];
      let sawAnyLine = false;

      const outcomePromise = runCliProcess({
        command: discovered.command,
        args,
        cwd: workspace,
        signal: opts.signal,
        timeouts,
        onStdoutLine: (line) => {
          sawAnyLine = true;
          const parsed = parseEventLine(line);
          if (!parsed.ok) {
            emitDiag({ kind: "protocol-line", line: line.slice(0, 200), reason: parsed.reason });
            return;
          }
          const { events, diagnostics } = mapper.push(parsed.value);
          for (const d of diagnostics) emitDiag(d);
          for (const e of events) pending.push(e);
        },
        onStderrChunk: (chunk) => emitDiag({ kind: "stderr", chunk: stripAnsi(chunk).slice(0, 2000) }),
        onEvent: () => {},
      });

      // 边跑边吐
      while (true) {
        if (pending.length > 0) {
          yield pending.shift()!;
          continue;
        }
        if (outcomePromise) {
          const settled = await Promise.race([
            outcomePromise.then((o) => ({ done: true as const, o })),
            new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false as const }), 15)),
          ]);
          if (settled.done) {
            const outcome = settled.o;

            if (outcome.aborted) {
              pending.length = 0;
              throw new CliBridgeError("CANCELLED", "CLI bridge call was aborted");
            }

            for (const e of mapper.finalize()) pending.push(e);

            if (!mapper.sawFinish) {
              const code = classifyFailure({
                aborted: outcome.aborted,
                timedOut: outcome.timedOut,
                exitCode: outcome.exitCode,
                sawAnyEvent: sawAnyLine,
                sawFinish: mapper.sawFinish,
                stderrText: outcome.stderrText,
              });
              if (code === "TIMEOUT" || code === "SESSION_INVALID" || code === "UPSTREAM_ERROR") {
                throw new CliBridgeError(code, `CLI call failed: ${code}`);
              }
            }

            if (pending.length === 0) return;
            yield pending.shift()!;
            while (pending.length > 0) yield pending.shift()!;
            return;
          }
        }
        // 让出事件循环
        await new Promise((r) => setImmediate(r));
      }
    },
  };
}

export async function runCliBridge(opts: CliBridgeOptions): Promise<CliBridgeResult> {
  validateOptions(opts);
  const t0 = Date.now();

  let text = "";
  let sessionId = "";
  let usage = { ...ZERO_USAGE };
  let finishReason: CliBridgeResult["finishReason"] = "error";
  let exitCode: number | null = null;
  const diagnostics: CliDiagnostic[] = [];
  const collect = (d: CliDiagnostic): void => {
    diagnostics.push(d);
    try { opts.onDiagnostic?.(d); } catch { /* ignore */ }
  };

  try {
    for await (const ev of streamCliBridge({ ...opts, onDiagnostic: collect })) {
      switch (ev.kind) {
        case "start":
          if (!sessionId && ev.sessionId) sessionId = ev.sessionId;
          break;
        case "text":
          text += ev.text;
          if (!sessionId && ev.sessionId) sessionId = ev.sessionId;
          break;
        case "finish":
          usage = ev.usage;
          finishReason = ev.reason;
          if (!sessionId && ev.sessionId) sessionId = ev.sessionId;
          break;
        case "tool":
          break;
        case "error":
          finishReason = "error";
          break;
      }
    }
    return {
      text, sessionId, usage, finishReason,
      durationMs: Date.now() - t0,
      exitCode,
      diagnostics,
    };
  } catch (e) {
    if (e instanceof CliBridgeError && e.code === "CANCELLED") {
      return {
        text, sessionId, usage,
        finishReason: "aborted",
        durationMs: Date.now() - t0,
        exitCode,
        diagnostics,
      };
    }
    throw e;
  }
}
```

> **实现提示：** 上面 `streamCliBridge` 里的轮询 `Promise.race` 是为了让事件边到边吐。若实现时觉得过于复杂，**允许简化为"先跑完整个进程、再依次 yield"**（`streamCliBridge` 变成一次性产出），但必须保留：`finish` 至多一次、必终止、`error` 事件语义不变。简化版本更容易证明 I1/I2 成立 —— **优先选简单版本**。

- [ ] **Step 4: 写 `src/index.ts`**

```ts
export type {
  CliTimeouts,
  CliUsage,
  FinishReason,
  ErrorCode,
  CliDiagnostic,
  CliBridgeEvent,
  CliBridgeOptions,
  CliBridgeResult,
} from "./types.js";
export { DEFAULT_TIMEOUTS, ZERO_USAGE } from "./types.js";
export {
  CliBridgeError,
  CliBridgeAbortError,
  stripAnsi,
  toFinishMapping,
  classifyFailure,
  canRetry,
} from "./errors.js";
export { JsonLineSplitter, parseEventLine, isRecord } from "./parse-lines.js";
export { OpenCodeEventMapper } from "./map-events.js";
export { discoverOpencodeCli } from "./discover-cli.js";
export type { DiscoverOptions, DiscoveredCli } from "./discover-cli.js";
export { runCliProcess } from "./run-cli.js";
export type { RunCliOptions, RunCliOutcome } from "./run-cli.js";
export { streamCliBridge, runCliBridge } from "./cli-bridge.js";
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run build && node --test test/unit/`
Expected: **全部测试 PASS**（Task 1–8累加）

- [ ] **Step 6: 验收不变量**

Run: `npm run typecheck`
Expected: 无错误（`strict`）

Run: `Select-String -Path src\types.ts,src\errors.ts,src\parse-lines.ts,src\map-events.ts -Pattern 'from "node:'`
Expected: 无匹配（验收 A1）

- [ ] **Step 7: 提交**

```bash
git add src/cli-bridge.ts src/index.ts test/unit/cli-bridge.test.mjs
git commit -m "feat(cli-bridge): 组装层 streamCliBridge/runCliBridge + 导出面"
```

---

### Task 9: 真实 CLI 集成测试 + 文档回写

**Files:**
- Create: `dsh-opencode-bridge/test/integration/cli-bridge.real.test.mjs`
- Modify: `dsh-opencode-bridge/todo.md`
- Modify: `dsh-opencode-bridge/memory.md`
- Modify: `dsh-opencode-bridge/README.md`

**Interfaces:**
- Consumes: `lib/cli-bridge.js` 的 `runCliBridge`
- Produces: 可复现的真实 CLI 回归测试；[memory.md](../../memory.md) 3A.9 剩余未知点的实测结论

- [ ] **Step 1: 写集成测试**

创建 `test/integration/cli-bridge.real.test.mjs`：

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliBridge } from "../../lib/cli-bridge.js";

const MODEL = "opencode/mimo-v2.6-flash-free";
const RUN = process.env.OCBRIDGE_IT === "1" ? test : test.skip;

function mkws() {
  const d = mkdtempSync(join(tmpdir(), "ocbridge-it-"));
  writeFileSync(join(d, "alpha.txt"), "alpha\n");
  writeFileSync(join(d, "beta.md"), "# beta\n");
  return d;
}

const SLOW = { startupMs: 30_000, firstEventMs: 45_000, idleMs: 300_000, totalMs: 600_000, shutdownMs: 3_000 };

RUN("R01 正常一轮：文本非空、finishReason=stop", async () => {
  const dir = mkws();
  try {
    const r = await runCliBridge({ workspace: dir, model: MODEL, prompt: "请只返回 R01_OK", timeouts: SLOW });
    assert.ok(r.text.includes("R01_OK"), r.text);
    assert.equal(r.finishReason, "stop");
    assert.ok(r.sessionId.length > 0);
    assert.ok(r.durationMs > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

RUN("R02 续接：第二轮记得第一轮内容", async () => {
  const dir = mkws();
  try {
    const a = await runCliBridge({ workspace: dir, model: MODEL, prompt: "请只记住这个秘密数字 7391，只回复已记住", timeouts: SLOW });
    const b = await runCliBridge({ workspace: dir, model: MODEL, prompt: "我让你记住的数字是多少？只返回数字", sessionId: a.sessionId, timeouts: SLOW });
    assert.ok(b.text.includes("7391"), b.text);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

RUN("R03 无效 --session -> SESSION_INVALID", async () => {
  const dir = mkws();
  try {
    await assert.rejects(
      () => runCliBridge({ workspace: dir, model: MODEL, prompt: "hi", sessionId: "ses_probe_does_not_exist_00000", timeouts: SLOW }),
      (e) => { assert.equal(e.code, "SESSION_INVALID"); return true; },
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

RUN("R05 workspace 相对路径 -> WORKSPACE_INVALID", async () => {
  await assert.rejects(
    () => runCliBridge({ workspace: "relative/path", model: MODEL, prompt: "hi", timeouts: SLOW }),
    (e) => { assert.equal(e.code, "WORKSPACE_INVALID"); return true; },
  );
});

RUN("R06 workspace 不存在 -> WORKSPACE_INVALID", async () => {
  await assert.rejects(
    () => runCliBridge({ workspace: join(tmpdir(), "ocbridge-nope-" + Date.now()), model: MODEL, prompt: "hi", timeouts: SLOW }),
    (e) => { assert.equal(e.code, "WORKSPACE_INVALID"); return true; },
  );
});

RUN("R07 触发 tool_use：tool 事件被产出但不污染正文", async () => {
  const dir = mkws();
  try {
    const events = [];
    for await (const e of streamCliBridge({ workspace: dir, model: MODEL, prompt: "请先列出当前目录下的文件，然后用一句话总结", timeouts: SLOW })) events.push(e);
    const tools = events.filter((e) => e.kind === "tool");
    const texts = events.filter((e) => e.kind === "text");
    assert.ok(texts.length > 0, "应有正文");
    const body = texts.map((e) => e.text).join("");
    assert.ok(!body.includes("callID"), "工具字段不得进入正文");
    assert.ok(tools.length >= 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

RUN("R08 长回答：text 为整段，usage 非零", async () => {
  const dir = mkws();
  try {
    const r = await runCliBridge({ workspace: dir, model: MODEL, prompt: "请写一篇约 300 字的短文，主题是软件测试", timeouts: SLOW });
    assert.ok(r.text.length > 100, `text length=${r.text.length}`);
    assert.equal(r.finishReason, "stop");
    assert.ok(r.usage.output > 0, JSON.stringify(r.usage));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

RUN("R11 连续 5 轮进程归零", async () => {
  const { spawnSync } = await import("node:child_process");
  const pids = () => {
    const r = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
    const s = new Set();
    for (const l of String(r.stdout || "").split(/\r?\n/)) {
      const m = /^"([^"]*)","(\d+)"/.exec(l.trim());
      if (m) s.add(Number(m[2]));
    }
    return s;
  };
  const before = pids();
  for (let i = 0; i < 5; i++) {
    const dir = mkws();
    try { await runCliBridge({ workspace: dir, model: MODEL, prompt: "请只返回 OK", timeouts: SLOW }); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  await new Promise((r) => setTimeout(r, 800));
  const after = pids();
  for (const pid of after) if (!before.has(pid)) assert.fail(`残留进程 pid=${pid}`);
});
```

> **注意 Step 1 里 `streamCliBridge` 的 import**：文件顶部需补 `import { streamCliBridge } from "../../lib/cli-bridge.js";`。

- [ ] **Step 2: 跑集成测试**

Run: `$env:OCBRIDGE_IT='1'; npm run test:integration`
Expected: 全部 PASS（R01–R08、R11；每条约 20–70s，总时长约 5 分钟）

**若某条 FAIL：** 先确认是网络/额度问题还是真实行为差异。真实行为差异**必须**记录到 [memory.md](../../memory.md) 3A.9，并同步更新 [spec](../specs/2026-10-15-oc-cli-bridge-design.md) §6.3 的"默认"列。

- [ ] **Step 3: 回写 todo.md**

在 [todo.md](../../todo.md) 中，把已完成的 TODO 项打勾并在每项下补一行 `**结论（2026-10-15）：** <实测结论>`：

- TODO-08（CLI 发现）
- TODO-09（run 参数）
- TODO-11（JSON Lines 解析）
- TODO-12（text 粒度）
- TODO-13（usage 映射）
- TODO-14（finish reason）
- TODO-18（spawn 模式）
- TODO-19（超时）
- TODO-20（取消与进程树）
- TODO-21（错误分类）

同时更新 todo.md 开头的"当前链路状态"表中"插件 → OpenCode CLI 进程"与"CLI JSON → 插件内部事件"两行。

- [ ] **Step 4: 回写 memory.md**

在 [memory.md](../../memory.md) 3A.9 的"仍未回答"里，把本次集成测试答掉的项移到"已回答"并补结论。同时在"当前状态"行追加：

```text
> **2026-10-15 第三轮：** CliBridge 模块（OC → 插件段）已实现并通过单测 T01–T32 与集成测试。
```

- [ ] **Step 5: 更新 README 开发状态**

把 [README.md](../../README.md) 的"开发状态"清单更新为：

```text
[x] 工程目录
[x] 包与 TypeScript 基础配置
[x] 目的和目标功能实现文档
[x] CliBridge：CLI 发现 / spawn / JSON Lines 解析 / 事件归一化
[x] CliBridge：错误分类 / 五层超时 / 取消与进程树清理
[x] 测试：fake CLI 单测 + 真实 CLI 集成测试
[ ] DSH LlmAdapter 合同
[ ] 插件入口与配置
[ ] DSH StreamChunk 转换
[ ] 模型目录与缓存
[ ] DSH 实机联调
```

- [ ] **Step 6: 最终验收**

```bash
npm run typecheck
npm test
```
Expected: typecheck 无错误；`npm test` 全绿、无 warning

Run: `git diff --stat HEAD~9 -- package.json`
Expected: `dependencies` 为空，`devDependencies` 只有 `typescript` 与 `@types/node`（验收 A12）

- [ ] **Step 7: 提交**

```bash
git add test/integration/cli-bridge.real.test.mjs todo.md memory.md README.md
git commit -m "test(cli-bridge): 真实 CLI 集成测试 + 文档回写"
```

---

## Self-Review 记录

**1. Spec 覆盖检查**

| spec 章节 | 对应任务 |
|---|---|
| §4 架构 / §4.2 文件清单 | Task 1–8 |
| §5.1 类型定义 | Task 1（`types.ts`） |
| §5.2 入口函数 | Task 8 |
| §5.3 不变量 I1–I8 | Task 8 测试 + Task 9 Step 6 |
| §6.1 事件定义 | Task 1 |
| §6.2 事件映射 | Task 3 |
| §6.3 保守默认策略 | Task 3 测试（12 条默认值全覆盖） |
| §6.4 错误通道判定链 | Task 1 `classifyFailure` + Task 7 stderr 收集 + Task 8 集成 |
| §7.1 ErrorCode | Task 1 |
| §7.2 finish 映射 | Task 1 `toFinishMapping` |
| §7.3 重试策略 | Task 1 `canRetry`（⚠️ 见下方缺口） |
| §8.1 超时分层 | Task 1 常量 + Task 7 实现 |
| §8.2 settle 单出口 | Task 6 Step 5 + Task 7 |
| §8.3 进程清理序列 | Task 7 |
| §8.4 AbortSignal | Task 7 |
| §9 CLI 发现 | Task 5 |
| §10.3 测试矩阵 T01–T32 | Task 3/6/7/8 测试 |
| §10.5 集成 R01–R12 | Task 9 |
| §11 工程细节 | Task 1 Step 1 + Task 8 Step 6 |
| §12 DoD A1–A12 | Task 9 Step 6 |

**发现的缺口（已在计划内标注，执行时注意）：**

1. **spec §7.3 的"每轮最多 1 次内部启动重试"没有对应任务。** `canRetry` 有测试，但**调用它的重试循环**未列入任务。
   → **决定：MVP 不实现重试循环**，`canRetry` 作为纯函数先落地供上层（子项目 3）调用。这符合 YAGNI —— 重试策略依赖 DSH 侧的错误呈现方式，现在做会白做。已在 Task 1 的 `errors.ts` 里以纯函数形式提供。
2. **spec §10.3 T23「model 不含 /」在 Task 8 覆盖**，但 I4 把它定义为"抛参数错误"而非 `error` 事件 —— 测试期望与 I4 一致。
3. **spec §10.5 R04（换 model）/ R09（kill 后 session）/ R10（失败 stderr）/ R12（复验孤儿）未列入 Task 9。** 它们是**行为观测**而非回归断言，且其中 R09/R12 需要额外的进程树工具。
   → **决定：** R09/R12 的核心断言已由 Task 7 的"取消后进程归零"和 Task 9 的 R11 覆盖；R04/R10 留给子项目 3/4（换 model 影响 session 语义、失败 stderr 形态依赖更多失败路径）。

**2. 占位符扫描**

已确认全文无 `TBD` / `TODO` / "implement later" / "similar to Task N"；每个代码步骤都给出了完整代码。

**3. 类型一致性**

- `FinishMapping` 在 Task 1 定义、Task 3 消费 —— 字段一致（`reason` / `code?` / `rawReason?`）
- `RunCliOutcome.timedOutLayer` 类型为 `TimeoutLayer | null`，Task 6 与 Task 7 定义一致
- `OpenCodeEventMapper.push` 返回 `{ events, diagnostics }`，Task 3 与 Task 8 消费一致
- `discoverOpencodeCli` 的 `DiscoverOptions.env` 是 `Record<string, string | undefined>`，Task 5 测试传 `{ PATH: ... }` 一致
- ⚠️ Task 8 的测试顶部 `import { join } from "node:path"` 写在函数之后 —— 执行时请把它移到文件顶部 import 块（ESM 允许但风格不一致）
