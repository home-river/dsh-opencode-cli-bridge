# dsh-opencode-bridge 开发要点记录

> 记录时间：2026-10-15  
> 当前状态：CLI 无头调用与 CLI → 插件输入格式已验证；纯 HTTP 免费推理被上游阻断；尚未开始正式 Adapter 实现。  
> **2026-10-15 补充：** OpenCode CLI 的 spawn / 参数保真 / 进程树行为已实测，见 [docs/CLI-BEHAVIOR.md](./docs/CLI-BEHAVIOR.md)。该实测**修正了本文 3A 节的 4 处结论**（已在原处标注），实现时以 CLI-BEHAVIOR.md 为准。
> **2026-10-16 第三轮：** CliBridge 模块（OC → 插件段）已实现并通过单测 103 条；真实 CLI 集成测试 R01–R08、R11 全部通过（8/8）。详见 3A.9。

---

## 1. 项目目标

做一个新的 DSH 插件，借鉴 `@opencode2dsh/dsh-plugin` 的机制，把 OpenCode 的免费模型接入 DSH。

当前 MVP 的关键变化：

- 不再假设 DSH 可以直接伪装成 OpenCode CLI 调用免费模型；
- 改为通过**真实 OpenCode CLI / 本地客户端身份**访问免费模型；
- 每个 DSH 聊天对应独立的 OpenCode 会话与工作区；
- 每轮回答结束后先关闭 CLI 进程，常驻模式后续再考虑。

---

## 2. 已验证的关键事实

### 2.1 纯 HTTP 直连免费推理被阻断

目录接口：

```text
GET https://opencode.ai/zen/v1/models
```

结果：

```text
HTTP 200
```

真正的推理接口：

```text
POST https://opencode.ai/zen/v1/chat/completions
```

即使带上基础 CLI 形态请求头，结果仍然是：

```text
HTTP 403
type: FreeTierError
message: OpenCode's free tier can only be used from within OpenCode...
```

结论：

```text
模型目录可匿名读取
免费推理不能只靠 HTTP 请求头伪装调用
```

这解释了参考插件当前不可用的原因。

---

### 2.2 本机 OpenCode CLI 版本与位置

已安装版本：

```text
1.19.0
```

命令位置：

```text
C:\Users\86181\AppData\Roaming\npm\opencode.cmd
```

底层可执行文件：

```text
C:\Users\86181\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe
```

---

### 2.3 OpenCode CLI 支持无头模式

顶层命令中存在：

```text
opencode run [message..]
opencode serve
```

对 MVP 最关键的是 `run`：

```text
--dir <workspace>
--model <provider/model>
--format json
--session <session-id>
```

其中：

- `--dir` 指定当前聊天对应的工作区；
- `--format json` 输出机器可读 JSON 事件；
- `--session` 用于续接同一个 OpenCode 会话；
- 默认非交互执行，回答结束后进程自动退出。

`opencode serve` 也存在，可作为后续本机 HTTP 服务方案，但 MVP 暂不优先。

---

## 3. 已完成的无头调用实验

### 3.1 第一次实验：验证基础 JSON 事件

命令：

```text
opencode run --dir <workspace> --model opencode/mimo-v2.6-flash-free --format json "请只返回 OPENCODE_HEADLESS_OK"
```

结果：

```text
EXIT=0
耗时约 10.8 秒
```

输出结构：

```text
step_start
text
step_finish
```

关键正文事件：

```json
{
  "type": "text",
  "part": {
    "type": "text",
    "text": "OPENCODE_HEADLESS_OK"
  }
}
```

关键结束事件：

```json
{
  "type": "step_finish",
  "part": {
    "reason": "stop",
    "tokens": {
      "input": 9445,
      "output": 7,
      "reasoning": 16,
      "cache": {
        "read": 64,
        "write": 0
      }
    },
    "cost": 0
  }
}
```

结论：

- CLI 不进入交互界面；
- `--dir` 生效；
- 免费模型可以调用；
- `--format json` 输出可解析；
- 进程回答结束后自动退出；
- usage 和 finish 信息可提取。

