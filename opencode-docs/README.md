# OpenCode 官方文档记录（联网抓取归档）

> 抓取日期：2026-10-17
> 来源：官方文档站 [opencode.ai/docs](https://opencode.ai/docs/) 及其文档源仓库 `github.com/anomalyco/opencode`（`packages/web/src/content/docs/*.mdx`，dev 分支）。
> 用途：为 `dsh-opencode-bridge` 的开发与联调提供离线可查的官方 API/CLI 参考（随本项目存放）。

## ⚠️ 版本提示

官方文档目前首页有横幅 **"New OpenCode v2 is now available"**（`https://opencode.ai/v2`）。本目录记录的是 **v1（经典线）文档**，即 `opencode.ai/docs/*` 路径下的内容（CLI / Plugins / SDK / Server）。v2 文档在 `opencode.ai/v2/docs/*`，接口可能有差异，联调前请先确认本地安装的 opencode 版本属于哪条线。另注意：官方仓库已从 `sst/opencode` 迁移为 `anomalyco/opencode`，文档内链接以新仓库为准。

## 目录

| 文件 | 内容 | 对插件开发的作用 |
|---|---|---|
| [cli.md](cli.md) | CLI 全部命令、全局 Flags、环境变量 | `dsh-opencode-bridge` 的 CliBridge 直接依赖 `opencode run/serve` 的参数与输出格式 |
| [plugins.md](plugins.md) | OpenCode 插件体系：加载方式、钩子事件、示例 | 写 OpenCode 侧插件（hook / custom tool）的核心参考 |
| [sdk.md](sdk.md) | `@opencode-ai/sdk` JS/TS 客户端 | 插件内 `client` 对象的能力来源；结构化输出（structured output） |
| [server.md](server.md) | `opencode serve` HTTP/OpenAPI 接口全表 | headless 集成、事件 SSE 流、会话/消息 API |

## 与本工作区的关联速记

- **`dsh-opencode-bridge`（LlmAdapter 桥接）**：
  - 非交互调用首选 `opencode run --format json`（原始 JSON 事件流），见 [cli.md → run](cli.md#run)。
  - 常驻服务模式用 `opencode serve`（默认端口 4096）+ `opencode run --attach http://localhost:4096`，避免 MCP 冷启动开销。
  - 事件订阅：`GET /event`（SSE），会话/消息 API 见 [server.md](server.md)。
- **写 OpenCode 插件**：本地插件放 `.opencode/plugins/`（项目级）或 `~/.config/opencode/plugins/`（全局）；npm 插件写进 `opencode.json` 的 `"plugin"` 数组。钩子清单见 [plugins.md → Events](plugins.md#events)。
- **权限**：`opencode run --auto` 自动批准未显式拒绝的权限，headless 场景常用。
