# ISSUE-001 问"当前工作区的情况"得空气泡（无正文、无报错）

- 状态：open
- 发现日期：2026-10-17
- 相关文件：`src/adapter.ts`、`src/plugin.ts`、`src/map-events.ts`、`src/to-dsh-chunks.ts`

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

## 修复方案（修复后填写）
