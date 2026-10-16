# dsh-opencode-bridge · OC → 插件段（CliBridge）设计定稿

> 日期：2026-10-15
> 状态：**定稿待评审**
> 覆盖范围：子项目 1 / 5 ——「OpenCode CLI → 插件」完整调用生命周期
> 实测依据：[docs/CLI-BEHAVIOR.md](../../CLI-BEHAVIOR.md)
> 上游记录：[memory.md](../../memory.md)、[todo.md](../../todo.md)

---

## 1. 背景与子项目切分

### 1.1 整体链路

```text
DSH Chat → DSH LLM Service → dsh-opencode-bridge 插件 → OpenCode CLI → 免费模型
```

### 1.2 子项目分解

| # | 子项目 | 依赖 | 本次 |
|---|---|---|---|
| **1** | **CliBridge：OC → 插件段** | 无 | ✅ **本 spec** |
| 2 | StreamChunk 转换器（插件 → DSH） | 1 + DSH StreamChunk 真实类型 | 后续 |
| 3 | `LlmAdapter` 接入与 provider 注册 | 1 + 2 + DSH 合同 | 后续 |
| 4 | session 映射持久化 | 3 + DSH chat ID 来源 | 后续 |
| 5 | 模型目录获取与缓存 | 3 + DSH 模型选择器 | 后续 |

**CliBridge 是唯一不依赖任何 DSH 未知点的子项目**，可以立刻做出可运行、可测试的代码。它把最脏的部分（Windows spawn、进程树、JSON Lines 边界、超时、取消、错误分类）隔离在一个不碰任何 DSH 概念的模块里。

### 1.3 本模块的一句话职责

> **"一次 OpenCode 问答调用的完整生命周期"** —— 从发现可执行文件，到进程完全归零。
> 中间不碰任何 DSH 概念，不落任何盘。

---

## 2. 目标 / 非目标

### 2.1 目标（全部可验收）

1. 发现 OpenCode CLI 可执行文件（真身 `.exe`），带安装提示
2. 在指定 workspace 中启动一次问答调用，返回事件流
3. 把 CLI 的 JSON Lines 输出归一化为 `CliBridgeEvent`
4. 提取 `sessionId` / `usage` / `finishReason`
5. 分层超时（startup / firstEvent / idle / total / shutdown）
6. 取消传播与 Windows 进程树清理，**进程归零可验证**
7. 错误分类到可编程判定的程度（12 类 `ErrorCode`）
8. 未知事件 / 协议污染**永不 crash**
9. 双层测试：fake CLI 单测 + 真实 CLI 集成测试

### 2.2 非目标（明确排除，写下来防止蔓延）

| 排除项 | 归属 |
|---|---|
| DSH `StreamChunk` / `text-delta` 切块 | 子项目 2 |
| DSH `LlmAdapter` 合同、provider 注册 | 子项目 3 |
| `sessionId` 的持久化与 `DSH chat ID → session` 映射 | 子项目 4 |
| 模型目录获取、缓存、能力元数据 | 子项目 5 |
| 设置页 / 配置 UI / client bundle | 全部后期 |
| 常驻 CLI 进程池 / `opencode serve` 模式 | 延迟优化 |
| 图片输入、reasoning 展示、工具调用转发 | MVP 不做 |
| IP 池、订阅、Go sidecar、流量伪装 | 永久排除 |

---

## 3. 硬约束（实测依据，不可协商）

全部来自 [docs/CLI-BEHAVIOR.md](../../CLI-BEHAVIOR.md)，此处只摘结论：

| # | 约束 | 依据 |
|---|---|---|
| C1 | **执行入口只能是 `opencode.exe` 真身** | §3–§5 |
| C2 | **禁止 `shell: true`** | 参数被 `%*` 改写、可命令注入；Node 发 `DEP0190` |
| C3 | **禁止 `.cmd` / `.bat` 作为执行入口** | Node 24 无 shell 抛 `EINVAL`；有 shell 则留孤儿 |
| C4 | `.cmd` 只作**发现线索**，命中即解析出真身 | npm 布局 |
| C5 | **`taskkill /PID <pid> /T /F` 是必需项**（`opencode.exe` 派生 `git` 子进程） | §5.2 |
| C6 | **禁止 `taskkill /IM`** | 会误杀 OpenCode Desktop 常驻进程 |
| C7 | `child.kill()` 只杀直接子进程，不能假设杀到真身 | §5.3 |
| C8 | 超时按 21s+ 实测留量 | §6 |
| C9 | **参数一律走 argv 数组**，绝不拼接命令行字符串 | §4 |
| C10 | 进程归零验证**按 PID 基线**，不能全机 grep `opencode` | §2 |

