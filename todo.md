# dsh-opencode-bridge 链路排查 TODO

> 目的：在正式实现前，逐段排查“DSH → 插件 → OpenCode CLI → 插件 → DSH”完整数据链路中的未知点。  
> 原则：每完成一项，记录结论、证据、失败条件和后续实现影响；不要用猜测替代验证。  
> 当前状态：上游 HTTP 部分已验证，CLI 无头调用已验证，DSH 与插件之间的数据合同尚未验证。

---

## 0. 当前链路状态

| 链路段 | 状态 | 结论 |
|---|---|---|
| DSH → 插件 Adapter | 未验证 | 尚未接入 `LlmAdapter` |
| 插件 → 当前聊天 workspace | 未验证 | 尚未确认如何从 DSH 会话取得工作区 |
| 插件 → 模型目录 | 部分验证 | HTTP `/models` 可读；CLI `opencode models` 可用；⚠️ 目录与真实可用性不一致（见 TODO-06） |
| 插件 → OpenCode CLI 进程 | 已验证 | `opencode run --format json` 可无头执行；CliBridge 进程壳（spawn/超时/取消/清理）单测全绿 |
| CLI → 免费模型 | 已验证 | `opencode/mimo-v2.6-flash-free` 可返回正文（2026-10-16 曾有约 1 小时故障窗口，已恢复） |
| CLI session 续接 | 已验证 | 同一 `--session` 可跨进程保留上下文 |
| CLI JSON → 插件内部事件 | 已验证 | `step_start`、`text`、`step_finish`、`tool_use`；**新发现 stdout `type:"error"` 事件** |
| 插件内部事件 → DSH chunk | 已实现（子项目 2，切块模拟流式） | `src/to-dsh-chunks.ts` 转换器已实现，`index` 块序号从 0 递增，每块 `block-start → text-delta* → block-end`，多 step 多 `finish` 折叠为最后一个，`usage` 在 `finish` 前且唯一 |
| DSH chunk → UI | 未验证 | 尚未通过真实 DSH 聊天验证 |
| 取消与进程清理 | 已验证 | 五层超时 + AbortSignal + `taskkill /PID /T` 进程树清理，单测覆盖 |

结论：

```text
上游可用性已确认；
CLI 无头调用已确认；
完整 DSH 数据链路尚未打通。
```

---

## 1. 总体数据流

```text
DSH Chat / Session
  │
  │ GenerateOptions
  │ provider、model、messages、system、signal、...
  ▼
DSH LLM Service
  │
  │ LlmAdapter 合同
  ▼
dsh-opencode-bridge 插件
  │
  ├─ 1. 解析当前 DSH chat / workspace / session
  ├─ 2. 解析或查找 OpenCode sessionID
  ├─ 3. 获取模型目录与模型能力
  ├─ 4. spawn opencode run --format json
  ├─ 5. 解析 JSON Lines 事件
  ├─ 6. 转换为 DSH StreamChunk
  ├─ 7. 处理取消、超时、退出
  └─ 8. 写入 session 映射、状态和日志
  │
  ▼
OpenCode CLI
  │
  ├─ --dir 当前聊天 workspace
  ├─ --session OpenCode sessionID
  ├─ --model provider/model
  └─ --format json
  │
  ▼
OpenCode 免费模型
  │
  │ JSON Lines: step_start / text / tool_use / step_finish / ...
  ▼
插件事件转换器
  │
  │ block-start / text-delta / block-end / usage / finish
  ▼
DSH LLM Service
  │
  ▼
DSH Chat UI
```

---

# 一、DSH → 插件：请求入口

## TODO-01：确认 DSH LLM Service 的 adapter 注册方式

**问题：**

插件如何向 DSH 注册 `opencode-bridge` provider？

**需要排查：**

- [ ] 确认 `ctx.llm.registerAdapter` 是否可用；
- [ ] 确认 provider 列表参数格式；
- [ ] 确认插件是否需要 `inject = ["llm"]`；
- [ ] 确认 provider 名称应该使用 `opencode-bridge` 还是其他 ID；
- [ ] 确认注册句柄如何随插件 fiber 销毁；
- [ ] 确认 DSH 是否发出 adapter 更新事件。

**预期接口：**

```ts
ctx.llm.registerAdapter(["opencode-bridge"], adapter)
```

**验证方式：**

- 在插件入口打印注册成功日志；
- 重启或热加载 DSH；
- 检查模型选择器是否出现 provider。

**失败条件：**

- DSH 未显示 provider；
- 注册成功但 `listModels` 未被调用；
- 插件卸载后 adapter 仍存在。

---

## TODO-02：确认 DSH `LlmAdapter` 的完整方法合同

**问题：**

插件必须实现哪些方法，各自输入输出是什么？

**需要排查：**

- [ ] `providerInfo(provider)`；
- [ ] `listModels(provider)`；
- [ ] `resolveModel(provider, model)`；
- [ ] `prepareCall(provider, model, signal)`；
- [ ] `stream(options)`；
- [ ] `providerRetryPolicy(provider)`；
- [ ] 是否还有 `imageRequestPricing` 等可选方法；
- [ ] DSH 是否允许 adapter 直接返回异步生成器；
- [ ] DSH 是否要求 adapter 自己处理重试，还是交给宿主。

**需要记录：**

```text
方法名：
必选/可选：
输入类型：
输出类型：
异常处理要求：
取消要求：
```

**验证方式：**

- 用 fake adapter 先返回固定模型；
- 用 fake stream 返回固定 chunk；
- 观察 DSH 是否进入 UI；
- 再替换为真实 CLI stream。

