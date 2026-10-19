# @home-river/dsh-opencode-bridge

一个面向 DeepSeek Harness（DSH）的最小原生 `LlmAdapter` 插件工程，目标是先打通 **DSH → OpenCode 兼容流式接口** 的文本请求链路。

本项目借鉴 `@opencode2dsh/dsh-plugin` 的适配器机制，但只实现可独立验证的 MVP，不包含 IP 池、订阅、sidecar、完整 CLI 流量伪装或插件设置页。

## 当前阶段

CliBridge（OC → 插件段）已完成：CLI 四级发现、进程壳（spawn/stdio 分流）、JSON Lines 解析、事件归一化、错误分类、五层超时、取消与 Windows 进程树清理，并通过单测 103 条与真实 CLI 集成测试（R01–R08、R11）。DSH StreamChunk 转换器（子项目 2）已完成，`streamDshChunks` 端到端入口 + fake CLI 端到端测试全绿。子项目 3（DSH LlmAdapter 接入）已完成：消息压平、模型目录与缓存、`OpencodeBridgeAdapter` 七方法合同、插件入口（`name`/`inject`/`apply`）与 bundle 打包合同（`dsh.bundle.patch` + `cordis.patch.yml`）全部落地，单测 185 条全绿。模型展示筛选已实现（`src/model-filter.ts`：配置化 include/exclude，默认隐藏 `opencode-go/*`，见下节）。剩 DSH 实机联调（TODO-27~30）：模型选择器、最小冒烟、工作区隔离与取消续接。

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

## 会话透传（DSH ↔ OC 会话 1:1 绑定，2026-10-19）

插件的本职是**透传桥**：DSH 消息增量送入持久绑定的 OC 会话，OC 的输出（正文/思考/工具）全量回传 DSH。

- **绑定**：`~/.dsh-opencode-bridge/sessions.json` 记录 `DSH 会话 → OC 会话（ses_*）+ 已送达消息水位`；续轮经 `opencode run --session` 续接 OC 自有历史——**工具结果跨轮可见**（模型能回答"你上一轮工具输出了什么"）。
- **增量**：只发新消息（`buildDeltaPrompt`）；system 内容变化时才随发。历史不再全量压平重发。
- **回传**：正文 → `text` 块；思考 → 原生 `reasoning` 块；工具调用/结果 → 结构化镜像（`🔧 tool input` / `└─ status | output`，借 `reasoning` 块承载——`tool-call` 块会触发 DSH 自己的工具循环造成双重执行，故刻意不用）。呈现复用 DSH 的折叠/收起机制。
- **回退**：消息数小于账本（编辑/分支）或 OC 会话失效（`SESSION_INVALID`）时，自动重建会话并全量重放一次。

## 模型展示筛选（可选配置）

`opencode models` 会列出全部模型（含 `opencode-go/*`），选择器里太长；插件支持按需筛选展示。配置文件 `~/.dsh-opencode-bridge/config.json`：

```json
{
  "models": {
    "include": ["opencode/mimo*", "opencode/gpt*"],
    "exclude": ["opencode/gpt-5-pro"]
  }
}
```

规则（匹配对象是完整模型 id，模式仅支持 `*` 通配）：

1. `include` 非空时只展示命中任一模式的条目；留空或不写 = 全放行；
2. `exclude` 优先级最高，命中即隐藏；
3. **`opencode-go/*` 默认隐藏**；需要时在 `include` 里显式写 `opencode-go/*` 或具体 id 即可放回。

其他行为：

- 每次打开模型选择器都重读配置，改完即生效，无需重启 DSH；
- 配置文件缺失、JSON 损坏、字段类型不对都**不会报错**，一律退回默认（只隐藏 `opencode-go/*`），并把原因记入 `~/.dsh-opencode-bridge/diagnostics.log`；
- 筛选只影响**展示**：目录缓存仍存全量，已被选中但后来被过滤掉的模型仍能继续请求；
- 若过滤结果为空，兜底展示静态保底模型 `opencode/mimo-v2.6-flash-free`，避免选择器全空。

思考强度：2026-10-18 起声明 `reasoning.efforts`（off/minimal/low/medium/high/max）并把 `reasoningEffort` 透传 `opencode run --variant`（DSH 0.2.1 校验要求，见 `issues/ISSUE-003-dsh-021-contract-drift.md`）；`--variant` 对免费模型实测不响应，「接受并转发」≠「保证生效」。

### 模型暴露设置（侧边栏入口「OC-bridge」）

不用手改 `config.json`：client 半区在**左栏「插件」卡旁**注册了「**OC-bridge**」入口，点开是勾选面板——全量目录按前缀分组折叠（含默认隐藏的 `opencode-go/*`），组头三态勾选支持整组批量操作，勾选结果写回 `config.json` 的 `models` 段（白名单语义：勾选清单 → `include`；全不勾 → `exclude: ["*"]`），下次打开模型选择器即生效。

- 通信走 `ctx.connection.fetch.register` 的 `/api/opencode-bridge.models`（读）与 `/api/opencode-bridge.filter`（写），位于浏览器会话 cookie 鉴权栅栏内，无需额外鉴权；
- host 侧 `connection` 服务缺失时只记诊断、入口数据加载失败但**不影响模型桥主功能**；
- 面板为 vanilla JS + React.createElement 手写模块（`src/client.js` → `lib/client.js`，`scripts/build-client.mjs` 拷贝产出），未引入打包链。

## 开发状态

```text
[x] 工程目录
[x] 包与 TypeScript 基础配置
[x] 目的和目标功能实现文档
[x] CliBridge：CLI 发现 / spawn / JSON Lines 解析 / 事件归一化
[x] CliBridge：错误分类 / 五层超时 / 取消与进程树清理
[x] 测试：fake CLI 单测 + 真实 CLI 集成测试
[x] DSH LlmAdapter 合同
[x] 插件入口与配置
[x] DSH StreamChunk 转换（切块模拟流式，多 finish 折叠）
[x] 模型目录与缓存
[x] 模型暴露设置 UI（侧边栏入口 + 勾选面板，写回 config.json）
[ ] DSH 实机联调
```