---

## 4. 架构

### 4.1 分层与依赖方向

```text
                ┌──────────────────────────────┐
   调用方 ────▶ │  cli-bridge.ts  (组装层)      │
                └──────┬───────────────┬───────┘
                       │               │
                       ▼               ▼
              ┌────────────────┐  ┌──────────────────┐
              │  run-cli.ts    │  │  map-events.ts   │  ← 纯层
              │  (进程壳)      │  │  (事件归一化)    │
              └───────┬────────┘  └────────┬─────────┘
                      │                    │
                      ▼                    ▼
              ┌────────────────┐  ┌──────────────────┐
              │  (注入的 spawn)│  │  parse-lines.ts  │  ← 纯层
              └────────────────┘  │  (JSON Lines)    │
                                  └────────┬─────────┘
                                           ▼
                                  ┌──────────────────┐
                                  │  errors.ts       │  ← 纯层
                                  │  types.ts        │
                                  └──────────────────┘
```

**依赖方向严格单向。** 纯层（`types` / `errors` / `parse-lines` / `map-events`）**不 import 任何 Node API**。

### 4.2 文件清单

```text
src/
├─ types.ts         纯类型：事件 / 选项 / 结果 / 用量
├─ errors.ts        CliBridgeError + ErrorCode + classifyError + toFinishReason（纯）
├─ parse-lines.ts   JSON Lines → OpenCodeEvent[]（纯；半行 / 污染 / 超长处理）
├─ map-events.ts    OpenCodeEvent → CliBridgeEvent（纯；usage 聚合、finish 映射）
├─ discover-cli.ts  可执行文件发现（唯一碰 fs / PATH 查找的地方）
├─ run-cli.ts       进程壳：spawn、管道、超时、取消、进程树清理
├─ cli-bridge.ts    组装层：streamCliBridge() + runCliBridge()
└─ index.ts         对外导出面

test/
├─ fixtures/
│  └─ fake-opencode.mjs      可执行 fake CLI（行为由环境变量控制）
├─ parse-lines.test.mjs
├─ map-events.test.mjs
├─ errors.test.mjs
├─ discover-cli.test.mjs
├─ cli-bridge.test.mjs       走 fake CLI，覆盖 spawn 全路径
└─ integration/
   └─ cli-bridge.real.test.mjs   真实 opencode（默认跳过）
```

### 4.3 为什么这样分

本模块 **80% 的风险在异常路径**（半行、污染、超时、kill、取消竞争），这些必须能**脱离真实进程单测**。纯层零 Node API 依赖意味着它们可以直接被测试打穿，不用 mock `child_process`。进程层刻意做薄，且 `command` / `spawn` 可注入 —— 这是测试能走**同一条 spawn 路径**的前提。

---

## 5. 对外契约

### 5.1 类型定义