---

## TODO-03：确认 `GenerateOptions` 的真实字段

**问题：**

DSH 发给 adapter 的请求里，哪些字段决定消息、工作区、取消和模型参数？

**重点字段：**

- [ ] `provider`
- [ ] `model`
- [ ] `messages`
- [ ] `system`
- [ ] `maxTokens`
- [ ] `signal`
- [ ] `reasoningEffort` / `reasoning`
- [ ] 是否有 `workspace` / `cwd` / `directory` / `project`；
- [ ] 是否有 DSH chat/session ID；
- [ ] 是否有 attachment/image 字段；
- [ ] 是否有 tool call 字段；
- [ ] 是否有 metadata/source 字段。

**验证方式：**

- 在 `stream(options)` 中打印字段名和类型；
- 不打印用户消息原文，只打印结构；
- 分别从主聊天、侧栏聊天、子代理等入口调用；
- 记录不同入口字段是否一致。

**需要形成结论：**

```text
workspace 可直接取得：
  是 / 否

chat/session ID 可直接取得：
  是 / 否

取消通过：
  signal / AbortSignal / 其他

消息格式：
  DSH message 数组
```

---

# 二、DSH chat → workspace：工作区定位

## TODO-04：确定当前聊天对应的工作区来源

**背景：**

目标模型要求：

```text
一个 DSH chat
  ↕
一个 workspace
  ↕
一个 OpenCode session
```

**候选来源：**

- [ ] A. `GenerateOptions` 直接携带 workspace；
- [ ] B. 从 DSH session/project service 查询；
- [ ] C. 从会话元数据或 ID 映射；
- [ ] D. 从插件配置的默认 workspace 回退；
- [ ] E. 从当前 DSH 进程 cwd 回退；
- [ ] F. 用户手工指定。

**需要回答：**

```text
主聊天 workspace 来源：
侧栏聊天 workspace 来源：
子代理 workspace 来源：
未打开项目时的回退：
workspace 变更后如何处理：
```

**风险：**

- 不能使用 `process.cwd()` 直接替代聊天工作区；
- 不能让不同 DSH chat 的 CLI 读取错误项目；
- 不能把用户消息内容写入 workspace key。

**验证方式：**

- 在两个不同项目目录分别创建 DSH 聊天；
- 打印插件解析出的 workspace；
- 确认两者不串；
- 用 `opencode run --dir` 验证 CLI 实际目录。

**完成标准：**

- [ ] 找到稳定且可测试的 workspace 获取路径；
- [ ] 有明确的默认和错误回退；
- [ ] 不同聊天不会共享错误目录。

---

## TODO-05：确定 workspace 与 DSH chat 的本地映射

**问题：**

插件需要保存：

```text
DSH chat ID → workspace + OpenCode sessionID
```

**需要确认：**

- [ ] DSH chat ID 从哪里取得；
- [ ] chat ID 是否跨重启稳定；
- [ ] 是否要按 provider/model 分开；
- [ ] workspace 改变时是否重建 session；
- [ ] session 过期时如何清理；
- [ ] 是否允许不同 chat 使用同一 workspace。

**建议存储：**

```text
~/.dsh-opencode-bridge/sessions.json
```

**建议结构：**

```json
{
  "<dsh-chat-id>": {
    "workspace": "F:/project/example",
    "opencodeSessionId": "ses_...",
    "model": "opencode/mimo-v2.6-flash-free",
    "createdAt": "ISO-8601",
    "updatedAt": "ISO-8601",
    "status": "active | interrupted | deleted"
  }
}
```

**完成标准：**

- [ ] 明确 key、value、持久化位置；
- [ ] 并发写入策略确定；
- [ ] session 失效和删除策略确定；
- [ ] 不保存敏感消息正文。

---

# 三、插件 → 模型目录：模型发现

## TODO-06：确认模型目录首选来源

**候选来源：**

- [ ] A. `opencode models`；
- [ ] B. OpenCode 本地 catalog / debug 命令；
- [ ] C. `GET https://opencode.ai/zen/v1/models`；
- [ ] D. 本地缓存；
- [ ] E. 静态白名单。

**已知：**

- HTTP `/models` 返回 `200`；
- `opencode models` 能列出 `opencode/*` 与 `opencode-go/*`；
- CLI 免费推理可以使用 `opencode/mimo-v2.6-flash-free`。

**需要回答：**

- [ ] CLI 目录是否比 HTTP 目录更准确；
- [ ] 哪些模型是真正免费的；
- [ ] `opencode/*` 与 `opencode-go/*` 的区别；
- [ ] 哪些模型支持图片；
- [ ] 哪些模型支持 reasoning effort；
- [ ] 上下文长度和最大输出从哪里取；
- [ ] 目录刷新周期；
- [ ] 目录失败时的回退顺序。

**建议回退：**

```text
opencode models
  ↓ 失败
HTTP GET /zen/v1/models
  ↓ 失败
本地缓存
  ↓ 失败
静态白名单
```

**完成标准：**

- [ ] 明确首选目录命令；
- [ ] 至少列出一个实际可调用模型；
- [ ] 目录失败不会导致插件加载失败；
- [ ] DSH 模型选择器可以显示模型。

---

## TODO-07：确认模型能力元数据

**需要为每个模型确认：**

- [ ] `id`
- [ ] `provider`
- [ ] `displayName`
- [ ] `inputModalities`
- [ ] `contextWindow`
- [ ] `maxTokens`
- [ ] `reasoning`
- [ ] `efforts`
- [ ] `free`
- [ ] `available`

