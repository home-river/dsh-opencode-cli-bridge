# ISSUE-001 问"当前工作区的情况"得空气泡（无正文、无报错）

- 状态：fixed（2026-10-18 实机取证定论并修复，待复验）
- 发现日期：2026-10-17
- 修复日期：2026-10-18
- 相关文件：`src/prompt.ts`、`src/to-dsh-chunks.ts`、`src/adapter.ts`、`src/plugin.ts`、`src/map-events.ts`

## 现象

- **触发条件**：DSH 端用本插件（provider `opencode-bridge`）提问"当前工作区的情况"这类询问工作区/项目现状的问题；
- **表现**：出现空白的助手回复气泡——无正文、无报错字样（"空气回复"）；其他内容的提问（长文、闲聊等）输出正常；
- **复现步骤**：
  1. DSH 里选择 `opencode-bridge` 的任意模型发起对话；
  2. 提问"当前工作区的情况"；
  3. 观察：气泡出现但始终无内容。
- **范围**：同一会话后续轮次与新开会话第一轮均可复现（用户实测）。

## 原因

根因分析（进行中，2026-10-17）：

已排除的嫌疑（均有实证）：

1. **事件映射/转换层** —— CLI 级忠实复现（同 argv `run --dir <ws> --model <m> --format json`、同问题）得到多 step + bash `tool_use` + 末尾 `text`(358 字) 的正常事件流；灌进编译好的 `OpenCodeEventMapper` + `DshChunkConverter` 出块完整、`finish(stop)` 正常。
2. **`--session` 透传** —— 实测 `opencode run --session` 对任何不存在的会话 ID 一律 `Error: Session not found`、exit=1、零 stdout（→ error finish → 空气泡路径成立），但 `test/unit/adapter.test.mjs` 回归测试证明 adapter **从未**把 DSH 的 `sessionId` 透传给 CLI（DSH `sessionId` 仅用于 G10 workspace 解析）。假设被证伪，测试留作护栏。
3. **超时掐断** —— `DEFAULT_TIMEOUTS` firstEvent 45s / idle 300s 足够宽。
4. **上游 `text` 粒度** —— 实锤整段一次性（非增量），与空输出无关。

未决候选（待取证日志定论）：

- A. DSH system 提示词 + 工具诱导 → 模型空响应 / 纯工具响应（`TOOL_ONLY_RESPONSE` / `EMPTY_RESPONSE` / `reason:"unknown"`）→ 零正文 + error/tool-calls finish；
- B. G10 workspace 解析到无效目录 → `WORKSPACE_INVALID` error finish；
- C. 真实请求里出现 mapper 不认识的事件类型，正文被当 unknown 丢弃；
- D. **（2026-10-18 新增，ISSUE-005）** `opencode.exe`（Bun 1.3.14）间歇段错误：LLM 流式调用中途崩溃、exit 3、零 stdout → `PROTOCOL_ERROR` error finish → 空气泡。判定方法：`diagnostics.log` 对应轮次是否含 `Bun has crashed` 崩溃横幅（含则即此候选，与 A/B/C 无关）。

取证设施（commit `bf041d8`）：`~/.dsh-opencode-bridge/requests.log`（每请求 start/end 摘要）、`last-request.md`（最近一次完整 prompt 原文，供离线精确复现）、`diagnostics.log`（协议行/未知事件/stderr）。

### 根因定论（2026-10-18 实机取证）

**候选 A 实锤：纯工具轮零正文 = 空气泡主因。** 17:08 实机轮（"我正在进行插件测试，你看一下工作区内容"）取证：

```text
start ... effort=high promptChars=18756
end   ... durationMs=33035 textChars=0 finish=tool-calls
```