```ts
// ---------- 输入 ----------
export interface CliBridgeOptions {
  /** 工作区绝对路径；模块内部 resolve 并校验存在 */
  workspace: string;
  /** 形如 "provider/model"，原样传给 --model */
  model: string;
  /** 任意用户文本；只走 argv 数组，绝不拼接命令行 */
  prompt: string;
  /** 纯入参。模块不持久化、不解析语义；缺失则由 CLI 自动创建 */
  sessionId?: string;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 超时覆盖，缺失项用默认值 */
  timeouts?: Partial<CliTimeouts>;
  /** 注入点：覆盖 CLI 可执行文件（测试用）。默认走 discover-cli */
  command?: string;
  /** 注入点：追加 CLI 参数（测试用） */
  extraArgs?: string[];
  /** 诊断回调：未知事件、协议污染、stderr、状态变化 */
  onDiagnostic?: (d: CliDiagnostic) => void;
}

export interface CliTimeouts {
  startupMs: number;    // 默认 30_000
  firstEventMs: number; // 默认 45_000
  idleMs: number;       // 默认 120_000，自【上一个事件】起算
  totalMs: number;      // 默认 600_000
  shutdownMs: number;   // 默认 3_000，kill 前宽限期
}

// ---------- 用量 ----------
export interface CliUsage {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

// ---------- 结果 ----------
export type FinishReason =
  | "stop" | "max-tokens" | "tool-calls" | "aborted" | "error";

export interface CliBridgeResult {
  /** 所有 text 事件按序拼接 */
  text: string;
  /** 首个事件携带的 sessionId；若全程未出现则为空串 */
  sessionId: string;
  /** 多 step 时按 §6.3 累加 */
  usage: CliUsage;
  finishReason: FinishReason;
  durationMs: number;
  /** CLI 进程退出码；未启动则为 null */
  exitCode: number | null;
  diagnostics: CliDiagnostic[];
}

// ---------- 诊断（不进正文，不抛错） ----------
export type CliDiagnostic =
  | { kind: "unknown-event"; raw: unknown }
  | { kind: "protocol-line"; line: string; reason: string }
  | { kind: "stderr"; chunk: string }
  | { kind: "state"; message: string };
```

### 5.2 入口函数

```ts
/** 事件流核心。按序产出 CliBridgeEvent，正常结束时流自然终止。 */
export function streamCliBridge(
  opts: CliBridgeOptions,
): AsyncIterable<CliBridgeEvent>;

/** 聚合封装：把事件流收成一个结果。 */
export function runCliBridge(
  opts: CliBridgeOptions,
): Promise<CliBridgeResult>;
```

### 5.3 契约不变量

| # | 不变量 |
|---|---|
| I1 | `streamCliBridge` **要么**以 `finish` 事件结束，**要么**以 `error` 事件结束，**要么**抛 `CliBridgeAbortError`。三者必居其一，**绝不悬挂** |
| I2 | `finish` 最多产出一次；`finish` 之后不再产出任何事件 |
| I3 | `error` 事件产出后流终止 |
| I4 | `runCliBridge` **永远 resolve**（含取消与超时），不 reject（除非调用方传入非法参数，如 `prompt` 为空） |
| I5 | 无论哪条退出路径，**进程都归零** |
| I6 | `sessionId` 是纯入参/出参，模块**不写任何持久化文件** |
| I7 | 未知事件类型 → `onDiagnostic` + 忽略，**绝不抛错** |
| I8 | 模块**不把 prompt / 消息正文写入日志或诊断** |

---

## 6. 事件契约与语义

### 6.1 事件定义

```ts
export type CliBridgeEvent =
  | { kind: "start";  sessionId: string; messageId?: string }
  | { kind: "text";   sessionId: string; messageId?: string; text: string }
  | { kind: "tool";   sessionId: string; messageId?: string; raw: unknown }
  | { kind: "finish"; sessionId: string; messageId?: string;
      reason: FinishReason; usage: CliUsage; cost: number;
      /** 结束但属于异常语义时携带（EMPTY_RESPONSE / TOOL_ONLY_RESPONSE / TIMEOUT / PROTOCOL_ERROR / SESSION_INVALID） */
      code?: ErrorCode }
  | { kind: "error";  code: ErrorCode; message: string; raw?: unknown };
```

### 6.2 OpenCode 事件 → CliBridgeEvent 映射

| OpenCode `type` | 产出 | 说明 |
|---|---|---|
| `step_start` | `start`（每 messageId 一次） | 取 `sessionID` / `part.messageID` |
| `text` | `text` | 取 `part.text`，按 `part.messageID` 分组 |
| `tool_use` | `tool` | **不产出正文**，`raw` 保留原文供诊断 |
| `tool_result` | `tool` | 同上 |
| `reasoning` / thinking | 无 | 忽略 + `unknown-event` 诊断 |
| `step_finish` | `finish` | 映射见 §7.2；usage 见 §6.3 |
| 其他 / 未知 | 无 | `unknown-event` 诊断 + **忽略** |