**MVP 决策：**

```text
图片：默认只允许 text，验证后再开
reasoning：默认不向 DSH 暴露，验证后再开
free 判断：只展示已验证免费模型
```

**完成标准：**

- [ ] 至少一个模型在 DSH 中正确显示；
- [ ] 不把付费/未知模型误标为免费；
- [ ] 模型参数缺失时有安全默认值。

---

# 四、插件 → OpenCode CLI：进程与命令

## TODO-08：确认 CLI 可执行文件发现

**候选路径：**

- [ ] PATH 中的 `opencode`；
- [ ] `C:\Users\86181\AppData\Roaming\npm\opencode.cmd`；
- [ ] `opencode-ai` 包中的 `opencode.exe`；
- [ ] 插件配置中的绝对路径。

**已知：**

```text
opencode --version → 1.19.0
```

**需要回答：**

- [x] Windows 下应 spawn `.cmd` 还是 `.exe`；
- [x] Node spawn 应使用 `shell: true` 还是直接执行 exe；
- [ ] DSH host 进程 PATH 是否包含 npm global 目录；
- [x] 用户未安装 CLI 时如何提示；
- [ ] CLI 版本过低时如何处理。

**完成标准：**

- [ ] 在 DSH host 环境中可稳定发现 CLI；
- [x] 错误信息包含安装提示；
- [x] 不依赖 PowerShell wrapper。

**结论（2026-10-16）：** 四级发现已实现（`src/discover-cli.ts` + 7 条单测）：显式 command → PATH → npm 全局布局 → `CLI_NOT_FOUND`（错误消息含 `npm i -g opencode-ai` 安装提示）。Windows 下命中 `.cmd`/`.ps1` shim 时解析真身 `opencode.exe` 作为执行入口，禁 `shell: true`（Node 24 spawn `.cmd` 直接 `EINVAL`）。真实 CLI 集成 R01–R08、R11 全部走该发现路径通过。DSH host PATH 与版本下限检查留待子项目 3。

---

## TODO-09：确认 `opencode run` 命令参数

**MVP 命令形态：**

```text
opencode run
  --dir <workspace>
  --model <provider/model>
  --format json
  --session <opencode-session-id>
  <prompt>
```

**需要排查：**

- [x] `--dir` 是相对路径还是绝对路径；
- [x] workspace 不存在时的行为；
- [x] `--session` 不存在时是否自动创建；
- [x] `--session` 失效时的行为；
- [ ] prompt 是否支持多行和系统提示；
- [ ] `--agent` 是否需要显式设置；
- [ ] `--auto` 是否会影响工具调用；
- [x] `--format json` 是否始终逐行输出；
- [x] 是否存在 stdout/stderr 混杂日志；
- [ ] `--print-logs` 是否会污染 JSON；
- [ ] `--variant` 是否可用于 reasoning effort；
- [ ] 是否有参数控制工具调用。

**MVP 决策：**

- [x] 不开启交互模式；
- [x] 不开启 share；
- [x] 不自动允许危险权限；
- [x] 使用明确 model ID；
- [x] 使用 `--format json`；
- [x] 不把用户 prompt 拼进 shell 字符串，使用参数数组。

**完成标准：**

- [x] 参数构造有单元测试；
- [x] 特殊字符不会破坏命令；
- [x] workspace、model、session 都能验证生效。

**结论（2026-10-16）：** 参数形态 `run --dir <绝对路径> --model <provider/model> --format json [--session <id>] <prompt>`，一律 argv 数组（G2，禁 `shell:true`）。`--dir` 传绝对路径：桥内先 resolve 再校验，相对且不存在 / 目录不存在 → `WORKSPACE_INVALID`（集成 R05/R06 验证）；`--session` **不自动创建**，失效即 exit 1 + stderr `Session not found`（R03）；prompt 走最后一个 argv，多行与特殊字符天然安全（fake CLI `session-echo` 模式 + 单测验证参数保真）。

---

## TODO-10：确认第一轮 session 创建与第二轮续接

**已验证：**

```text
第一轮输出 sessionID
第二轮传入同一 sessionID
第二轮可记住上一轮内容
```

**仍需排查：**

- [ ] 第一轮不传 session 时，sessionID 何时出现；
- [ ] sessionID 是否一定在 `step_start`；
- [ ] 第一轮在 session 创建前失败如何处理；
- [ ] 同一 session 更换 model 是否允许；
- [ ] 同一 session 更换 workspace 是否允许；
- [ ] session 是否会自动过期；
- [ ] 删除 session 的命令和时机；
- [ ] DSH chat 重命名/复制时 session 如何处理；
- [ ] 中断的回答是否已经写入 session；
- [ ] 删除 session 后下一轮是否自动新建。

**建议：**

```text
sessionID 在首个 step_start 后立即持久化；
回答正常完成后保留；
用户主动清空聊天时删除；
DSH 插件卸载时只清理映射，不默认删除 OpenCode session。
```

**完成标准：**

- [ ] 有一个明确状态机；
- [ ] 同一 DSH chat 跨多轮稳定续接；
- [ ] session 失效可自动恢复；
- [ ] 不出现重复 session 累积失控。

---

# 五、CLI → 插件：JSON Lines 事件

## TODO-11：确认 JSON Lines 解析规则

**已观察事件：**

```text
step_start
text
tool_use
step_finish
```

**需要排查的事件类型：**

