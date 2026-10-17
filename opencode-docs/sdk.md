# OpenCode SDK 官方文档（记录）

> 来源：[https://opencode.ai/docs/sdk](https://opencode.ai/docs/sdk)（原文 `packages/web/src/content/docs/sdk.mdx` @ anomalyco/opencode dev 分支）
> 抓取日期：2026-10-17

The opencode JS/TS SDK provides a type-safe client for interacting with the server. Use it to build integrations and control opencode programmatically.

类型文件（由服务端 OpenAPI 生成）：`packages/sdk/js/src/gen/types.gen.ts` @ anomalyco/opencode。

---

## Install

```bash
npm install @opencode-ai/sdk
```

---

## Create client（创建实例）

```javascript
import { createOpencode } from "@opencode-ai/sdk"

const { client } = await createOpencode()
```

这会同时启动 server 和 client。

| Option | Type | Description | Default |
| --- | --- | --- | --- |
| `hostname` | `string` | Server hostname | `127.0.0.1` |
| `port` | `number` | Server port | `4096` |
| `signal` | `AbortSignal` | 取消信号 | `undefined` |
| `timeout` | `number` | server 启动超时（ms） | `5000` |
| `config` | `Config` | 配置对象 | `{}` |

## Config

```javascript
import { createOpencode } from "@opencode-ai/sdk"

const opencode = await createOpencode({
  hostname: "127.0.0.1",
  port: 4096,
  config: {
    model: "anthropic/claude-3-5-sonnet-20241022",
  },
})

console.log(`Server running at ${opencode.server.url}`)
opencode.server.close()
```

实例仍会读取 `opencode.json`，此配置为内联覆盖/追加。

## Client only（只连已有实例）

```javascript
import { createOpencodeClient } from "@opencode-ai/sdk"

const client = createOpencodeClient({
  baseUrl: "http://localhost:4096",
})
```

| Option | Type | Description | Default |
| --- | --- | --- | --- |
| `baseUrl` | `string` | server URL | `http://localhost:4096` |
| `fetch` | `function` | 自定义 fetch | `globalThis.fetch` |
| `parseAs` | `string` | 响应解析方式 | `auto` |
| `responseStyle` | `string` | 返回风格：`data` 或 `fields` | `fields` |
| `throwOnError` | `boolean` | 出错抛异常而非返回 | `false` |

## Types

```typescript
import type { Session, Message, Part } from "@opencode-ai/sdk"
```

## Errors

```typescript
try {
  await client.session.get({ path: { id: "invalid-id" } })
} catch (error) {
  console.error("Failed to get session:", (error as Error).message)
}
```

---

## Structured Output（结构化输出）

通过 `format` + JSON schema 让模型用 `StructuredOutput` 工具返回符合 schema 的 JSON。

### Basic Usage

```typescript
const result = await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [{ type: "text", text: "Research Anthropic and provide company info" }],
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          company: { type: "string", description: "Company name" },
          founded: { type: "number", description: "Year founded" },
          products: {
            type: "array",
            items: { type: "string" },
            description: "Main products",
          },
        },
        required: ["company", "founded"],
      },
    },
  },
})

console.log(result.data.info.structured_output)
// { company: "Anthropic", founded: 2021, products: ["Claude", "Claude API"] }
```

### Output Format Types

| Type | Description |
| --- | --- |
| `text` | 默认。普通文本回复 |
| `json_schema` | 返回符合所给 schema 的已校验 JSON |

### JSON Schema Format

| Field | Type | Description |
| --- | --- | --- |
| `type` | `'json_schema'` | 必填 |
| `schema` | `object` | 必填，JSON Schema 对象 |
| `retryCount` | `number` | 可选，校验重试次数（默认 2） |

### Error Handling

重试后仍失败时响应含 `StructuredOutputError`：

```typescript
if (result.data.info.error?.name === "StructuredOutputError") {
  console.error("Failed to produce structured output:", result.data.info.error.message)
  console.error("Attempts:", result.data.info.error.retries)
}
```

### Best Practices

1. schema 属性写清 description，帮助模型理解要抽取什么
2. 用 `required` 指定必填字段
3. schema 保持聚焦，复杂嵌套容易填错
4. 按需调整 `retryCount`

---

## APIs

SDK 以类型安全客户端暴露全部 server API。

### Global

| Method | Description | Response |
| --- | --- | --- |
| `global.health()` | 健康检查 | `{ healthy: true, version: string }` |

### App

| Method | Description | Response |
| --- | --- | --- |
| `app.log()` | 写日志 | `boolean` |
| `app.agents()` | 列出 agent | `Agent[]` |

```javascript
await client.app.log({
  body: { service: "my-app", level: "info", message: "Operation completed" },
})
const agents = await client.app.agents()
```

### Project

| Method | Description | Response |
| --- | --- | --- |
| `project.list()` | 列出项目 | `Project[]` |

### Path

| Method | Description | Response |
| --- | --- | --- |
| `path.get()` | 当前路径 | `Path` |

### Config

| Method | Description | Response |
| --- | --- | --- |
| `config.get()` | 配置信息 | `Config` |
| `config.providers()` | provider 及默认模型 | `{ providers: Provider[], default: { [key: string]: string } }` |

### Sessions

| Method | Description | Notes |
| --- | --- | --- |
| `session.list()` | 列出会话 | `Session[]` |
| `session.get({ path })` | 获取会话 | `Session` |
| `session.children({ path })` | 子会话 | `Session[]` |
| `session.create({ body })` | 创建会话 | `Session` |
| `session.delete({ path })` | 删除会话 | `boolean` |
| `session.update({ path, body })` | 更新会话属性 | `Session` |
| `session.init({ path, body })` | 分析应用并生成 `AGENTS.md` | `boolean` |
| `session.abort({ path })` | 中止运行中的会话 | `boolean` |
| `session.share({ path })` / `session.unshare({ path })` | 分享/取消分享 | `Session` |
| `session.summarize({ path, body })` | 摘要会话 | `boolean` |
| `session.messages({ path })` | 列出会话消息 | `{ info: Message, parts: Part[] }[]` |
| `session.message({ path })` | 获取消息详情 | `{ info: Message, parts: Part[] }` |
| `session.prompt({ path, body })` | 发送 prompt | `body.noReply: true` 只注入上下文不回复，返回 UserMessage；默认返回 AssistantMessage。支持 `body.format` 结构化输出 |
| `session.command({ path, body })` | 发送命令 | `{ info: AssistantMessage, parts: Part[] }` |
| `session.shell({ path, body })` | 运行 shell 命令 | `AssistantMessage` |
| `session.revert({ path, body })` | 回滚消息 | `Session` |
| `session.unrevert({ path })` | 恢复回滚 | `Session` |
| `postSessionByIdPermissionsByPermissionId({ path, body })` | 回应权限请求 | `boolean` |

```javascript
const session = await client.session.create({ body: { title: "My session" } })
const sessions = await client.session.list()

const result = await client.session.prompt({
  path: { id: session.id },
  body: {
    model: { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022" },
    parts: [{ type: "text", text: "Hello!" }],
  },
})

// 只注入上下文、不触发 AI 回复（对插件很有用）
await client.session.prompt({
  path: { id: session.id },
  body: {
    noReply: true,
    parts: [{ type: "text", text: "You are a helpful assistant." }],
  },
})
```

### Files

| Method | Description | Response |
| --- | --- | --- |
| `find.text({ query })` | 全文搜索 | match 对象数组（`path`、`lines`、`line_number`、`absolute_offset`、`submatches`） |
| `find.files({ query })` | 按名找文件/目录 | `string[]` |
| `find.symbols({ query })` | 工作区符号搜索 | `Symbol[]` |
| `file.read({ query })` | 读文件 | `{ type: "raw" \| "patch", content: string }` |
| `file.status({ query? })` | 跟踪文件状态 | `File[]` |

`find.files` 可选字段：`type`（`"file"`/`"directory"`）、`directory`（覆盖搜索根）、`limit`（1–200）。

### TUI

| Method | Description | Response |
| --- | --- | --- |
| `tui.appendPrompt({ body })` | 追加文本到提示框 | `boolean` |
| `tui.openHelp()` | 打开帮助 | `boolean` |
| `tui.openSessions()` | 打开会话选择器 | `boolean` |
| `tui.openThemes()` | 打开主题选择器 | `boolean` |
| `tui.openModels()` | 打开模型选择器 | `boolean` |
| `tui.submitPrompt()` | 提交当前提示 | `boolean` |
| `tui.clearPrompt()` | 清空提示 | `boolean` |
| `tui.executeCommand({ body })` | 执行命令 | `boolean` |
| `tui.showToast({ body })` | 显示 toast | `boolean` |

### Auth

| Method | Description | Response |
| --- | --- | --- |
| `auth.set({ ... })` | 设置凭据 | `boolean` |

```javascript
await client.auth.set({
  path: { id: "anthropic" },
  body: { type: "api", key: "your-api-key" },
})
```

### Events

| Method | Description | Response |
| --- | --- | --- |
| `event.subscribe()` | SSE 事件流 | server-sent events stream |

```javascript
const events = await client.event.subscribe()
for await (const event of events.stream) {
  console.log("Event:", event.type, event.properties)
}
```