### 6.3 未知点的保守默认策略

以下是 [memory.md](../../memory.md) 3A.9 尚未实测的点。**在实测前一律按"保守默认"执行；实测结论回写后修订本表。**

| 未知点 | 保守默认（MVP 实现） | 可切换 | 实测后定 |
|---|---|---|---|
| 多个 `step_finish` 的 usage | **累加**（`usageMode: "sum"`） | ✅ `usageMode: "last"` | 累加 or 覆盖 |
| `text` 是否可能多段 | 支持多段，按 `messageID` 分组 | — | 分组维度 |
| 同一 `messageID` 多条 `text` | **按序拼接，不重复发** | — | — |
| `reasoning` | 忽略 + 诊断 | — | 要不要暴露 |
| 未知事件类型 | **诊断 + 忽略，绝不抛错** | — | 是否真的出现 |
| `step_finish` 的未知 `reason` | 映射为 `error`，原始值进诊断 | — | 完整取值表 |
| 只有 `tool_use` 没有 `text` | `finish` with `TOOL_ONLY_RESPONSE` | — | 真实结束形态 |
| 没有任何 `text` 且 `reason=stop` | `finish` with `EMPTY_RESPONSE` | — | — |
| `--session` 指向失效 session | 捕获 → `SESSION_INVALID`，**不重试** | — | 真实行为 |
| JSON 半行 / 截断 | `protocol-line` 诊断 + 跳过该行 | — | — |
| stdout 混入非 JSON | 同上，**不污染正文** | — | — |
| 单行超长（> 1 MiB） | 截断 + `protocol-line` 诊断 | ✅ `maxLineBytes` | — |

**总原则：未知不 crash；宁可漏报正文，绝不误报正文。**

---

## 7. 错误分类

### 7.1 ErrorCode

```ts
export type ErrorCode =
  | "CLI_NOT_FOUND"      // discover-cli 四级回退全失败
  | "CLI_START_FAILED"   // spawn 报错（含 EINVAL）
  | "WORKSPACE_INVALID"  // workspace 不存在 / 非目录 / 非绝对路径
  | "SESSION_INVALID"    // --session 指向失效 session
  | "PROMPT_FAILED"      // CLI 启动成功但拒绝处理 prompt
  | "TIMEOUT"            // 任一层超时
  | "CANCELLED"          // AbortSignal 触发
  | "PROTOCOL_ERROR"     // 无法解析 / 无 finish 即退出
  | "UPSTREAM_ERROR"     // 模型侧错误
  | "EMPTY_RESPONSE"     // 正常 finish 但无正文
  | "TOOL_ONLY_RESPONSE" // 只有 tool_use，无正文
  | "UNKNOWN";           // 保守兜底
```

`CliBridgeError` 携带 `code`、`message`、`cause?`；`message` **不得包含 prompt 正文、完整环境变量或用户 home 下的无关路径**（I8）。

### 7.2 finish reason 映射

| 来源 | `finish.reason` | `finish.code` |
|---|---|---|
| `step_finish.part.reason === "stop"` 且有正文 | `stop` | — |
| `reason === "stop"` 但全程无 `text` | `error` | `EMPTY_RESPONSE` |
| 只有 `tool_use`、无 `text` | `tool-calls` | `TOOL_ONLY_RESPONSE` |
| `reason` 表示长度截断（`length` / `max_tokens` / `max-tokens`） | `max-tokens` | — |
| `reason === "tool-calls"` / `tool_use` 结束 | `tool-calls` | — |
| 取消 | `aborted` | `CANCELLED` |
| 超时 | `error` | `TIMEOUT` |
| `--session` 失效 | `error` | `SESSION_INVALID` |
| 进程退出但无 `step_finish` | `error` | `PROTOCOL_ERROR` |
| **未知 `reason` 值** | **`error`** | `UNKNOWN`，原始值进 `diagnostics` |

**判定优先级（自上而下，先命中者胜）：**

```text
取消 > 超时 > session 失效 > 无 finish 即退出 > reason 映射 > 空正文
```