- [x] `step_start`
- [x] `step_finish`
- [x] `text`
- [ ] `reasoning` / thinking
- [x] `tool_use`
- [ ] `tool_result`
- [ ] `retry`
- [x] `error`（2026-10-16 新见，见结论）
- [ ] `file` / patch / snapshot
- [ ] session 创建/删除事件
- [ ] 未知事件

**需要回答：**

- [x] 每行是否严格是一个 JSON 对象；
- [x] 是否可能有空行；
- [x] 是否可能输出非 JSON stderr；
- [x] 是否可能一行 JSON 被截断；
- [ ] 事件是否保证有序；
- [x] `timestamp` 与 `sessionID` 是否每条都有；
- [ ] 多 step 时 part 的关系是什么。

**解析策略：**

```text
stdout 按换行切分
  → JSON.parse 成功 → 事件
  → JSON.parse 失败 → 记录为 protocol error
  → 非 JSON stderr → 日志，不直接发 DSH
```

**完成标准：**

- [x] 能处理正常输出；
- [x] 能处理非 JSON 污染；
- [x] 能处理进程提前退出；
- [x] 能限制单行和总输出大小。

**结论（2026-10-16）：** stdout 严格一行一个 JSON 对象；解析器（`src/parse-lines.ts` + 单测）处理 CRLF、空行、跨 chunk 半行缓冲、超长行（>1 MiB 截断上报不 OOM）；非 JSON 行 → `protocol-line` 诊断、不污染正文；进程提前退出无 finish → finalize 兜底 `PROTOCOL_ERROR`。**新发现（2026-10-16）：stdout 存在 `type:"error"` 事件**（上游推理失败时，见 memory.md 3A.9），当前按未知事件处理（诊断+忽略），错误码由 classifyFailure 兜底 —— 改进项：显式映射 `UPSTREAM_ERROR`。

---

## TODO-12：确认 `text` 事件的粒度与多段文本

**已观察：**

```text
text.part.text 一次给出完整正文
```

**需要排查：**

- [x] 是否存在 `delta` 字段；
- [x] 是否存在多条 text 事件；
- [x] 同一 messageID 下是否可多段；
- [x] text 是否可能被 tool_use 分隔；
- [x] text 是否包含 reasoning；
- [x] 文本结束时是否保证有 `step_finish`；
- [ ] 中断时 text 是否完整写入 session。

**DSH 同步候选：**

### 方案 A：切块模拟流式

```text
完整 text
  → block-start
  → 多个 text-delta
  → block-end
```

### 方案 B：整段同步

```text
完整 text
  → block-start
  → 单个 text-delta
  → block-end
```

**MVP 建议：**

先采用方案 A，但把切块器独立封装；若后续得到真实 delta 事件，只替换数据源。

**完成标准：**

- [x] 能聚合多个 text；
- [ ] 能跨 tool_use 保持正确 index；
- [ ] 能生成 DSH 可接受的连续 chunk；
- [x] 不重复发送正文。

**结论（2026-10-16）：** `text` 为整段一次性（实测 1 条 len=1248；R08 长回答通过），无 `delta` 字段；同一 `messageID` 多段按序拼接、不重复发（单测覆盖）；`text` 不含 reasoning；tool 事件与 text 混合出现时正文不受污染（R07）。DSH 流式体验按方案 A 由上层切块模拟，切块器独立封装。"跨 tool_use 的 index"与"DSH 连续 chunk"属 DSH 段（子项目 3）。

---

## TODO-13：确认 `step_finish` 与 usage 映射

**已观察字段：**

```json
{
  "reason": "stop",
  "tokens": {
    "total": 9545,
    "input": 1316,
    "output": 5,
    "reasoning": 32,
    "cache": {
      "read": 8192,
      "write": 0
    }
  },
  "cost": 0
}
```

**需要映射到 DSH：**

```text
input → inputTokens
output → outputTokens
cache.read → cacheReadTokens
cache.write → cacheWriteTokens
reasoning → DSH 是否有独立字段？
total → 是否使用？
cost → DSH 是否消费？
```

**需要确认：**

- [x] 一个请求有多个 `step_finish` 时是覆盖还是累加；
- [ ] usage 必须在 finish 前发送吗；
- [ ] 错误时是否必须发送 usage；
- [ ] 取消时是否发送已知 usage；
- [ ] cache read/write 是否可以为 0 时省略；
- [ ] DSH 是否拒绝重复 usage。

**完成标准：**

- [x] 字段映射有单元测试；
- [x] 多 step usage 策略有明确结论；
- [x] 正常、错误、取消三条路径都覆盖。

**结论（2026-10-16）：** usage 按 `step_finish` 报**增量**、跨 step **累加**（验算 `total = input+output+reasoning+cache.read` 成立）；字段映射 `tokens.{input,output,reasoning,cache.read,cache.write,total}` → `CliUsage`，`cost` 单独保留。R08 验证长回答 usage 非零；单测覆盖 sum/last 两种模式与 cache 缺省按 0。错误/取消路径 usage 为全零。"何时向 DSH 发送 usage"属 DSH 段（TODO-15/16）。

---

## TODO-14：确认 `finish.reason` 的转换

**候选 DSH finish reason：**

```text
stop
max-tokens
tool-calls
aborted
error
```

**OpenCode 可能值：**

- [x] `stop`
- [x] `tool-calls`
- [ ] `length` / max tokens
- [ ] `error`
- [ ] abort / interrupted
- [x] 其他未知 reason（实测见 `"unknown"`）

**需要记录映射表：**

```text
OpenCode reason → DSH reason
未知 reason → 保守映射为什么
空正文 → error 还是 stop
工具结束 → tool-calls 还是 stop
取消 → aborted 还是 error
```