---

### 3.2 第二次实验：验证会话续接

第一轮：

```text
请只记住这个秘密数字：7391。不要解释，只回复已记住。
```

得到：

```text
sessionID: ses_...
text: 已记住
```

第二轮使用同一 session：

```text
opencode run --dir <workspace> --model ... --format json --session <sessionID> "我刚才让你记住的数字是多少？只返回数字。"
```

结果：

```text
EXIT=0
text: 7391
```

结论：

```text
OC 聊天内容可以续接。
续接不依赖 CLI 进程常驻。
上下文保存在 OpenCode session 中，而不是进程内存中。
```

因此即使每轮都关闭 CLI，只要下一轮用同一个 `sessionID`，上下文仍然存在。

---

### 3.3 第三次实验：重新稳定抓取聊天正文

测试 prompt：

```text
请只返回 FETCH_TEST_OK
```

结果：

```text
EXIT=0
```

完整 JSON Lines 输出：

```json
{"type":"step_start","sessionID":"ses_...","part":{"type":"step-start", ...}}

{"type":"text","sessionID":"ses_...","part":{"type":"text","text":"FETCH_TEST_OK", ...}}

{"type":"step_finish","sessionID":"ses_...","part":{"reason":"stop","tokens":{...},"cost":0}}
```

聊天正文的提取方式：

```js
const event = JSON.parse(rawLine)

if (event.type === "text") {
  const content = event.part.text
}
```

结论：

```text
OC CLI 的聊天内容可以通过 opencode run --format json 稳定取出来。
正文位于 text 事件的 part.text。
```

---

## 3A. CLI → 插件段排查结论

### 3A.1 排查范围

本轮只排查：

```text
OpenCode CLI 进程
  → stdout/stderr
  → JSON Lines 事件
  → 插件内部事件解析器
```

本轮不接入 DSH，也不实现正式插件代码。

### 3A.2 实际启动方式

使用 Windows npm wrapper：

```text
C:\Users\86181\AppData\Roaming\npm\opencode.cmd
```

参数数组：

```text
run
--dir F:\project\DSH\plugin-dev\fixtures\opencode-headless-spike
--model opencode/mimo-v2.6-flash-free
--format json
<prompt>
```

执行结果：

```text
EXITED=true
EXIT_CODE=0
ELAPSED_MS=11305
```

结论：

- ~~`opencode.cmd` 可作为插件探测到的默认命令~~  
  **【2026-10-15 修正】** `.cmd` **只能作为发现线索**，执行入口必须用真身 `opencode.exe`。理由：Node 24 上 `spawn(opencode.cmd, args)` 无 shell 直接抛 `EINVAL`；带 `shell: true` 则参数被 `%*` 改写、可被命令注入，且取消时留下孤儿 `opencode.exe`。详见 [docs/CLI-BEHAVIOR.md](./docs/CLI-BEHAVIOR.md) §3–§5。
- 参数数组可正常传递 `--dir`、`--model`、`--format`；
- CLI 不进入交互界面；
- 回答结束后自行退出；
- ~~正常路径耗时约 11 秒，超时不能设置得过短。~~  
  **【2026-10-15 修正】** 本次实测一轮真实问答 **21.4 秒**（`ELAPSED_MS=21352`），原 11 秒偏低。超时默认值按 21s+ 留量：`startup 30s / firstEvent 45s / idle 120s / total 10min / shutdown 3s`。

### 3A.3 stdout / stderr 分流

本次将 stdout 和 stderr 分别重定向到文件：

```text
stdout.log
stderr.log
```

结果：

```text
STDOUT_LINES=3
STDERR_BYTES=0
```

stdout 是严格的 JSON Lines：

```text
一行 = 一个 JSON 对象
事件之间以换行分隔
```

stderr 在正常路径为空。

插件解析规则：

```text
stdout → 按换行切分 → JSON.parse → OpenCode event
stderr → 独立收集 → 仅用于诊断，不直接作为 DSH 正文
```