**未知值保守映射为 `error`，绝不 crash，原始字符串保留在诊断里。**

**语义边界：** `finish` = "本轮调用已结束"（即使内容为空）；`error` = "调用本身失败到无法给出结论"（如 CLI 起不来、协议全毁）。
`EMPTY_RESPONSE` / `TOOL_ONLY_RESPONSE` 属于前者，走 `finish` + `code`，不走 `error` 事件。

### 7.3 重试策略

```text
重试前提：尚未产出任何 text 事件
重试次数：每轮最多 1 次内部启动重试
```

| ErrorCode | 可重试 |
|---|---|
| `CLI_START_FAILED`（且无任何输出） | ✅ 1 次 |
| `TIMEOUT`（startup / firstEvent，且无任何输出） | ✅ 1 次 |
| `CANCELLED` | ❌ |
| `CLI_NOT_FOUND` | ❌ |
| `WORKSPACE_INVALID` | ❌ |
| `SESSION_INVALID` | ❌ |
| 任何已产出正文后的失败 | ❌ |

**原则：只要已经产出过正文，就绝不重试**（避免 DSH 侧出现重复内容）。

---

## 8. 取消 / 超时 / 进程清理

### 8.1 超时分层

| 层 | 默认 | 起算点 | 触发后 |
|---|---|---|---|
| `startup` | 30s | spawn 调用 | `TIMEOUT` |
| `firstEvent` | 45s | spawn 成功 | `TIMEOUT` |
| `idle` | 120s | **上一个事件** | `TIMEOUT` |
| `total` | 600s | spawn 调用 | `TIMEOUT` |
| `shutdown` | 3s | 发出 kill | 强制 `taskkill /T /F` |

依据 [CLI-BEHAVIOR.md](../../CLI-BEHAVIOR.md) §6：实测一轮真实问答 **21.4 秒**，故 `firstEvent` 取 45s 而非 30s。
**`idle` 必须自"上一个事件"起算**，否则长回答会被误杀。

### 8.2 `settle()` 单出口（防竞争）

取消、超时、正常结束、异常 —— **四条路径收敛到同一个 `settle()`**：

```text
settle(outcome)
  ├─ 若 settled === true → 立即返回（幂等）
  ├─ settled = true
  ├─ 清理全部 timer（startup/firstEvent/idle/total/shutdown）
  ├─ 移除 AbortSignal listener
  ├─ 触发进程清理（见 8.3）
  ├─ 产出终止事件（finish 或 error）或抛 CliBridgeAbortError
  └─ 关闭 stdout/stderr 句柄
```

**不使用两套清理路径互调**，这是防竞争最简单可靠的做法。

### 8.3 进程清理序列

```text
1. child.kill()                       ← 杀直接子进程
2. 等 shutdown timeout (3s) 内的 exit/close
3. 仍未退出 → taskkill /PID <pid> /T /F    ← 按 PID 杀子树（必需，非兜底）
4. 再等 close
5. 清理 timer / listener / 句柄
```

依据：

- `child.kill()` **只杀直接子进程**（CLI-BEHAVIOR §5.3）
- `opencode.exe` **会派生 `git` 子进程**，`/T` 必需（§5.2）
- **禁止 `/IM`**（§2，会误杀 OpenCode Desktop）

### 8.4 AbortSignal 生命周期

```text
signal.aborted === true（进入时已中止）
  → 直接 settle(CANCELLED)，不 spawn

signal.addEventListener("abort", onAbort, { once: true })
  → settle() 内必须 removeEventListener
```

**`removeEventListener` 必须执行**，否则同一个 signal 挂多个请求会泄漏并触发 `MaxListenersExceededWarning`。

---

## 9. CLI 发现（`discover-cli.ts`）

```text
1. opts.command（显式绝对路径）        ← 最高优先，尊重用户配置
2. PATH 上的 opencode
     命中 .cmd/.ps1/sh shim → 解析出真身 <shimDir>/node_modules/opencode-ai/bin/opencode.exe
     命中 .exe             → 直接用
3. npm 全局 node_modules/opencode-ai/bin/opencode.exe
4. 全失败 → 抛 CLI_NOT_FOUND
          message 含安装提示 "npm i -g opencode-ai"
```