**完成标准：**

- [x] 每个已知值有映射；
- [x] 未知值不会导致 crash；
- [x] 错误消息保留原始信息。

**结论（2026-10-16）：** 映射表已实现（`toFinishMapping`，单测 12 条）：`stop→stop`（无正文→`EMPTY_RESPONSE`）、`length`/`max_tokens`/`max-tokens`/`MaxTokens→max-tokens`、`tool-calls→tool-calls`（无正文→`TOOL_ONLY_RESPONSE`）、未知值→`error+UNKNOWN` 保留 `rawReason`、缺 reason→`PROTOCOL_ERROR`。**新见值 `reason:"unknown"`**（2026-10-16 nemotron 空响应场景），保守映射行为符合预期。

---

# 六、插件 → DSH：StreamChunk 同步

## TODO-15：确认 DSH StreamChunk 的真实结构

**需要拿到准确类型：**

- [ ] `block-start`
- [ ] `text-delta`
- [ ] `block-end`
- [ ] `usage`
- [ ] `finish`

**需要确认：**

- [ ] 是否必须有 `index`；
- [ ] `index` 从 0 还是 1 开始；
- [ ] 多 block 是否递增；
- [ ] `blockType` 值；
- [ ] `block` 完整对象字段；
- [ ] `usage` 字段是否可省略；
- [ ] `finish.reason` 形状；
- [ ] 是否允许在 finish 前重复 usage；
- [ ] 是否允许没有 block 直接 finish；
- [ ] error finish 是否需要 failure/code/message。

**验证方式：**

- 从 DSH 类型声明或运行时 inspect 获取真实合同；
- 先用最小 adapter 输出测试 chunk；
- 用 DSH `BlockAssembler` 或真实 UI 验证。

**完成标准：**

- [ ] 有一份真实 chunk 类型表；
- [ ] 每个字段都有来源；
- [ ] 不依赖参考插件的猜测。

**结论（2026-10-17）：** DSH `StreamChunk` 真实合同已从 `app.asar` API manifest 提取（`docs/research/dsh-llm-contract.md`），`index` 为块序号从 0 递增、每块 `block-start → text-delta* → block-end`、`usage` 在 `finish` 前、`finish` 唯一。

---

## TODO-16：设计 CLI 事件 → DSH chunk 转换器

**输入：**

```text
OpenCode JSON event
+ 当前 block state
+ 当前 usage state
+ 当前 finish state
```

**输出：**

```text
零个或多个 DSH StreamChunk
```

**需要覆盖：**

- [ ] 第一个 text 前发出 block-start；
- [ ] 每段 text 产生一个或多个 text-delta；
- [ ] text 结束发出 block-end；
- [ ] 多个 step 的 index 递增；
- [ ] tool_use 不污染 DSH 文本；
- [ ] usage 在 finish 前发出；
- [ ] finish 只发一次；
- [ ] 错误产生 error finish；
- [ ] 取消产生 aborted finish；
- [ ] 进程无正文退出产生 error finish；
- [ ] 未知事件被忽略或记录。

**完成标准：**

- [ ] 纯函数可单元测试；
- [ ] 不直接依赖 child process；
- [ ] 正常、工具、错误、取消均有样例；
- [ ] chunk 顺序稳定。

**结论（2026-10-17）：** 转换器 `src/to-dsh-chunks.ts` 已实现，多 step 多 `finish` 折叠为最后一个。

---

## TODO-17：确认 DSH 是否要求思考、工具或图片块

**当前 MVP 计划：**

```text
text：支持
reasoning：忽略
tool call：内部消化
image：不支持
```

**仍需确认：**

- [ ] 模型选择器是否必须声明 input modalities；
- [ ] 不支持 reasoning 是否会导致模型不可选；
- [ ] tool_use 是否会破坏 DSH agent loop；
- [ ] 如果 DSH 自身也有工具循环，OpenCode CLI 是否形成双重 agent；
- [ ] 是否应使用 OpenCode 的无工具 agent；
- [ ] 是否要将 CLI 作为“纯文本生成器”而非完整 agent。

**关键风险：**

```text
DSH Agent 自己有工具
OpenCode CLI 也可能有自己的工具
若不隔离，可能出现双层 Agent 行为
```

**MVP 决策待定：**

- [ ] 禁用 OpenCode 工具；
- [ ] 或使用专用无工具 agent；
- [ ] 或只把 CLI 作为一次性问答后端；
- [ ] 或允许工具但不转发给 DSH。

**完成标准：**

- [ ] 明确 CLI 在 MVP 中是“模型后端”还是“Agent 后端”；
- [ ] 明确不会意外执行 workspace 修改；
- [ ] 明确 DSH 看到的只是预期内容。

---

# 七、进程生命周期、取消与错误

## TODO-18：确认 spawn 模式

**建议参数形式：**

```text
spawn(opencodeExe, argsArray, {
  cwd: workspace,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
})
```

**需要验证：**

- [x] 直接 spawn `.exe` 是否可行；
- [x] 是否需要 `.cmd`；
- [x] 是否需要 `shell: true`；
- [x] `cwd` 与 `--dir` 是否需要同时设置；
- [ ] Windows 下环境变量是否包含必要 PATH；
- [x] stdout 是否逐块到达；
- [x] stderr 是否可单独收集。

**完成标准：**

- [x] 不通过字符串 shell 拼接；
- [x] 特殊路径可工作；
- [ ] DSH host 中可执行。