不能简单地把 stdout/stderr 合并后按普通文本解析，否则非 JSON 日志会破坏事件流。

### 3A.4 正常路径事件序列

本轮稳定观察到：

```text
step_start
text
step_finish
```

对应字段：

```text
step_start:
  type
  timestamp
  sessionID
  part.type = step-start
  part.id
  part.messageID
  part.snapshot

text:
  type
  timestamp
  sessionID
  part.type = text
  part.id
  part.messageID
  part.text
  part.time.start
  part.time.end

step_finish:
  type
  timestamp
  sessionID
  part.type = step-finish
  part.id
  part.messageID
  part.reason
  part.snapshot
  part.tokens.total
  part.tokens.input
  part.tokens.output
  part.tokens.reasoning
  part.tokens.cache.read
  part.tokens.cache.write
  part.cost
```

本轮实际正文：

```text
CLI_PLUGIN_LINK_OK
```

### 3A.5 插件内部应保存的最小事件模型

插件不应直接把原始 JSON 行透传给 DSH，而应先归一化：

```ts
type CliBridgeEvent =
  | { kind: "start"; sessionId: string; messageId?: string }
  | { kind: "text"; sessionId: string; messageId?: string; text: string }
  | {
      kind: "finish";
      sessionId: string;
      messageId?: string;
      reason: string;
      usage: {
        total: number;
        input: number;
        output: number;
        reasoning: number;
        cacheRead: number;
        cacheWrite: number;
      };
      cost: number;
    }
  | { kind: "tool"; sessionId: string; messageId?: string; raw: unknown }
  | { kind: "error"; message: string; raw?: unknown };
```

MVP 中 `tool` 只记录或过滤，不直接转发给 DSH。

### 3A.6 session 的创建与续接

本轮确认：

- 第一轮不传 `--session` 时，CLI 会创建 session；
- 首个 `step_start` 已包含 `sessionID`；
- 第二轮传入该 `sessionID` 后可以续聊；
- 两轮都是独立 CLI 进程，均正常退出。

本轮续接测试：

```text
第一轮：请只返回 CLI_PLUGIN_REUSE_OK
第二轮：我上一条要求返回的固定字符串是什么？
结果：CLI_PLUGIN_REUSE_OK
```

事件序列两轮均为：

```text
step_start
text
step_finish
```

因此插件可以在收到首个 `step_start` 时立即保存：

```text
DSH chat → OpenCode sessionID
```

下一轮：

```text
opencode run ... --session <sessionID>
```

不需要为了续聊而保持 CLI 进程常驻。

### 3A.7 进程退出与残留

正常路径验证：

```text
OpenCode PIDs before = 空
OpenCode PIDs after  = 空
```

本次没有残留 `opencode` 进程。

**【2026-10-15 补充】** 上面只覆盖了**正常路径**。实测发现取消路径的结论不同：

- 走 `opencode.cmd`（`shell:true`）时 `child.kill()` 只杀 `cmd.exe`，**真身 `opencode.exe` 变孤儿继续运行**；
- 直接 spawn `opencode.exe` 时 `child.kill()` 干净，2.5 秒内归零；
- `opencode.exe` 自身单进程，但会派生 `git` 子进程（实测一次 8 个），因此**杀进程必须用 `taskkill /PID <pid> /T /F`**；
- 进程归零验证**必须按 PID 基线**做，不能全机 grep `opencode`（会误伤 OpenCode Desktop 常驻进程）。

详见 [docs/CLI-BEHAVIOR.md](./docs/CLI-BEHAVIOR.md) §5。

另外观察到一个预先存在的：

```text
opencode-cli.exe serve
```

但它属于 OpenCode Desktop 的既有进程，不是本次 `opencode run` 启动的子进程。插件进程统计时必须按本次 spawn 的 PID/命令行隔离，不能把机器上其他 OpenCode 服务误判为残留。

### 3A.8 目前可确定的 CLI → 插件契约

