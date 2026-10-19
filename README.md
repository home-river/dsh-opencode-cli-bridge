# dsh-opencode-cli-bridge

> 在 DeepSeek Harness 里通过**本机 OpenCode CLI** 使用 OpenCode 兼容模型——原生 `LlmAdapter` 桥接，无 sidecar、无额外进程、无 API Key。

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件 · MIT License

## 功能特性

- **原生 adapter**——模型选择器出现 `opencode-bridge` provider，装好即用
- **会话一对一续接**——DSH 会话 ↔ OpenCode session 绑定，工具结果跨轮可见
- **打字机流式**——OC 整段输出切块 + 节奏层模拟流式，思考/工具回传结构化镜像
- **CLI 环境检测**——面板常驻状态卡（版本/路径/来源），未安装时给推荐安装命令，一键复制
- **模型暴露筛选**——侧边卡片勾选面板，想暴露哪些模型自己定
- **健壮性**——五层超时、取消即杀进程树（Windows `taskkill /T`）、12 类错误分类、协议解析防护

## 前置要求

| 依赖 | 要求 |
|---|---|
| DeepSeek Harness | 0.2.x（实测线 0.2.1） |
| Node.js | ≥ 20（DSH 能跑就满足） |
| **OpenCode CLI** | **必须**：本插件通过本机 `opencode` CLI 出模型流量 |

OpenCode CLI 未装也没关系——打开 OC-bridge 面板，顶部「CLI 环境」区块会告诉你状态并给出**按你的环境推荐的安装命令**（自动探测 npm / scoop / choco），一键复制即可。

## 安装

```sh
# npm 安装（推荐）
dsh plugin --profile web add dsh-opencode-cli-bridge

# 或本地 tgz / 源码安装
npm pack
dsh plugin --profile web add ./dsh-opencode-cli-bridge-0.1.0.tgz
```

> 提示：找不到 `dsh` 命令时可用 `npx -y --package @deepseek-ai/dsh dsh plugin ...` 兜底。

**验证**：重启 `dsh web`，打开模型选择器 → 出现 **opencode-bridge** 分组并列出模型 → 选中开聊。

## 使用

- **模型选择器**：直接选 `opencode-bridge` 下的模型对话；
- **OC-bridge 面板**（左栏「插件」卡旁）：顶部是 CLI 环境状态卡；下方勾选要暴露到选择器的模型，保存后下次打开选择器生效；
- **取消**：DSH 侧停止生成即杀掉 CLI 进程树，不留孤儿进程。

## 配置

面板写回 `~/.dsh-opencode-bridge/config.json`，也可手改：

```json
{
  "models": {
    "include": ["opencode/mimo*", "opencode/gpt*"],
    "exclude": ["opencode/gpt-5-pro"]
  }
}
```

规则（匹配完整模型 id，模式仅支持 `*` 通配）：

1. `include` 非空时只展示命中项；留空 = 全放行；
2. `exclude` 优先级最高，命中即隐藏；
3. `opencode-go/*` **默认隐藏**，需要时在 `include` 显式写回。

改完即生效（每次打开选择器重读），配置损坏不报错、退回默认并记诊断日志。

**思考强度**：插件声明 `reasoning.efforts` 并把 `reasoningEffort` 透传 `opencode run --variant`；但免费模型实测不响应 `--variant`——「接受并转发」≠「保证生效」。

## 工作原理

```text
DSH 会话 → DSH LLM 服务 → opencode-bridge LlmAdapter
  → opencode run --format json（本机 CLI，--dir 工作区 / --session 会话绑定）
  → JSON Lines 事件 → DSH text-delta / reasoning / usage / finish
```

- **绑定**：`~/.dsh-opencode-bridge/sessions.json` 记录 DSH 会话 → OC 会话与消息水位，续轮增量发送；账本漂移或 OC 会话失效时自动重建并全量重放一次；
- **回传**：正文 → `text` 块；思考 → 原生 `reasoning` 块；工具调用/结果 → 结构化镜像（借 `reasoning` 块承载，避免 `tool-call` 块触发 DSH 工具循环造成双重执行）；
- **发现**：CLI 四级发现（显式路径 → PATH → npm 全局布局 → 报错引导），Windows 下 `.cmd` shim 解析出真身 exe 直接执行，不用 shell。

## 安全与隐私

- **只调用本机已装的 OpenCode CLI**，流量从你的机器直达模型上游；无遥测、无第三方统计、无安装脚本（pnpm 零构建脚本摩擦）；
- 诊断日志写在 `~/.dsh-opencode-bridge/`（`requests.log` 请求摘要 / `diagnostics.log` 协议诊断 / `sessions.json` 会话映射），不含 API Key；
- ⚠️ **取证日志 `last-request.md` 会保存最近一次请求的 prompt 原文**（排障用），介意可随时删除该文件，功能不受影响；
- 面板的「CLI 环境」检测是**只读**的：不执行任何安装/卸载动作，只探测并给命令。

## DSH 版本兼容

| 你的 DSH 版本 | 本插件版本 |
|---|---|
| 0.2.1 及之后的 0.2.x（含 0.2.1-rc 线） | 0.1.0 |

插件以顶层 `engines.dsh: ">=0.2.1-0 <0.3.0"` 声明兼容范围，安装与启动都会校验；不满足时插件会被整包跳过并列入 `skippedBundles`（可用 `dsh plugin --profile <p> allow-version <pkg@ver> --dsh-version <ver> --accept-risk` 强行豁免，风险自担）。

## 开发

```sh
npm test              # tsc 全量 + client 构建 + node --test 单测 239 条
OCBRIDGE_IT=1 npm run test:integration   # 真实 CLI 集成测试（需本机 opencode）
```

- `src/`：host 半区（发现/spawn/协议/事件/adapter/路由）+ `client.js`（OC-bridge 面板，vanilla JS + React.createElement，无打包链）；
- `test/`：fake CLI 单测（走真实 spawn 路径）+ 真实 CLI 集成测试；
- `docs/`：`GOALS.md`（目标与验收）、`CLI-BEHAVIOR.md`（CLI 行为实测记录）、`research/`（DSH 合同研究）；
- `issues/`：关键 bug 的现象/根因/修复方案记录（工程过程透明）。

## License

[MIT](./LICENSE)