**命中 `.cmd` ≠ 用 `.cmd`**（硬约束 C4）。发现结果只缓存在内存，不落盘。

**入参校验（在 spawn 之前，快速失败）：**

```text
workspace 不存在 / 非目录        → WORKSPACE_INVALID
workspace 非绝对路径             → WORKSPACE_INVALID
model 为空或不含 "/"             → 抛参数错误（编程错误，I4 的例外）
prompt 为空串                    → 抛参数错误（编程错误，I4 的例外）
```

---

## 10. 测试计划

### 10.1 分层

| 层 | 手段 | 速度 | 覆盖 |
|---|---|---|---|
| 纯函数单测 | 直接 import `lib/` 的纯模块 | 毫秒 | 解析、映射、分类、聚合 |
| 进程单测 | **fake CLI**（可执行 node 脚本）走同一条 spawn 路径 | 百毫秒 | 全部异常路径 |
| 集成测试 | 真实 `opencode` | ~21s/条 | 行为漂移 + 3A.9 未知点 |

### 10.2 fake CLI 设计

`test/fixtures/fake-opencode.mjs` —— **可执行 node 脚本**，用环境变量 `FAKE_MODE` 切换行为，走的是**和真实 CLI 一模一样的 spawn 路径**（`opts.command = process.execPath`，`extraArgs = ["test/fixtures/fake-opencode.mjs"]`）。

```text
FAKE_MODE=normal          step_start / text / step_finish
FAKE_MODE=multiline       一条 text 分 3 段
FAKE_MODE=multi-step      两个 step，两组 usage
FAKE_MODE=tool-only       只有 tool_use，无 text
FAKE_MODE=empty           step_start / step_finish，无 text
FAKE_MODE=partial-line    最后一行 JSON 被截断
FAKE_MODE=non-json        stdout 混入非 JSON 行
FAKE_MODE=stderr-noise    stderr 输出噪声（正文正常）
FAKE_MODE=exit-nonzero    输出部分事件后 exit 1
FAKE_MODE=no-finish       有 text 但无 step_finish 就退出
FAKE_MODE=hang            永不退出（测 total / shutdown）
FAKE_MODE=slow            每 2s 一个事件（测 idle）
FAKE_MODE=startup-fail    立即 exit 127（测 startup）
FAKE_MODE=oversize-line   输出 2 MiB 单行（测 maxLineBytes）
FAKE_MODE=unknown-events  输出未知 type（测 I7）
FAKE_MODE=session-echo    回显收到的 --session（测续接透传）
```

### 10.3 进程级单测矩阵

| # | 用例 | 期望 |
|---|---|---|
| T01 | `normal` | 事件序列 `start → text → finish(stop)`；`exitCode=0`；正文正确 |
| T02 | `multiline` | 3 段 text 按序产出；聚合后等于原文；不重复 |
| T03 | `multi-step` | 2 个 `start`；`messageID` 分组正确；usage **累加** |
| T04 | `tool-only` | `tool` 事件产出但**无正文**；`finish(TOOL_ONLY_RESPONSE)` |
| T05 | `empty` | `finish(reason="error", code="EMPTY_RESPONSE")`；**不是** `error` 事件 |
| T06 | `partial-line` | 半行被 `protocol-line` 诊断捕获；**不影响前文**；仍正常 finish |
| T07 | `non-json` | 污染行诊断 + 忽略；正文干净；正常 finish |
| T08 | `stderr-noise` | stderr 全部进 `diagnostics`；**正文不受污染** |
| T09 | `exit-nonzero` | 有 `step_finish` → 按 finish 处理、退出码记入 `diagnostics`；无 `step_finish` → `error(PROTOCOL_ERROR)` |
| T10 | `no-finish` | `error(PROTOCOL_ERROR)` |
| T11 | `hang` | `total` 超时 → `error(TIMEOUT)`；**进程归零** |
| T12 | `slow` + 短 idle | `idle` 超时 → `error(TIMEOUT)` |
| T13 | `startup-fail` | 重试 1 次后 `error(CLI_START_FAILED)`；spawn 调用共 2 次 |
| T14 | `startup-fail` + 已产出 | **不重试**（§7.3） |
| T15 | `oversize-line` | 截断 + 诊断；不 OOM；正常收尾 |
| T16 | `unknown-events` | 全部进 `unknown-event` 诊断；**不抛错**（I7） |
| T17 | `session-echo` + `sessionId` | 透传正确 |
| T18 | 无 `sessionId` | 返回的 `sessionId` 由事件决定 |
| T19 | `signal.abort()` 中途取消 | `runCliBridge` 返回 `finishReason="aborted"`；**进程归零** |
| T20 | 进入时 `signal.aborted` | **不 spawn**；`aborted` |
| T21 | `command` 指向不存在的路径 | `error(CLI_NOT_FOUND)` |
| T22 | `workspace` 不存在 | `error(WORKSPACE_INVALID)`；**不 spawn** |
| T23 | `model` 不含 `/` | 抛参数错误（I4 例外） |
| T24 | 连续 20 轮 | **每次进程归零**（PID 基线比对） |
| T25 | 取消 + 超时几乎同时触发 | 只 settle 一次；无 unhandled rejection |
| T26 | 同一 `signal` 挂 3 个请求 | 无 listener 泄漏；无 `MaxListeners` 警告 |
| T27 | `finish` 之后仍有 stdout | 忽略；不产出事件（I2） |