```text
输入：
  workspace
  model
  prompt
  sessionId?

启动：
  spawn(opencodeExe, argsArray, { cwd: workspace })   // opencodeExe = 真身 .exe，不是 .cmd
  【2026-10-15 修正】原记录为 spawn(opencode.cmd, argsArray, { cwd: workspace })
  —— 该写法在 Node 24 上直接抛 EINVAL，不可用。禁止 shell:true，参数一律走 argv 数组。

输出：
  stdout JSON Lines
  stderr 独立日志

事件：
  step_start → start
  text        → text
  step_finish → finish + usage
  tool_use    → tool（MVP 过滤）
  未知事件     → protocol log / ignore

退出：
  正常 finish 后等待进程 exit
  exit code 0 → 成功
  无 finish 提前退出 → protocol error
```

### 3A.9 仍需排查的 CLI → 插件问题

> **2026-10-15 第二轮实测已回答 7 项**，结论见 [docs/CLI-BEHAVIOR.md](./docs/CLI-BEHAVIOR.md) §12。

**已回答：**

- [x] `tool_use` 多步事件的完整结构 → `part.type="tool"`，含 `tool` / `callID` / `state.{status,input,output}`。⚠️ 注意 `part.type` 与事件 `type` 命名不一致
- [x] 是否存在 reasoning、retry、error 等其他 stdout 事件 → **未见 `reasoning` / `retry` / `error`**；只有 `step_start` / `text` / `tool_use` / `step_finish`
- [x] 非 JSON stderr 在失败路径如何出现 → **带 ANSI 颜色码的人类可读文本**（如 `Error: Session not found`），必须剥色；**错误走 stderr 而非 stdout JSON**
- [x] `--session` 指向不存在 session 时的行为 → **exit 1 + stderr 报错，不会自动创建**
- [x] Windows 下取消 `opencode.cmd` 是否会留下子进程 → **会留孤儿 `opencode.exe`**；直接 spawn 真身 exe 则干净
- [x] 一个 DSH 请求中多个 `step_finish` 时 usage 是覆盖还是累加 → **每个 step 报增量，必须累加**（验算 `total = input+output+reasoning+cache.read` 成立）
- [x] CLI 启动阶段和首事件阶段的超时默认值 → `startup 30s / firstEvent 45s / idle 300s / total 600s / shutdown 3s`（⚠️ `idle` 不能用 120s：实测单次生成静默 46.5s）

**2026-10-16 第三轮补充观测：**

- **免费推理故障窗口**（当日上午约 1 小时，随后自动恢复）：`mimo-v2.6-flash-free` 报 stdout `type:"error"` → `UnknownError: Unexpected server error`；`deepseek-v4-flash-free` 报 400 `Model is unavailable`；`north-mini-code-free` / `ling-3.0-flash-free` / `laguna-s-2.1-free` 同报 UnknownError；`nemotron-3-ultra-free` 静默约 5 分钟后返回空响应。故障期间集成 R01/R02/R07/R08 失败，恢复后 8/8 通过。
- **模型目录漂移**：`opencode/mimo-v2.5-free` 报 410 `ModelDeprecated`（提示改用 `mimo-v2.6-flash-free`），但 `opencode models` 仍列出 `mimo-v2.5-free` 且不含 v2.6 —— **目录与真实可用性不一致，不能只信 `opencode models`**（影响 TODO-06/07 的目录策略）。
- **集成 R03 断言修正**：计划原文 `assert.rejects` 与 spec I4 / Ruling F14 冲突 —— `runCliBridge` 对执行期失败 resolve（`finishReason="error"` + `errorCode`），仅建立期错误 reject。断言已按 spec 改正。
- **集成 R11 断言修正**：全机 PID 基线会误报无关进程（与 9b44c6e 修正单测同因），收窄为 CLI 进程树映像名（`opencode*.exe` / `git.exe`）+ 宽限复检。

