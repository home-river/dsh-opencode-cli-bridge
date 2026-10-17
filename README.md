# @home-river/dsh-opencode-bridge

一个面向 DeepSeek Harness（DSH）的最小原生 `LlmAdapter` 插件工程，目标是先打通 **DSH → OpenCode 兼容流式接口** 的文本请求链路。

本项目借鉴 `@opencode2dsh/dsh-plugin` 的适配器机制，但只实现可独立验证的 MVP，不包含 IP 池、订阅、sidecar、完整 CLI 流量伪装或插件设置页。

## 当前阶段

CliBridge（OC → 插件段）已完成：CLI 四级发现、进程壳（spawn/stdio 分流）、JSON Lines 解析、事件归一化、错误分类、五层超时、取消与 Windows 进程树清理，并通过单测 103 条与真实 CLI 集成测试（R01–R08、R11）。DSH StreamChunk 转换器（子项目 2）已完成，`streamDshChunks` 端到端入口 + fake CLI 端到端测试全绿。下一步是 DSH 插件段（`LlmAdapter` 合同、模型目录与缓存）。

- `src/`：CliBridge 模块（`types` / `errors` / `parse-lines` / `map-events` / `discover-cli` / `run-cli` / `cli-bridge` / `index`）。
- `test/`：fake CLI 单测（`node:test`，零 runtime 依赖）+ 真实 CLI 集成测试（`OCBRIDGE_IT=1` 时启用）。
- `docs/GOALS.md`：项目目的、MVP 功能、验收标准与后续实现阶段。

## 计划中的请求链路

```text
DSH 会话
  → DSH LLM 服务
  → opencode-bridge LlmAdapter
  → OpenCode 模型目录
  → OpenCode-compatible 流式接口
  → DSH text-delta / usage / finish
```

## MVP 范围

MVP 目标是：

1. 在 DSH 中注册 `opencode-bridge` provider；
2. 发现并展示至少一个可用的 OpenCode 免费模型；
3. 将 DSH 纯文本请求转换为 OpenAI-compatible 流式请求；
4. 将上游流式响应转换回 DSH 事件；
5. 完成错误分类、临时错误重试与取消传播；
6. 网络或上游故障不导致 DSH 主进程崩溃。

完整设计与验收条件见 [`docs/GOALS.md`](./docs/GOALS.md)。

## 开发状态

```text
[x] 工程目录
[x] 包与 TypeScript 基础配置
[x] 目的和目标功能实现文档
[x] CliBridge：CLI 发现 / spawn / JSON Lines 解析 / 事件归一化
[x] CliBridge：错误分类 / 五层超时 / 取消与进程树清理
[x] 测试：fake CLI 单测 + 真实 CLI 集成测试
[ ] DSH LlmAdapter 合同
[ ] 插件入口与配置
[x] DSH StreamChunk 转换（切块模拟流式，多 finish 折叠）
[ ] 模型目录与缓存
[ ] DSH 实机联调
```