**结论（2026-10-16）：** `spawn(opencode.exe, argv数组, { cwd: workspace, stdio: ["ignore","pipe","pipe"], windowsHide: true })`（`src/run-cli.ts`）。真身 `.exe` 直接可执行、`.cmd` 不需要且禁用（Node 24 直接 `EINVAL`）；`cwd` 与 `--dir` 双保险同时设置；stdout/stderr 双管道分流（fake CLI 16 种模式单测 + 真实 CLI 集成 8 条均走该路径）。DSH host 可执行性留待子项目 3 验证。

---

## TODO-19：确认超时策略

**建议超时：**

```text
startup timeout：CLI 启动到首个事件
first event timeout：发出 prompt 后首个事件
body idle timeout：事件之间最大静默时间
total request timeout：整轮最大时间
shutdown timeout：回答结束后等待进程退出
```

**需要决定默认值：**

- [x] startup：例如 15 秒；
- [x] first event：例如 30 秒；
- [x] body idle：例如 120 秒；
- [x] total：例如 10 分钟；
- [x] shutdown：例如 3 秒；
- [ ] 不同模型是否不同。

**行为要求：**

```text
超时 → 杀进程 → error/aborted finish → DSH 不悬挂
```

**完成标准：**

- [x] 每个计时器都有清理；
- [x] 取消和超时不竞争；
- [x] 不留下子进程。

**结论（2026-10-16）：** 五层超时已实现（`DEFAULT_TIMEOUTS`）：`startup 30s / firstEvent 45s / idle 300s / total 600s / shutdown 3s`；`idle` 自上一个事件起算（实测单次生成静默 46.5s 打底，不能用 120s）。每层触发与不误杀均有单测（含 firstEvent 到达后长跑不误杀、idle 阈值内长静默正常完成）；`settle()` 单出口保证取消与超时不竞争；集成 R11 验证不留下子进程。

---

## TODO-20：确认取消与 Windows 进程树清理

**问题：**

DSH `signal.abort` 后，如何确保 CLI 及子进程全部退出？

**需要排查：**

- [x] Node `child.kill()` 是否足够；
- [x] 是否需要 `taskkill /T /F`；
- [x] 是否需要 `process.kill(-pid)`；
- [x] Windows 下 `.cmd` 的子进程归属；
- [x] abort listener 是否只注册一次；
- [x] 取消后是否还要读取 stdout；
- [x] 取消后是否仍发 finish。

**建议流程：**

```text
DSH abort
  → 标记 cancelled
  → 停止继续 yield
  → 杀完整进程树
  → 等待 exit/close
  → 清理 timer/listener
  → 发出 aborted finish（若合同需要）
```

**完成标准：**

- [x] 每轮请求结束后进程数归零；
- [ ] 连续 20 轮无残留；
- [x] 取消没有 unhandled rejection；
- [ ] DSH UI 不卡住。

**结论（2026-10-16）：** 取消经 AbortSignal → `taskkill /PID <pid> /T /F` 杀进程树（CLI 派生 `git`，`child.kill()` 只杀直接子进程、不够）；清理只按 PID，禁 `taskkill /IM`；进程归零断言按本次进程树映像名基线（全机 PID/`opencode` grep 会误伤 OpenCode Desktop 常驻 `opencode-cli.exe`）。单测覆盖取消、进入即中止、共享 signal 多请求无 listener 泄漏、取消后被 spawn 进程消失；集成 R11 连续 5 轮归零（20 轮版留待回归加跑）。取消后以 `finishReason="aborted"` resolve（spec I4），不发多余 finish 事件。DSH UI 表现留待子项目 3/4。

---

## TODO-21：确认错误分类

**需要分类：**

```text
CLI_NOT_FOUND
CLI_START_FAILED
WORKSPACE_INVALID
SESSION_INVALID
PROMPT_FAILED
TIMEOUT
CANCELLED
PROTOCOL_ERROR
UPSTREAM_ERROR
EMPTY_RESPONSE
TOOL_ONLY_RESPONSE
UNKNOWN
```

**需要回答：**

- [x] 哪些可重试；
- [x] 哪些只报告；
- [ ] 错误信息如何传给 DSH；
- [x] 是否保留 stderr；
- [x] 是否限制错误长度；
- [x] 如何避免泄露敏感路径或环境变量。

**MVP 建议：**

- 重试只在“尚未产生任何内容”时进行；
- `CANCELLED` 不重试；
- `CLI_NOT_FOUND` 不重试；
- `TIMEOUT` 默认不重试；
- 每轮最多一次内部启动重试，避免 DSH 长时间悬挂。

**完成标准：**

- [x] 错误分类有单元测试；
- [x] 每类错误产生确定 finish reason；
- [x] 日志和用户消息边界清晰。

**结论（2026-10-16）：** 12 类 ErrorCode + 判定链（取消 > 超时 > session 失效 > 无 finish 退出 > 其他）已实现并单测覆盖；stderr 全程收集、剥 ANSI 后仅用于细分 `ErrorCode`（主判据 exit code + stdout 事件），保留 2000 字符进 `diagnostics`、不进正文。可重试仅 `CLI_START_FAILED`/`TIMEOUT` 且未产出正文（`canRetry`）；执行期失败 `runCliBridge` resolve（`finishReason:"error"+errorCode`，spec I4），建立期错误 reject。**新发现（2026-10-16）：上游推理错误走 stdout `type:"error"` 事件**（payload 含 name/statusCode/isRetryable/responseBody），当前只进 diagnostics、错误码由 classifyFailure 兜底为 `PROTOCOL_ERROR` —— 改进项：显式映射 `UPSTREAM_ERROR`（子项目 3 前处理，见 memory.md 3A.9）。