- [x] **第三轮新答** stdout 是否存在 `error` 事件 → **存在**（修正上文"未见 `error` 事件"）：`{"type":"error","sessionID":...,"error":{"name":"UnknownError"|"APIError","data":{"message","statusCode?","isRetryable?","responseHeaders?","responseBody?","metadata?"}}}`，随后 exit 1。当前实现按未知事件处理（诊断+忽略），错误码由 classifyFailure 兜底 `PROTOCOL_ERROR`；**改进项：显式映射 `UPSTREAM_ERROR`（子项目 3 前处理）**
- [x] **第三轮新答** `step_finish.reason` 全集补充 → 实测见 `"unknown"`（nemotron 空响应，tokens 全零、无正文、exit 0），保守映射 `error+UNKNOWN` 生效
- [x] **第三轮新答** session 校验与模型推理的先后 → `--session` 失效**优先于**推理报错（stderr `Session not found` + exit 1），推理故障不影响 `SESSION_INVALID` 分类
- [x] **第三轮新答** 空正文真实形态（部分）→ 实测为 `reason="unknown"` + 全零 tokens + exit 0；`reason="stop"` 空正文变体仍未复现，实现按 `EMPTY_RESPONSE` 保守处理
- [x] **第三轮新答** JSON 半行 / 超长行 / 进程提前关闭的处理 → 实现定义 + fake CLI 单测覆盖（`protocol-line` 诊断、超长行截断不 OOM、无 finish 提前退出 → `PROTOCOL_ERROR` 兜底）
- [x] **第三轮集成回归** R01–R08、R11 全部通过（8/8）：R01 正常往返 5–7s、事件序列 `step_start → text → step_finish`；R02 跨进程续接成立；R03 无效 session → resolve(`SESSION_INVALID`)；R05/R06 → `WORKSPACE_INVALID`；R07 tool 事件不污染正文；R08 整段 text + usage 累加非零；R11 连续 5 轮进程归零

**仍未回答：**

- [ ] 中途 kill 后 session 是否已经持久化（R09，留待子项目 3/4）；
- [ ] `--session` 与 `--model` 换模型时是否允许（R04）；
- [ ] `--session` 与 `--dir` 不一致时的行为；
- [ ] 没有 `text`、只有 `tool_use` 时如何结束（设计按 `TOOL_ONLY_RESPONSE`，真实 CLI 纯 tool 场景未复现）。

### 3A.10 对下一阶段的直接影响

下一阶段应先实现独立的 `CliBridge`，接口建议为：

```ts
runCliBridge({
  workspace: string;
  model: string;
  prompt: string;
  sessionId?: string;
  signal?: AbortSignal;
}) => Promise<{
  text: string;
  sessionId: string;
  usage: CliUsage;
  finishReason: string;
  durationMs: number;
}>;
```

它先不依赖 DSH，只负责：

```text
spawn CLI
→ 独立读取 stdout/stderr
→ 解析 JSON Lines
→ 聚合 text
→ 提取 usage/finish
→ 超时、取消、退出、清理
```

通过这个原型后，再接 DSH `StreamChunk` 转换器。

---

## 4. 对 DSH 内容同步的设计结论

### 4.1 事件映射建议

OpenCode JSON 事件到 DSH 事件的初步映射：

| OpenCode 事件 | DSH 处理 |
|---|---|
| `step_start` | 忽略，或作为本轮开始信号 |
| `text` | 作为正文，转成 `text-delta` 或最终 `block-end` |
| `step_finish` | 提取 tokens/cost，转成 `usage` + `finish` |
| `tool_use` | MVP 内部消化，不转发给 DSH |
| `retry` / 错误事件 | 分类后转成 DSH 错误 finish |

### 4.2 当前观测到的文本粒度

目前 `text` 事件倾向于一次性给出整段正文，而不是逐 token 的 `text_delta`。

因此 DSH 若要有流式体验，有两条路：

#### 方案 A：将整段 text 切块模拟流

```text
"FETCH_TEST_OK"
  → text-delta "FETCH_"
  → text-delta "TEST_"
  → text-delta "OK"
```

实现简单，体验上像流式。

#### 方案 B：聚合后一次性返回

```text
收到完整 text → 一次 block-start → 一次 block-end → finish
```

实现最简单，但 DSH 看起来不是打字机效果。

