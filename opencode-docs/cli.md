# OpenCode CLI 官方文档（记录）

> 来源：[https://opencode.ai/docs/cli](https://opencode.ai/docs/cli)（原文 `packages/web/src/content/docs/cli.mdx` @ anomalyco/opencode dev 分支）
> 抓取日期：2026-10-17

OpenCode CLI options and commands.

不带参数运行 `opencode` 默认启动 [TUI](https://opencode.ai/docs/tui)：

```bash
opencode
```

它也接受子命令，可以编程方式交互：

```bash
opencode run "Explain how closures work in JavaScript"
```

---

## tui

启动 OpenCode 终端 UI。

```bash
opencode [project]
```

### Flags

| Flag | Short | Description |
| --- | --- | --- |
| `--continue` | `-c` | Continue the last session |
| `--session` | `-s` | Session ID to continue |
| `--fork` |  | Fork the session when continuing (use with `--continue` or `--session`) |
| `--prompt` |  | Prompt to use |
| `--model` | `-m` | Model to use in the form of provider/model |
| `--agent` |  | Agent to use |
| `--auto` |  | Auto-approve permissions that are not explicitly denied |
| `--port` |  | Port to listen on |
| `--hostname` |  | Hostname to listen on |
| `--mdns` |  | Enable mDNS discovery |
| `--mdns-domain` |  | Custom mDNS domain name |
| `--cors` |  | Additional browser origin(s) to allow CORS |

---

## Commands

### agent

管理 agent。

```bash
opencode agent [command]
```

#### create

创建带自定义配置的新 agent（交互式引导，自定义 system prompt 与权限；未允许的权限在生成的 frontmatter 中一律 deny）。

```bash
opencode agent create
```

##### Flags

| Flag | Short | Description |
| --- | --- | --- |
| `--path` |  | 写入 agent 文件的目录（默认全局或 `.opencode/agent`） |
| `--description` |  | 该 agent 做什么 |
| `--mode` |  | Agent 模式：`all`、`primary` 或 `subagent` |
| `--permissions` |  | 逗号分隔的允许权限（默认全部）。可选：`bash`、`read`、`edit`、`glob`、`grep`、`webfetch`、`task`、`websearch`、`lsp`、`skill`；省略即 deny。别名：`--tools` |
| `--model` | `-m` | `provider/model` 格式的模型 |

同时传入 `--path`、`--description`、`--mode`、`--permissions` 可完全非交互运行。

#### list

```bash
opencode agent list
```

---

### attach

把终端挂到已由 `serve`/`web` 启动的后端服务器上（用 TUI 操作远程后端）。

```bash
opencode attach [url]
```

```bash
# 一个终端启动后端
opencode web --port 4096 --hostname 0.0.0.0
# 另一个终端把 TUI 挂上去
opencode attach http://10.20.30.40:4096
```

##### Flags

| Flag | Short | Description |
| --- | --- | --- |
| `--dir` |  | TUI 启动的工作目录 |
| `--continue` | `-c` | 继续最近一次会话 |
| `--session` | `-s` | 指定继续的会话 ID |
| `--fork` |  | 继续时 fork 会话 |
| `--password` | `-p` | Basic auth 密码（默认 `OPENCODE_SERVER_PASSWORD`） |
| `--username` | `-u` | Basic auth 用户名（默认 `OPENCODE_SERVER_USERNAME` 或 `opencode`） |

---

### auth

管理 provider 凭据与登录。

```bash
opencode auth [command]
```

#### login

OpenCode 使用 [Models.dev](https://models.dev) 的 provider 列表；`opencode auth login` 配置任意 provider 的 API key，存于 `~/.local/share/opencode/auth.json`。启动时加载凭据文件、环境变量及项目 `.env` 中的 key。

```bash
opencode auth login
```

| Flag | Short | Description |
| --- | --- | --- |
| `--provider` | `-p` | 要登录的 Provider ID 或名称 |
| `--method` | `-m` | 跳过方法选择，直接用指定登录方式 |

#### list / ls

```bash
opencode auth list
opencode auth ls
```

#### logout

```bash
opencode auth logout
```

---

### github

管理仓库自动化的 GitHub agent。

```bash
opencode github [command]
```

- `opencode github install` — 安装 GitHub Actions workflow 并引导配置
- `opencode github run` — 运行 GitHub agent（通常在 GitHub Actions 中）
  - `--event`：GitHub mock event
  - `--token`：GitHub personal access token

---

### mcp

管理 Model Context Protocol 服务器。

```bash
opencode mcp [command]
```

- `opencode mcp add` — 引导添加本地或远程 MCP server
- `opencode mcp list` / `opencode mcp ls` — 列出配置的 MCP server 及连接状态
- `opencode mcp auth [name]` — 对启用 OAuth 的 MCP server 认证；`opencode mcp auth list`（`ls`）列出可 OAuth 的 server 及认证状态
- `opencode mcp logout [name]` — 移除某 MCP server 的 OAuth 凭据
- `opencode mcp debug <name>` — 调试某 MCP server 的 OAuth 连接问题

---

### models

列出已配置 provider 的全部可用模型（`provider/model` 格式），可选传 provider ID 过滤。

```bash
opencode models [provider]
opencode models anthropic
```

| Flag | Description |
| --- | --- |
| `--refresh` | 从 models.dev 刷新模型缓存 |
| `--verbose` | 更详细输出（含成本等元数据） |

---

### run

**非交互模式**，直接传 prompt 运行。适用于脚本、自动化、快速问答。

```bash
opencode run [message..]
opencode run Explain the use of context in Go
```

可 attach 到已运行的 `opencode serve` 实例，避免每次 run 都冷启动 MCP server：

```bash
# 一个终端起 headless server
opencode serve
# 另一个终端 attach 运行
opencode run --attach http://localhost:4096 "Explain async/await in JavaScript"
```

##### Flags

| Flag | Short | Description |
| --- | --- | --- |
| `--command` |  | 要执行的命令，message 作为其参数 |
| `--continue` | `-c` | 继续最近一次会话 |
| `--session` | `-s` | 指定继续的会话 ID |
| `--fork` |  | 继续时 fork 会话 |
| `--model` | `-m` | `provider/model` 格式的模型 |
| `--agent` |  | 使用的 agent |
| `--file` | `-f` | 附加到消息的文件（可多个） |
| `--format` |  | `default`（格式化）或 `json`（原始 JSON 事件流） |
| `--title` |  | 会话标题（缺省用截断的 prompt） |
| `--attach` |  | attach 到运行中的 opencode server（如 http://localhost:4096） |
| `--password` | `-p` | Basic auth 密码（默认 `OPENCODE_SERVER_PASSWORD`） |
| `--username` | `-u` | Basic auth 用户名（默认 `OPENCODE_SERVER_USERNAME` 或 `opencode`） |
| `--dir` |  | 运行目录；attach 时为远端服务器上的路径 |
| `--port` |  | 本地 server 端口（默认随机） |
| `--variant` |  | 模型变体（provider 相关的 reasoning effort） |
| `--thinking` |  | 显示 thinking 块 |
| `--auto` |  | 自动批准未显式拒绝的权限 |

> **桥接开发要点**：`--format json` 输出原始 JSON 事件，是 `dsh-opencode-bridge` 解析流式输出的抓手；`--auto` 用于 headless 场景放行权限；`--variant` 对应 provider 的 reasoning effort（可映射 DSH 的 reasoning_effort）。

---

### serve

启动 headless HTTP server 供 API 访问（完整 HTTP 接口见 [server.md](server.md)）。

```bash
opencode serve
```

设置 `OPENCODE_SERVER_PASSWORD` 启用 HTTP basic auth（用户名默认 `opencode`）。

| Flag | Description |
| --- | --- |
| `--port` | 监听端口 |
| `--hostname` | 监听地址 |
| `--mdns` | 启用 mDNS 发现 |
| `--mdns-domain` | 自定义 mDNS 域名 |
| `--cors` | 额外允许的浏览器 origin |

---

### session

管理会话。

- `opencode session list` — 列出所有会话
  - `--max-count` / `-n`：只取最近 N 条
  - `--format`：`table` 或 `json`（默认 table）
- `opencode session delete <sessionID>` — 删除会话

---

### stats

显示 token 用量与费用统计。

| Flag | Description |
| --- | --- |
| `--days` | 最近 N 天（默认全部时间） |
| `--tools` | 显示前 N 个工具（默认全部） |
| `--models` | 模型用量明细（默认隐藏），传数字显示 Top N |
| `--project` | 按项目过滤（默认全部；空字符串=当前项目） |

---

### export / import

```bash
opencode export [sessionID]   # 不传 ID 则交互选择；--sanitize 脱敏
opencode import <file>        # 从 JSON 导入会话
opencode import session.json
```

---

### web

启动带 Web 界面的 headless server 并打开浏览器。同样支持 `OPENCODE_SERVER_PASSWORD` basic auth。

Flags 同 `serve`（`--port`、`--hostname`、`--mdns`、`--mdns-domain`、`--cors`）。

---

### acp

启动 ACP（Agent Client Protocol）server，通过 stdin/stdout 用 nd-JSON 通信。

| Flag | Description |
| --- | --- |
| `--cwd` | 工作目录 |
| `--port` / `--hostname` / `--mdns` / `--mdns-domain` / `--cors` | 同上 |

---

### plugin

安装插件并更新配置（别名 `opencode plug <module>`）。

```bash
opencode plugin <module>
```

| Flag | Short | Description |
| --- | --- | --- |
| `--global` | `-g` | 安装到全局配置 |
| `--force` | `-f` | 替换已存在的插件版本 |

---

### pr

拉取并 checkout 某个 GitHub PR 分支，然后启动 OpenCode。

```bash
opencode pr <number>
```

---

### db

数据库工具。

```bash
opencode db [query]    # --format: json | tsv
opencode db path       # 打印数据库路径
```

---

### debug

调试与故障排查工具。

```bash
opencode debug [command]
```

---

### uninstall

卸载 OpenCode 并清理相关文件。

| Flag | Short | Description |
| --- | --- | --- |
| `--keep-config` | `-c` | 保留配置文件 |
| `--keep-data` | `-d` | 保留会话数据与快照 |
| `--dry-run` |  | 只显示将删除的内容 |
| `--force` | `-f` | 跳过确认 |

---

### upgrade

升级到最新版或指定版本。

```bash
opencode upgrade            # 最新版
opencode upgrade v0.1.48    # 指定版本
```

| Flag | Short | Description |
| --- | --- | --- |
| `--method` | `-m` | 安装方式：curl、npm、pnpm、bun、brew |

---

## Global Flags（全局标志）

| Flag | Short | Description |
| --- | --- | --- |
| `--help` | `-h` | 显示帮助 |
| `--version` | `-v` | 打印版本号 |
| `--print-logs` |  | 日志输出到 stderr |
| `--log-level` |  | 日志级别（DEBUG、INFO、WARN、ERROR） |
| `--pure` |  | 不加载外部插件运行 |

---

## Environment variables（环境变量）

| Variable | Type | Description |
| --- | --- | --- |
| `OPENCODE_GIT_BASH_PATH` | string | Windows 上 Git Bash 可执行文件路径 |
| `OPENCODE_CONFIG` | string | 配置文件路径 |
| `OPENCODE_TUI_CONFIG` | string | TUI 配置文件路径 |
| `OPENCODE_CONFIG_DIR` | string | 配置目录路径 |
| `OPENCODE_CONFIG_CONTENT` | string | 内联 JSON 配置内容 |
| `OPENCODE_DISABLE_AUTOUPDATE` | boolean | 禁用自动更新检查 |
| `OPENCODE_DISABLE_PRUNE` | boolean | 禁用旧数据清理 |
| `OPENCODE_DISABLE_TERMINAL_TITLE` | boolean | 禁用自动更新终端标题 |
| `OPENCODE_PERMISSION` | string | 内联 JSON 权限配置 |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS` | boolean | 禁用默认插件 |
| `OPENCODE_DISABLE_LSP_DOWNLOAD` | boolean | 禁用自动下载 LSP server |
| `OPENCODE_ENABLE_EXPERIMENTAL_MODELS` | boolean | 启用实验性模型 |
| `OPENCODE_DISABLE_AUTOCOMPACT` | boolean | 禁用自动上下文压缩 |
| `OPENCODE_DISABLE_CLAUDE_CODE` | boolean | 禁用读取 `.claude`（prompt + skills） |
| `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` | boolean | 禁用读取 `~/.claude/CLAUDE.md` |
| `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` | boolean | 禁用加载 `.claude/skills` |
| `OPENCODE_DISABLE_MODELS_FETCH` | boolean | 禁用从远端获取模型列表 |
| `OPENCODE_DISABLE_MOUSE` | boolean | 禁用 TUI 鼠标捕获 |
| `OPENCODE_FAKE_VCS` | string | 测试用假 VCS provider |
| `OPENCODE_CLIENT` | string | 客户端标识（默认 `cli`） |
| `OPENCODE_ENABLE_EXA` | boolean | 启用 Exa 联网搜索工具 |
| `OPENCODE_ENABLE_PARALLEL` | boolean | 启用 Parallel 联网搜索工具 |
| `OPENCODE_SERVER_PASSWORD` | string | 为 `serve`/`web` 启用 basic auth |
| `OPENCODE_SERVER_USERNAME` | string | 覆盖 basic auth 用户名（默认 `opencode`） |
| `OPENCODE_MODELS_URL` | string | 自定义模型配置拉取 URL |

### Experimental（实验性，可能变更或移除）

| Variable | Type | Description |
| --- | --- | --- |
| `OPENCODE_EXPERIMENTAL` | boolean | 实验特性总开关 |
| `OPENCODE_EXPERIMENTAL_ICON_DISCOVERY` | boolean | 启用 icon discovery |
| `OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT` | boolean | 禁用 TUI 选中即复制 |
| `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` | number | bash 命令默认超时（毫秒） |
| `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` | number | LLM 回复最大输出 token |
| `OPENCODE_EXPERIMENTAL_FILEWATCHER` | boolean | 对整个目录启用文件监视 |
| `OPENCODE_EXPERIMENTAL_OXFMT` | boolean | 启用 oxfmt 格式化器 |
| `OPENCODE_EXPERIMENTAL_LSP_TOOL` | boolean | 启用实验性 LSP 工具 |
| `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER` | boolean | 禁用文件监视 |
| `OPENCODE_EXPERIMENTAL_EXA` | boolean | 启用实验性 Exa 特性 |
| `OPENCODE_EXPERIMENTAL_LSP_TY` | boolean | Python 文件启用 TY LSP |
| `OPENCODE_EXPERIMENTAL_PLAN_MODE` | boolean | 启用 plan mode |
| `OPENCODE_EXPERIMENTAL_EVENT_SYSTEM` | boolean | 启用实验性事件系统 |
| `OPENCODE_EXPERIMENTAL_NATIVE_LLM` | boolean | 启用原生 LLM 请求路径 |
| `OPENCODE_EXPERIMENTAL_PARALLEL` | boolean | 启用并行联网搜索 |
| `OPENCODE_EXPERIMENTAL_SCOUT` | boolean | 启用 Scout 子代理 |
| `OPENCODE_EXPERIMENTAL_WORKSPACES` | boolean | 启用 workspace 支持 |