---

# 八、session 持久化与清理

## TODO-22：确认 session 状态机

**状态候选：**

```text
NONE
CREATING
ACTIVE
INTERRUPTED
DELETED
STALE
```

**转换：**

```text
NONE
  → 首轮运行得到 sessionID → ACTIVE

ACTIVE
  → 正常完成 → ACTIVE
  → 中断/取消 → INTERRUPTED
  → 上游标记失效 → STALE
  → 用户清空聊天 → DELETED

INTERRUPTED
  → 下轮继续同 session → ACTIVE
  → session 不可用 → 新建 → ACTIVE

STALE
  → 删除并新建 → ACTIVE
```

**完成标准：**

- [ ] 每次状态变化有日志；
- [ ] 文件写入原子；
- [ ] 崩溃后能恢复；
- [ ] 不会无限增长。

---

## TODO-23：确认 session 删除策略

**候选：**

- [ ] 每轮完成后保留；
- [ ] DSH 聊天清空时删除；
- [ ] DSH 聊天删除时删除；
- [ ] 插件卸载时保留；
- [ ] 超过 N 天删除；
- [ ] 超过 N 个删除旧 session。

**需要确认命令：**

```text
opencode session delete <sessionID>
```

**风险：**

- 不应在回答进行中删除；
- 不应误删其他 DSH chat 的 session；
- 删除失败不应影响当前回答；
- 不应把 session 删除失败报成模型失败。

**完成标准：**

- [ ] 删除触发条件明确；
- [ ] 删除有日志；
- [ ] 删除失败有回退；
- [ ] session 文件不会无限膨胀。

---

# 九、模型目录、缓存与状态

## TODO-24：确认缓存路径与内容

**建议路径：**

```text
~/.dsh-opencode-bridge/
├── sessions.json
├── models.json
├── catalog-status.json
└── logs/
```

**models.json 内容：**

```json
{
  "source": "cli | http | cache | static",
  "fetchedAt": "ISO-8601",
  "models": [
    {
      "id": "opencode/mimo-v2.6-flash-free",
      "provider": "opencode",
      "free": true,
      "inputModalities": ["text"],
      "contextWindow": 262144,
      "maxTokens": 32768
    }
  ]
}
```

**catalog-status.json 内容：**

```json
{
  "status": "ready | pending | error",
  "source": "cli | http | cache | static",
  "modelCount": 9,
  "lastError": "",
  "writtenAt": "ISO-8601"
}
```

**完成标准：**

- [ ] 路径固定；
- [ ] 写入原子；
- [ ] 损坏文件可恢复；
- [ ] 不写入 prompt 或消息正文；
- [ ] 错误不会阻止插件启动。

---

# 十、插件入口、安装与 DSH 集成

## TODO-25：确认插件入口与 bundle patch

**需要确认：**

- [ ] `package.json` 的 `dsh.bundle.patch`；
- [ ] `cordis.patch.yml` 插入行；
- [ ] 插件 export 是否为 `name/apply/inject`；
- [ ] `inject` 是否应为 `["llm"]`；
- [ ] 插件配置 schema 如何导出；
- [ ] 构建输出 `lib/index.js`；
- [ ] client bundle 是否 MVP 必需。

**MVP 建议：**

- 第一版只做 host 插件；
- 不做设置页；
- 配置先走 `cordis.patch.yml`；
- 没有 `llm` 服务时安全跳过。

**完成标准：**

- [ ] `npm run typecheck` 通过；
- [ ] `npm run build` 产生 `lib/`；
- [ ] bundle patch 语法正确；
- [ ] 插件可被 DSH 识别。

---

## TODO-26：确认 DSH 安装与调试方式

**需要确认：**

- [ ] `dsh plugin add` 的真实命令；
- [ ] 是否可以 `plugin_manager install_bundle`；
- [ ] 是否需要重启 DSH；
- [ ] host 插件日志在哪里；
- [ ] 如何观察 adapter 注册；
- [ ] 如何观察模型选择器；
- [ ] 如何强制刷新插件；
- [ ] 插件失败时 DSH 的行为。

**完成标准：**

- [ ] 有一份从构建到安装的最短命令；
- [ ] 有日志查看方式；
- [ ] 有卸载和恢复方式。

---

## TODO-27：确认模型选择器显示

**需要验证：**

- [ ] `opencode-bridge` provider 是否出现；
- [ ] 模型列表是否出现；
- [ ] 模型名称是否正常；
- [ ] 图片能力是否错误显示；
- [ ] reasoning effort 是否错误显示；
- [ ] 选择模型后是否能进入聊天；
- [ ] 切换模型是否影响 session。

**完成标准：**

- [ ] 至少一个模型可选；
- [ ] 选择后能发起真实请求；
- [ ] 不影响 DSH 其他 provider。

---

# 十一、DSH 实机数据流验收

## TODO-28：最小 Adapter 冒烟测试

**分阶段实现，不要一次接完：**

### 阶段 A：Fake adapter

- [ ] 注册 provider；
- [ ] 返回固定模型；
- [ ] `stream` 返回固定文本；
- [ ] DSH UI 能显示。

### 阶段 B：CLI 结果直通

- [ ] 启动 CLI；
- [ ] 聚合完整 `text`；
- [ ] 一次性返回；
- [ ] 验证 DSH 正常 finish。

### 阶段 C：切块流式

