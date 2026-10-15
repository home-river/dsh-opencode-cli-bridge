# @home-river/dsh-opencode-bridge

一个面向 DeepSeek Harness（DSH）的最小原生 `LlmAdapter` 插件工程，目标是先打通 **DSH → OpenCode 兼容流式接口** 的文本请求链路。

本项目借鉴 `@opencode2dsh/dsh-plugin` 的适配器机制，但只实现可独立验证的 MVP，不包含 IP 池、订阅、sidecar、完整 CLI 流量伪装或插件设置页。

## 当前阶段

当前仅完成工程骨架与目标文档：

- `package.json`：插件包标识和基础脚本。
- `tsconfig.json`：TypeScript 编译边界。
- `docs/GOALS.md`：项目目的、MVP 功能、验收标准与后续实现阶段。

Adapter 实现尚未开始。

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
[ ] 插件入口与配置
[ ] 模型目录与缓存
[ ] DSH LlmAdapter 合同
[ ] OpenCode 流式请求
[ ] 错误、重试与取消
[ ] DSH 实机联调
```
