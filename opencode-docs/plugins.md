# OpenCode Plugins 官方文档（记录）

> 来源：[https://opencode.ai/docs/plugins](https://opencode.ai/docs/plugins)（原文 `packages/web/src/content/docs/plugins.mdx` @ anomalyco/opencode dev 分支）
> 抓取日期：2026-10-17

Plugins allow you to extend OpenCode by hooking into various events and customizing behavior. You can create plugins to add new features, integrate with external services, or modify OpenCode's default behavior.

社区插件示例见 [ecosystem → plugins](https://opencode.ai/docs/ecosystem)。

---

## Use a plugin（使用插件）

两种加载方式。

### From local files

把 JS/TS 文件放进插件目录，启动时自动加载：

- `.opencode/plugins/` — 项目级插件
- `~/.config/opencode/plugins/` — 全局插件

### From npm

在配置文件中声明 npm 包：

```json title="opencode.json"
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-helicone-session", "opencode-wakatime", "@my-org/custom-plugin"]
}
```

支持普通包和 scoped 包。

### How plugins are installed

- **npm 插件**：启动时用 Bun 自动安装，包及依赖缓存在 `~/.cache/opencode/node_modules/`。
- **本地插件**：直接从插件目录加载。要用外部包，需在配置目录放 `package.json`（见下文 Dependencies），或发布到 npm 后写入配置。

### Load order（加载顺序）

所有来源的插件都会加载，所有 hook 按序执行。顺序为：

1. 全局配置（`~/.config/opencode/opencode.json`）
2. 项目配置（`opencode.json`）
3. 全局插件目录（`~/.config/opencode/plugins/`）
4. 项目插件目录（`.opencode/plugins/`）

同名同版本的 npm 包只加载一次；本地插件与同名 npm 插件会分别加载。

---

## Create a plugin（创建插件）

插件是一个 **JS/TS 模块**，导出一个或多个插件函数；每个函数接收 context 对象，返回 hooks 对象。

### Dependencies

本地插件和 custom tool 可用外部 npm 包，在配置目录加 `package.json`：

```json title=".opencode/package.json"
{
  "dependencies": {
    "shescape": "^2.1.0"
  }
}
```

OpenCode 启动时执行 `bun install` 安装。

```ts title=".opencode/plugins/my-plugin.ts"
import { escape } from "shescape"

export const MyPlugin = async (ctx) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash") {
        output.args.command = escape(output.args.command)
      }
    },
  }
}
```

### Basic structure

```js title=".opencode/plugins/example.js"
export const MyPlugin = async ({ project, client, $, directory, worktree }) => {
  console.log("Plugin initialized!")

  return {
    // Hook implementations go here
  }
}
```

插件函数收到的参数：

- `project`：当前项目信息
- `directory`：当前工作目录
- `worktree`：git worktree 路径
- `client`：opencode SDK client，用于与 AI 交互
- `$`：Bun 的 [shell API](https://bun.com/docs/runtime/shell)，执行命令用

### TypeScript support

```ts title="my-plugin.ts"
import type { Plugin } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  return {
    // Type-safe hook implementations
  }
}
```

类型从插件包 `@opencode-ai/plugin` 导入。

### Events（事件/钩子清单）

#### Command Events
- `command.executed`

#### File Events
- `file.edited`
- `file.watcher.updated`

#### Installation Events
- `installation.updated`

#### LSP Events
- `lsp.client.diagnostics`
- `lsp.updated`

#### Message Events
- `message.part.removed`
- `message.part.updated`
- `message.removed`
- `message.updated`

#### Permission Events
- `permission.asked`
- `permission.replied`

#### Server Events
- `server.connected`

#### Session Events
- `session.created`
- `session.compacted`
- `session.deleted`
- `session.diff`
- `session.error`
- `session.idle`
- `session.status`
- `session.updated`

#### Shell Events
- `shell.env`

#### Tool Events
- `tool.execute.before`
- `tool.execute.after`

#### TUI Events
- `tui.prompt.append`
- `tui.command.execute`
- `tui.toast.show`

---

## Examples（官方示例）

### Send notifications（事件通知）

```js title=".opencode/plugins/notification.js"
export const NotificationPlugin = async ({ project, client, $, directory, worktree }) => {
  return {
    event: async ({ event }) => {
      // Send notification on session completion
      if (event.type === "session.idle") {
        await $`osascript -e 'display notification "Session completed!" with title "opencode"'`
      }
    },
  }
}
```

通用事件订阅入口是 `event: async ({ event }) => {...}`，按 `event.type` 分发。

### .env protection（拦截工具调用）

在 `tool.execute.before` 里 `throw` 即可阻断工具执行：

```js title=".opencode/plugins/env-protection.js"
export const EnvProtection = async ({ project, client, $, directory, worktree }) => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "read" && output.args.filePath.includes(".env")) {
        throw new Error("Do not read .env files")
      }
    },
  }
}
```

### Inject environment variables（注入环境变量）

影响所有 shell 执行（AI 工具与用户终端）：

```js title=".opencode/plugins/inject-env.js"
export const InjectEnvPlugin = async () => {
  return {
    "shell.env": async (input, output) => {
      output.env.MY_API_KEY = "secret"
      output.env.PROJECT_ROOT = input.cwd
    },
  }
}
```

### Custom tools（自定义工具）

```ts title=".opencode/plugins/custom-tools.ts"
import { type Plugin, tool } from "@opencode-ai/plugin"

export const CustomToolsPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      mytool: tool({
        description: "This is a custom tool",
        args: {
          foo: tool.schema.string(),
        },
        async execute(args, context) {
          const { directory, worktree } = context
          return `Hello ${args.foo} from ${directory} (worktree: ${worktree})`
        },
      }),
    },
  }
}
```

`tool` helper 创建 opencode 可调用的自定义工具：

- `description`：工具说明
- `args`：Zod schema（`tool.schema.*`）
- `execute`：调用时执行的函数

自定义工具与内置工具并存；**同名时插件工具优先于内置工具**。

### Logging（结构化日志）

用 `client.app.log()` 而不是 `console.log`：

```ts title=".opencode/plugins/my-plugin.ts"
export const MyPlugin = async ({ client }) => {
  await client.app.log({
    body: {
      service: "my-plugin",
      level: "info",
      message: "Plugin initialized",
      extra: { foo: "bar" },
    },
  })
}
```

级别：`debug`、`info`、`warn`、`error`。

### Compaction hooks（上下文压缩钩子）

`experimental.session.compacting` 在 LLM 生成续接摘要**之前**触发，可注入自定义上下文：

```ts title=".opencode/plugins/compaction.ts"
import type { Plugin } from "@opencode-ai/plugin"

export const CompactionPlugin: Plugin = async (ctx) => {
  return {
    "experimental.session.compacting": async (input, output) => {
      // Inject additional context into the compaction prompt
      output.context.push(`
## Custom Context

Include any state that should persist across compaction:
- Current task status
- Important decisions made
- Files being actively worked on
`)
    },
  }
}
```

也可以用 `output.prompt` **整体替换**压缩提示词（此时 `output.context` 被忽略）：

```ts title=".opencode/plugins/custom-compaction.ts"
import type { Plugin } from "@opencode-ai/plugin"

export const CustomCompactionPlugin: Plugin = async (ctx) => {
  return {
    "experimental.session.compacting": async (input, output) => {
      // Replace the entire compaction prompt
      output.prompt = `
You are generating a continuation prompt for a multi-agent swarm session.

Summarize:
1. The current task and its status
2. Which files are being modified and by whom
3. Any blockers or dependencies between agents
4. The next steps to complete the work

Format as a structured prompt that a new agent can use to resume work.
`
    },
  }
}
```