### 10.4 纯函数单测

| 模块 | 覆盖 |
|---|---|
| `parse-lines` | 正常 / 半行 / 空行 / CRLF / 超长截断 / 非 JSON / 空输入 / 只有换行 |
| `map-events` | 6.2 全表；6.3 全表；usage 累加与覆盖两种模式；finish 映射全表含**未知 reason** |
| `errors` | 12 类 `ErrorCode` 判定；`toFinishReason` 全映射；重试判定全表 |
| 聚合 | `runCliBridge` 的 `text` 拼接、`diagnostics` 收集、`durationMs` |

### 10.5 集成测试（真实 CLI）

`npm run test:integration` 单独跑，**默认 `test` 不含它**（依赖网络与免费额度，每条约 21s）。

每条集成测试**必须产出一条结论**回写 [memory.md](../../memory.md) 3A.9：

| # | 用例 | 产出结论 |
|---|---|---|
| R01 | 正常一轮 | 事件序列 / 耗时基线 |
| R02 | 传 `--session` 续接 | 续接是否跨进程成立 |
| R03 | `--session` 指向不存在的 ID | 行为 → 定 `SESSION_INVALID` 判定 |
| R04 | 同一 session 换 model | 是否允许 |
| R05 | `--dir` 相对路径 | 是否要求绝对路径 |
| R06 | `--dir` 不存在 | 行为 → 定 `WORKSPACE_INVALID` 判定 |
| R07 | 触发 `tool_use` 的 prompt | `tool_use` 完整结构 |
| R08 | 长回答 | 是否有多条 `text` / 多个 `step_finish`，usage 累加 or 覆盖 |
| R09 | 取消后查 session | 中断内容是否已持久化 |
| R10 | 失败路径抓 stderr | 非 JSON stderr 形态 |
| R11 | **连续 20 轮进程归零** | PID 基线比对，**禁止 `taskkill /IM`** |
| R12 | 直接 spawn exe 后 `child.kill()` | 复验 CLI-BEHAVIOR §5.4 |

### 10.6 测试环境注意事项

已知踩过的坑（[CLI-BEHAVIOR.md](../../CLI-BEHAVIOR.md) §7）：

1. **DSH 沙箱会禁 `child_process` 管道捕获** → `EPERM: uv_spawn 'git'`。集成测试需在沙箱外跑，或把 stdio 改为 `'ignore'` / `'inherit'` / 文件描述符
2. **沙箱会挡 CLI 写 `~/.local/share/opencode/log/`**
3. **进程枚举必须用 `tasklist` / `taskkill`**，`Get-CimInstance Win32_Process` 在受限令牌下 `拒绝访问 (0x80041003)`
4. **清理只按 PID**，禁止 `taskkill /IM`

---