MVP 初步建议先采用方案 A，因为对 DSH 的兼容风险更低；若后续确认 CLI 真有更细粒度 delta 事件，再切换为原生 delta。

---

## 5. 会话、工作区与进程生命周期

### 5.1 当前推荐模型

```text
DSH chat/session
  ↕ 1:1
OpenCode sessionID
  ↕ 1:1
工作区 workspace
  ↕
OpenCode CLI process（每轮启动，结束即关闭）
```

要点：

- 每个 DSH 聊天使用独立的 workspace；
- 每个 DSH 聊天使用独立的 OpenCode session；
- CLI 每轮启动，回答完成或失败后关闭；
- 同一 DSH 聊天下一轮继续使用同一个 sessionID；
- 不同 DSH 聊天绝不共享 session 或 CLI 进程。

### 5.2 为什么不用常驻进程

MVP 阶段先关闭进程的好处：

- 工作区隔离清晰；
- 不需要进程池；
- 崩溃只影响当前请求；
- 取消和清理更简单；
- 不容易串聊天上下文。

代价：

- 每轮有 CLI 启动开销；
- 需要重新读取/恢复 session；
- 高频请求会有延迟。

后续如果延迟明显，再补常驻进程或 `opencode serve` 模式。

---

## 6. 待解决的问题

1. 确认 `text` 事件是否能通过某个参数变成更细粒度的 delta；
2. 确认 DSH 会话上下文里如何稳定取得当前 workspace；
3. 确认 `--session` 是否需要显式创建，还是可由 CLI 自动创建；
4. 设计 CLI 进程取消与 Windows 进程树清理；
5. 设计 `step_finish` tokens 到 DSH usage 的字段映射；
6. 设计 `tool_use` 的过滤或内部消化策略；
7. 设计 CLI 启动超时、请求超时与静默超时；
8. 设计每轮 session 的删除或保留策略；
9. 设计模型目录获取方式：HTTP `/models`、`opencode models` 或缓存；
10. 完成 DSH `LlmAdapter` 合同接入；
11. `opencode/*` 与 `opencode-go/*` 的区别仍未查明（当前只按前缀默认隐藏 `opencode-go/*`，见 `src/model-filter.ts`）；
12. 运行环境对 `~/.local/share/opencode` 不可写时 `opencode run` 启动即失败，插件侧自动重定向 HOME 待落地（`issues/ISSUE-001-opencode-log-dir-not-writable.md`）；
13. 思考强度透传：~~待有 provider 实测响应后再接~~ **（2026-10-18 修订，ISSUE-003）** 已接 `reasoningEffort` → `opencode run --variant` 透传并声明 `reasoning.efforts`（off/minimal/low/medium/high/max，不设 defaultEffort）——修订原因：DSH 0.2.1 对「未声明 reasoning 的模型 + 携带 effort 的请求」在 I/O 前抛 `UNSUPPORTED_REASONING_EFFORT`，不声明的代价从「无」变成「路由硬失败」，且 waterfall 抹除拦不住 prepareCall/resolveCallConfig 主路径。诚实边界保留：`--variant` 对 mimo 免费模型实测不响应，档位语义是「接受并转发」而非「保证生效」；`--thinking` → DSH `reasoning-delta` 仍是更优先的后续候选。

---

## 7. 当前非目标

以下内容暂不进入第一版：

- IP 池；
- 订阅；
- Go sidecar；
- 完整 CLI 流量伪装；
- 图片输入；
- 工具调用转发；
- reasoning 展示；
- 插件完整设置页；
- 常驻 CLI 进程池；
- 自动安装到 DSH profile；
- npm 正式发布；
- 绕过 OpenCode 地区、限流或客户端限制。

---

## 8. 参考文件

- [GOALS.md](./docs/GOALS.md)：项目目的、范围、验收标准与实现阶段；
- [README.md](./README.md)：工程当前状态；
- 参考插件：`@opencode2dsh/dsh-plugin`；
- OpenCode CLI：`opencode 1.19.0`。
