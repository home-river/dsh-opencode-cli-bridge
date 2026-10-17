# OpenCode Server 官方文档（记录）

> 来源：[https://opencode.ai/docs/server](https://opencode.ai/docs/server)（原文 `packages/web/src/content/docs/server.mdx` @ anomalyco/opencode dev 分支，页面标注 Last updated: Oct 16, 2026）
> 抓取日期：2026-10-17

`opencode serve` 运行 headless HTTP server，暴露 OpenAPI 端点供 opencode 客户端使用。

## Usage

```bash
opencode serve [--port <number>] [--hostname <string>] [--cors <origin>]
```

| Flag | Description | Default |
| --- | --- | --- |
| `--port` | 监听端口 | `4096` |
| `--hostname` | 监听地址 | `127.0.0.1` |
| `--mdns` | 启用 mDNS 发现 | `false` |
| `--mdns-domain` | mDNS 自定义域名 | `opencode.local` |
| `--cors` | 额外允许的浏览器 origin | `[]` |

`--cors` 可传多次：

```bash
opencode serve --cors http://localhost:5173 --cors https://app.example.com
```

## Authentication

设置 `OPENCODE_SERVER_PASSWORD` 启用 HTTP basic auth；用户名默认 `opencode`，可用 `OPENCODE_SERVER_USERNAME` 覆盖。对 `serve` 和 `web` 都生效。

```bash
OPENCODE_SERVER_PASSWORD=your-password opencode serve
```

## How it works

运行 `opencode` 时会同时启动 TUI 与 server，TUI 是 server 的客户端。server 暴露 OpenAPI 3.1 spec，SDK 也由此生成。`opencode serve` 可启动独立 server（即使 TUI 在跑也会另起一个）。

TUI 启动时随机分配端口和 hostname；可传 `--hostname`/`--port` 固定，再用其他客户端连接。`/tui` 端点可远程驱动 TUI（如预填/提交 prompt），IDE 插件即此用法。

## Spec

OpenAPI 3.1 规范：`http://<hostname>:<port>/doc`（如 `http://localhost:4096/doc`），可用于生成客户端或在 Swagger 里查看。

---

## APIs

### Global

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| `GET` | `/global/health` | 健康与版本 | `{ healthy: true, version: string }` |
| `GET` | `/global/event` | 全局事件（SSE 流） | Event stream |

### Project

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| `GET` | `/project` | 列出所有项目 | `Project[]` |
| `GET` | `/project/current` | 当前项目 | `Project` |

### Path & VCS

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| `GET` | `/path` | 当前路径 | `Path` |
| `GET` | `/vcs` | 当前项目 VCS 信息 | `VcsInfo` |

### Instance

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| `POST` | `/instance/dispose` | 释放当前实例 | `boolean` |

### Config

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| `GET` | `/config` | 配置信息 | `Config` |
| `PATCH` | `/config` | 更新配置 | `Config` |
| `GET` | `/config/providers` | provider 与默认模型 | `{ providers: Provider[], default: { [key: string]: string } }` |

### Provider

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| `GET` | `/provider` | 列出所有 provider | `{ all: Provider[], default: {...}, connected: string[] }` |
| `GET` | `/provider/auth` | provider 认证方式 | `{ [providerID: string]: ProviderAuthMethod[] }` |
| `POST` | `/provider/{id}/oauth/authorize` | OAuth 授权 | `ProviderAuthAuthorization` |
| `POST` | `/provider/{id}/oauth/callback` | OAuth 回调 | `boolean` |

### Sessions

| Method | Path | Description | Notes |
| --- | --- | --- | --- |
| `GET` | `/session` | 列出会话 | `Session[]` |
| `POST` | `/session` | 创建会话 | body `{ parentID?, title? }`，返回 `Session` |
| `GET` | `/session/status` | 所有会话状态 | `{ [sessionID: string]: SessionStatus }` |
| `GET` | `/session/:id` | 会话详情 | `Session` |
| `DELETE` | `/session/:id` | 删除会话及其数据 | `boolean` |
| `PATCH` | `/session/:id` | 更新会话属性 | body `{ title? }`，返回 `Session` |
| `GET` | `/session/:id/children` | 子会话 | `Session[]` |
| `POST` | `/session/:id/init` | 分析应用并生成 `AGENTS.md` | body `{ messageID, providerID, modelID }`，返回 `boolean` |
| `POST` | `/session/:id/fork` | 在某消息处 fork 会话 | body `{ messageID? }`，返回 `Session` |
| `POST` | `/session/:id/abort` | 中止运行中的会话 | `boolean` |
| `GET` | `/session/:id/diff` | 会话 diff | query `messageID?`，返回 `FileDiff[]` |
| `POST` | `/session/:id/summarize` | 摘要会话 | body `{ providerID, modelID }`，返回 `boolean` |
| `POST` | `/session/:id/revert` | 回滚消息 | body `{ messageID, partID? }`，返回 `boolean` |
| `POST` | `/session/:id/unrevert` | 恢复全部回滚 | `boolean` |
| `POST` | `/session/:id/permissions/:permissionID` | 回应权限请求 | body `{ response, remember? }`，返回 `boolean` |

### Messages

| Method | Path | Description | Notes |
| --- | --- | --- | --- |
| `GET` | `/session/:id/message` | 列出消息 | query `limit?`，返回 `{ info: Message, parts: Part[] }[]` |
| `POST` | `/session/:id/message` | 发消息并等待回复 | body `{ messageID?, model?, agent?, noReply?, system?, tools?, parts }`，返回 `{ info: Message, parts: Part[] }` |
| `GET` | `/session/:id/message/:messageID` | 消息详情 | `{ info: Message, parts: Part[] }` |
| `POST` | `/session/:id/prompt_async` | 异步发消息（不等待） | body 同上，返回 `204 No Content` |
| `POST` | `/session/:id/command` | 执行斜杠命令 | body `{ messageID?, agent?, model?, command, arguments }` |
| `POST` | `/session/:id/shell` | 运行 shell 命令 | body `{ agent, model?, command }` |

### Commands

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| `GET` | `/command` | 列出命令 | `Command[]` |

### Files

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| `GET` | `/find?pattern=<pat>` | 全文搜索 | match 对象数组（`path`、`lines`、`line_number`、`absolute_offset`、`submatches`） |
| `GET` | `/find/file?query=<q>` | 按名找文件/目录 | `string[]` |
| `GET` | `/find/symbol?query=<q>` | 工作区符号搜索 | `Symbol[]` |
| `GET` | `/file?path=<path>` | 列出文件/目录 | `FileNode[]` |
| `GET` | `/file/content?path=<p>` | 读文件 | `FileContent` |
| `GET` | `/file/status` | 跟踪文件状态 | `File[]` |

`/find/file` query 参数：

- `query`（必填）— 搜索串（模糊匹配）
- `type`（可选）— `"file"` 或 `"directory"`
- `directory`（可选）— 覆盖搜索的项目根
- `limit`（可选）— 最大结果数（1–200）
- `dirs`（可选）— 旧标志（`"false"` 只返回文件）

### Tools (Experimental)

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| `GET` | `/experimental/tool/ids` | 列出全部工具 ID | `ToolIDs` |
| `GET` | `/experimental/tool?provider=<p>&model=<m>` | 某模型的工具及 JSON schema | `ToolList` |

### LSP, Formatters & MCP

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| `GET` | `/lsp` | LSP server 状态 | `LSPStatus[]` |
| `GET` | `/formatter` | 格式化器状态 | `FormatterStatus[]` |
| `GET` | `/mcp` | MCP server 状态 | `{ [name: string]: MCPStatus }` |
| `POST` | `/mcp` | 动态添加 MCP server | body `{ name, config }`，返回 MCP 状态对象 |

### Agents

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| `GET` | `/agent` | 列出可用 agent | `Agent[]` |

### Logging

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| `POST` | `/log` | 写日志。body `{ service, level, message, extra? }` | `boolean` |

### TUI

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| `POST` | `/tui/append-prompt` | 追加文本到提示框 | `boolean` |
| `POST` | `/tui/open-help` | 打开帮助 | `boolean` |
| `POST` | `/tui/open-sessions` | 打开会话选择器 | `boolean` |
| `POST` | `/tui/open-themes` | 打开主题选择器 | `boolean` |
| `POST` | `/tui/open-models` | 打开模型选择器 | `boolean` |
| `POST` | `/tui/submit-prompt` | 提交当前提示 | `boolean` |
| `POST` | `/tui/clear-prompt` | 清空提示 | `boolean` |
| `POST` | `/tui/execute-command` | 执行命令（`{ command }`） | `boolean` |
| `POST` | `/tui/show-toast` | 显示 toast（`{ title?, message, variant }`） | `boolean` |
| `GET` | `/tui/control/next` | 等待下一个控制请求 | Control request 对象 |
| `POST` | `/tui/control/response` | 回应控制请求（`{ body }`） | `boolean` |

### Auth

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| `PUT` | `/auth/:id` | 设置凭据，body 需符合 provider schema | `boolean` |

### Events

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| `GET` | `/event` | SSE 事件流。首个事件为 `server.connected`，随后是 bus 事件 | server-sent events stream |

### Docs

| Method | Path | Description | Response |
| --- | --- | --- | --- |
| `GET` | `/doc` | OpenAPI 3.1 规范 | HTML 页（OpenAPI spec） |

> 类型定义（`Session`、`Message`、`Part`、`Provider` 等）统一见 SDK 生成的类型文件：`packages/sdk/js/src/gen/types.gen.ts` @ anomalyco/opencode（dev 分支）。