## 11. 工程细节

| 项 | 决定 |
|---|---|
| 语言 / 目标 | TypeScript / ES2022 / `NodeNext` / `strict` |
| 编译 | `tsc -p tsconfig.json` → `lib/`（`rootDir: src`） |
| 测试运行器 | **`node:test`**（`package.json` 已有 `"test": "node --test"`），**不引入 jest / vitest** |
| 测试文件语言 | **`.mjs` 直接 import 编译产物 `lib/`** —— 避开 NodeNext 下 TS 测试的扩展名冲突 |
| `npm test` | `tsc -p tsconfig.json && node --test`（顺带保证 `lib/` 本身可跑） |
| `npm run test:integration` | `tsc && node --test test/integration/` |
| 新增依赖 | **零**（不引入任何 runtime / dev 依赖） |
| 产物 | `lib/index.js` + `lib/index.d.ts` |

---

## 12. 交付物与验收标准（DoD）

### 12.1 交付物

1. `src/` 全部 8 个模块
2. `test/` 单测 + `test/fixtures/fake-opencode.mjs`
3. `test/integration/` 真实 CLI 测试
4. `npm run typecheck` 通过（`strict`）
5. `npm test` 全绿，输出无 warning
6. [memory.md](../../memory.md) 3A.9 那 12 项未知点的**实测结论**
7. [todo.md](../../todo.md) 勾掉 TODO-08 / 09 / 11 / 12 / 13 / 14 / 18 / 19 / 20 / 21，补记结论

### 12.2 验收标准

| # | 标准 | 验证方式 |
|---|---|---|
| A1 | 纯层不 import 任何 Node API | grep `from "node:` 在纯层 4 个文件中无匹配 |
| A2 | 全部 T01–T27 通过 | `npm test` |
| A3 | 连续 20 轮进程归零 | T24 + R11 |
| A4 | 取消后无残留、无 unhandled rejection | T19 / T25 |
| A5 | 未知事件永不 crash | T16 |
| A6 | 协议污染不污染正文 | T06 / T07 / T08 |
| A7 | 已产出正文后绝不重试 | T14 |
| A8 | `finish` 至多一次、流必终止 | I1 / I2 + T27 |
| A9 | 模块不写任何持久化文件 | 代码审查 + 测试期间文件系统快照 |
| A10 | 模块不记录 prompt 正文 | 代码审查 + `diagnostics` 内容断言 |
| A11 | `strict` 无错误 | `npm run typecheck` |
| A12 | 零新增依赖 | `package.json` diff |

---

## 13. 风险与未决项

| 风险 | 缓解 |
|---|---|
| §6.3 的保守默认与真实行为不符 | 每条都标了"实测后定"；集成测试 R03–R08 会答；改实现不改契约 |
| `opencode.exe` 未来派生更多子进程 | `/T` 已是必需项；T24 按 PID 基线验证 |
| 免费额度 / 网络导致集成测试不稳定 | 集成测试独立于 `npm test`；R01/R02 失败不阻止单测结论 |
| Bun 二进制内部行为变更 | CLI-BEHAVIOR 文档记录了版本 1.19.0；升级时跑 R01–R12 复验 |
| `--format json` 输出格式漂移 | `parse-lines` + `map-events` 是纯层，改动局部化；T16 保证未知事件不 crash |

**本 spec 无 TBD / 未决占位。** 所有"待实测"项都已给出**保守默认值**，实现可直接照做；实测结论只影响默认值表，不影响对外契约。

---

## 14. 后续子项目（本 spec 不覆盖）

- **子项目 2 · StreamChunk 转换器**：`CliBridgeEvent` → DSH `block-start` / `text-delta` / `block-end` / `usage` / `finish`。切块模拟流式在这里做，不在 CliBridge 里做
- **子项目 3 · `LlmAdapter` 接入**：`registerAdapter`、`listModels`、`stream`，需先挖清 DSH 合同（TODO-01~03）
- **子项目 4 · session 持久化**：`DSH chat ID → {workspace, sessionId}` 映射、状态机、原子写
- **子项目 5 · 模型目录**：`opencode models` → HTTP → cache → static 四级回退