链路：问工作区类问题 → 模型发起工具调用（想读文件/跑命令）→ 桥是纯文本通道、`tool` 事件被转换层静默丢弃（`to-dsh-chunks.ts` 原 `case "tool": return []`）→ 零正文 + `finish(tool-calls)` 且**无 tool-call 块** → DSH 渲染「已完成，用时 33 秒」+ 空气泡。这解释了「问工作区必现、闲聊正常」的触发分布——**工具诱导才是开关**。同 session 15:36 轮的 TIMEOUT/PROTOCOL_ERROR 空气泡则属候选 D（ISSUE-005 上游 Bun 崩溃），`diagnostics.log` 有 `Bun has crashed` 横幅为证。候选 B/C 继续保持排除状态。

## 修复方案（修复后填写）

三层修复（2026-10-18，`feature/model-exposure-settings` 分支）：

1. **prompt 层禁用工具（治本）**：`src/prompt.ts` 的 `buildPrompt({ textOnly: true })`（`src/adapter.ts` 调用）在 prompt 最末追加 `TEXT_ONLY_NOTICE`——明确告知模型「没有可用工具、禁止工具调用、直接文字作答」。纯工具轮从源头被抑制；空输入不追加（保住「空请求不 spawn」守卫）。
2. **零正文工具轮合成兜底（保险）**：`src/to-dsh-chunks.ts` 的 `DshChunkConverter` 记录 `tool` 事件里的工具名；收尾时若「零正文 + finish(tool-calls)」，合成一段透明说明文本（点名工具、声明不支持工具转发、请改文字提问）并以 `finish(stop)` 正常收尾——气泡永远有内容，且 DSH 不再悬在「tool-calls 但无 tool-call 块」的语义上。取消（abort）路径不合成，保留 aborted 明确终态。
3. **重试降噪（连带）**：见 ISSUE-006，`providerRetryPolicy` 收紧为最多 1 次重试。

**验证**：单测 202 条全绿（含 4 条新兜底用例：合成内容/工具名去重/无工具事件兜底/有正文不误伤；1 条 prompt 禁用工具用例；abort 不误合成回归）。待实机复验：再问一次「你看一下工作区内容」应得到文字回答或合成说明，不再空气泡。

**遗留（后续项）**：工具调用转发（把 OC `tool_use` 映射成 DSH `tool-call` 块 + 结果回灌），届时 DSH 自身的工具循环可真正接管工作区访问（TODO-17 双重 Agent 边界的正解），本兜底随之退场。

## 演进（2026-10-18 解禁批，架构原则「工具面归属由架构决定」）

后续架构决策推翻了修复方案第 1 层的前提：**主会话模式下 OC 回合应自动使用 OC 自己的工具**（DSH 工具结构上不可达，tool-call 块不过桥；工具面归属 OC）。据此：

1. **第 1 层（prompt 禁用工具）退役**：`TEXT_ONLY_NOTICE` 与 `textOnly` 参数从 `src/prompt.ts` 删除，prompt 恒不做任何工具声明。它防的不是 DSH 工具（结构上不可能），而是 OC 自有工具的**不可见执行**——该职责改由第 2 层升级承接。
2. **第 2 层升级为「工具事件回流」**：`to-dsh-chunks.ts` 不再丢弃 `tool` 事件，`tool_use` 回流为可见进度块（`🔧 <工具名>`，callID 去重、tool_result 不重复）；刻意不产 tool-call 块（避免 DSH 拾起自己的工具循环）。原「合成说明」降级为**零文本保险**（仅防全程零正文，去「不支持工具转发」异常叙事）。
3. **取证字段 `notice=` 退役**（`src/plugin.ts` requests.log 起始行）。
4. **超时放宽**（配套）：`DEFAULT_TIMEOUTS` idle 300s→600s、total 600s→1800s（工具执行可长时间无事件；完整 agent run 达数十分钟），spec §8.1 同步。
5. TODO-17（工具转发）降级为 non-goal：按工具面归属原则，OC 永不调用 DSH 工具。

**验证**：单测 207 条全绿（原 4 条兜底用例翻转为进度回流/零文本保险语义，新增 callID 去重与 tool_result 不重复用例）；QA 判分语义同步翻转（工具执行 + 🔧 进度可见 = 通过，空气泡 = 回归）。