- [ ] 把完整 text 切成多个 `text-delta`；
- [ ] DSH 显示连续输出；
- [ ] usage/finish 正常。

### 阶段 D：真实 session 续聊

- [ ] 第一轮保存 sessionID；
- [ ] 第二轮使用同 session；
- [ ] DSH 上下文与 OpenCode 上下文符合预期。

### 阶段 E：取消与错误

- [ ] DSH 取消；
- [ ] CLI 退出；
- [ ] 无残留进程；
- [ ] UI 显示正确状态。

**完成标准：**

- [ ] 每阶段都有可复现命令；
- [ ] 每阶段都有日志或输出证据；
- [ ] 前一阶段未通过不进入下一阶段。

---

## TODO-29：确认 DSH 中的工作区隔离

**测试：**

```text
DSH chat A → workspace F:\project\A
DSH chat B → workspace F:\project\B
```

**验证：**

- [ ] chat A 的 CLI cwd 是 A；
- [ ] chat B 的 CLI cwd 是 B；
- [ ] session 不串；
- [ ] 输出不串；
- [ ] 切换模型不串 workspace；
- [ ] 同时请求时资源可控。

**完成标准：**

- [ ] 有两个独立项目的测试记录；
- [ ] 进程参数中有正确 `--dir/cwd`；
- [ ] 日志中 session 与 chat 映射正确。

---

## TODO-30：确认 DSH 中的取消与续接

**测试：**

1. 发起长回答；
2. DSH 取消；
3. 确认 CLI 进程树退出；
4. 下一轮继续同一 session；
5. 确认 OpenCode 记住取消前内容；
6. 确认 DSH 不崩溃。

**需要回答：**

- [ ] 取消后的 OpenCode session 状态是什么；
- [ ] 未完成回答是否已经持久化；
- [ ] 下一轮是否应该继续；
- [ ] 是否应该删除 interrupted session；
- [ ] DSH UI 是否得到 aborted finish。

**完成标准：**

- [ ] 没有残留进程；
- [ ] 没有悬挂 Promise；
- [ ] 下一轮能恢复；
- [ ] 状态转换有日志。

---

# 十二、优先级

## P0：不完成就无法知道链路是否成立

- TODO-01：adapter 注册；
- TODO-03：GenerateOptions 字段；
- TODO-04：workspace 来源；
- TODO-08：CLI 发现；
- TODO-09：CLI 参数；
- TODO-11：JSON Lines 解析；
- TODO-12：text 粒度；
- TODO-15：DSH StreamChunk 结构；
- TODO-16：事件到 chunk 转换；
- TODO-18：spawn；
- TODO-20：取消与进程树。

## P1：MVP 正确性

- TODO-02：Adapter 方法合同；
- TODO-06：模型目录；
- TODO-10：session 创建与续接；
- TODO-13：usage；
- TODO-14：finish reason；
- TODO-17：工具与双重 Agent 边界；
- TODO-19：超时；
- TODO-21：错误分类；
- TODO-22：session 状态机；
- TODO-25：插件入口；
- TODO-28：分阶段冒烟。

## P2：稳定性和可维护性

- TODO-05：chat 映射持久化；
- TODO-07：模型能力；
- TODO-23：session 删除；
- TODO-24：缓存状态；
- TODO-26：安装调试；
- TODO-27：选择器显示；
- TODO-29：工作区隔离；
- TODO-30：取消续接；
- 日志、状态文件、单元测试和故障注入。

---

# 十三、建议的第一轮排查清单

下一步只做以下内容，不提前写完整插件：

```text
[ ] 1. 在 fake adapter 中打印 GenerateOptions 结构
[ ] 2. 找到 DSH chat/workspace 获取方式
[ ] 3. 建立独立 CLI bridge 原型
[ ] 4. 输入 workspace + prompt + sessionID
[ ] 5. 输出 text + usage + finish + sessionID
[ ] 6. 验证多轮续接
[ ] 7. 验证取消后无残留进程
[ ] 8. 对照 DSH StreamChunk 真实类型
[ ] 9. 实现最小事件映射
[ ] 10. 再接真实 DSH LlmAdapter
```

独立原型目标：

```text
runCliBridge({
  workspace,
  prompt,
  sessionId?
}) => {
  text,
  usage,
  finishReason,
  sessionId,
  durationMs
}
```

这个原型不负责：

- DSH UI；
- 模型选择器；
- 设置页；
- IP 池；
- 图片；
- 完整工具转发。

它只负责排除：

```text
workspace → CLI → JSON → text/usage/finish → 取消/清理
```

---

# 十四、数据链路完成定义

只有以下条件全部满足，才能认为“数据链路通了”：

- [ ] DSH 能调用 `opencode-bridge.stream()`；
- [ ] 插件能取得正确 workspace；
- [ ] 插件能取得或创建 OpenCode session；
- [ ] CLI 能在该 workspace 中启动；
- [ ] CLI JSON Lines 能被稳定解析；
- [ ] `text` 能转换成 DSH 文本 chunk；
- [ ] `step_finish` 能转换成 DSH usage 和 finish；
- [ ] DSH UI 能显示完整回答；
- [ ] 同一 DSH chat 第二轮能续接；
- [ ] 不同 DSH chat 不串 workspace/session；
- [ ] 取消后没有残留 CLI 进程；
- [ ] CLI 失败时 DSH 不崩溃、不悬挂；
- [ ] 模型选择器至少有一个可选模型；
- [ ] 错误、超时、空响应均有明确 finish；
- [ ] 全链路至少有一条可复现的验收记录。
