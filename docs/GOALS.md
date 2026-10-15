# dsh-opencode-bridge：目的与目标功能实现

> 状态：MVP 设计基线；推理端点客户端身份待验证  
> 版本：0.1.1  
> 插件包：`@home-river/dsh-opencode-bridge`  
> Provider ID：`opencode-bridge`

## 1. 项目目的

本项目建立一个新的 DSH 插件工程，借鉴 `@opencode2dsh/dsh-plugin` 的原生 `LlmAdapter` 机制，实现一个更小、更清晰、可逐步扩展的 DSH 到 OpenCode 请求桥接层。

首个 MVP 只解决一个核心问题：

> 让 DSH 能发现 OpenCode 免费模型，并通过自定义 provider 向 OpenCode 兼容端点发起流式文本请求，最终在 DSH 中收到完整响应。

MVP 成功后，再基于实际联调结果继续讨论初版功能，逐步决定模型协议、请求头、图片、思考等级、工具调用和 IP 池等扩展能力。

## 2. 核心原则

### 2.1 原生 Adapter，不启动 Sidecar

插件直接注册到 DSH 的 `llm` 服务，不引入：

- Go sidecar；
- 本地监听端口；
- 本地 token；
- 独立服务进程。

### 2.2 协议转换与业务策略分离

请求链路应保持为：

```text
DSH GenerateOptions
  → Adapter/provider 层
  → OpenAI-compatible 流式协议
  → OpenCode 端点
  → DSH stream chunks
```

模型目录、错误策略、重试策略和请求头生成应拆分为独立模块，避免全部堆入插件入口。

### 2.3 先打通，再扩展

MVP 优先验证请求链路，而不是复刻参考插件的全部能力。任何未经实际验证的复杂兼容逻辑均不进入第一版。

### 2.4 故障必须隔离

上游断网、限流、地区限制、模型下线或协议错误只能影响当前模型请求，不得导致 DSH 主进程崩溃。

### 2.5 上游限制必须如实呈现

本项目不试图绕过 OpenCode 的地区限制、限流、客户端校验或使用条款。上游返回的错误必须保留状态码、错误类型和原始说明。

### 2.6 不默认启动 CLI 或 Sidecar

当前目标仍是纯 HTTP Adapter。OpenCode CLI 可以作为**可选的本机桥接方式**进行可行性验证，但不得在尚未证明必要之前，把它变成 MVP 的隐含运行依赖。

## 2A. 当前可行性探测

2026-10-17 使用最小匿名请求验证：

| 请求 | 结果 | 结论 |
|---|---:|---|
| `GET https://opencode.ai/zen/v1/models` | `200` | 模型目录可匿名读取 |
| `POST https://opencode.ai/zen/v1/chat/completions` | `403 FreeTierError` | 免费推理不能仅靠请求头伪装调用 |

推理端点返回：

```json
{
  "type": "error",
  "error": {
    "type": "FreeTierError",
    "message": "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."
  }
}
```

这说明参考插件当前的失败原因很可能不是 DSH 事件转换，而是上游加强了**真实 OpenCode 客户端身份校验**。后续必须先查清客户端校验机制，再决定采用哪一种桥接方案。

## 3. MVP 请求链路

目标链路如下：

```text
DSH 会话
  ↓
DSH LLM 服务
  ↓
opencode-bridge LlmAdapter
  ↓
OpenCode 模型目录（已验证可匿名读取）
  ↓
OpenCode-compatible 流式请求（推理端点待验证）
  ↓
DSH text-delta / usage / finish
```

推理链路必须先完成身份可行性判定。若 HTTP 直连始终返回 `FreeTierError`，则进入桥接方案 A/B 对比，不在 DSH 内继续无效重试。

MVP 必须完成一次完整的纯文本往返：

1. 用户在 DSH 中选择 `opencode-bridge` provider；
2. DSH 解析该 provider 的模型列表；
3. Adapter 准备一次流式文本调用；
4. 插件向配置的 OpenCode Base URL 发起请求；
5. 上游返回流式增量；
6. 插件将增量转换为 DSH 事件；
7. DSH 正常显示文本、usage 和 finish。

## 4. 工程结构

初始工程结构：

```text
dsh-opencode-bridge/
├── package.json
├── tsconfig.json
├── README.md
└── docs/
    └── GOALS.md
```

计划中的源码结构：

```text
src/
├── index.ts
├── adapter/
│   ├── provider.ts
│   ├── catalog.ts
│   ├── stream.ts
│   └── headers.ts
├── config/
│   └── schema.ts
└── shared/
    ├── errors.ts
    └── types.ts
```

模块职责：

| 模块 | 职责 |
|---|---|
| `src/index.ts` | 插件入口，注入 DSH 服务，注册 provider 和生命周期。 |
| `src/adapter/provider.ts` | 实现 DSH `LlmAdapter` 合同。 |
| `src/adapter/catalog.ts` | 获取、过滤、缓存 OpenCode 模型目录。 |
| `src/adapter/stream.ts` | DSH 请求与上游流式事件之间的转换。 |
| `src/adapter/headers.ts` | 生成最小 OpenCode 同形请求头与关联 ID。 |
| `src/config/schema.ts` | 定义 Base URL、超时、重试和白名单配置。 |
| `src/shared/errors.ts` | 统一错误分类与上游错误解析。 |
| `src/shared/types.ts` | 定义内部稳定类型和常量。 |

## 5. MVP 目标功能

### 5.1 注册 DSH Provider

插件注入 DSH `llm` 服务并注册：

```text
providerId: opencode-bridge
displayName: OpenCode Bridge
```

安装并重启 DSH 后，模型选择器中必须出现 `opencode-bridge` 分组。

插件入口还应提供稳定的配置结构，默认值必须可在无配置时运行。

### 5.1A 推理端点客户端身份判定

正式实现流式 Adapter 前，必须完成以下判定：

1. 记录一个最小 HTTP 直连请求的状态码与完整错误结构；
2. 查明 OpenCode 官方公开文档是否说明客户端身份要求；
3. 检查官方 OpenCode 客户端发出的公开配置、协议或本地服务；
4. 比较“纯 HTTP 直连”与“本机 OpenCode 客户端桥接”两条路径；
5. 只有确认合规、可维护的路径后，才实现推理链路。

阻断条件：

```text
纯 HTTP 请求返回 403 FreeTierError
且没有公开、合规的客户端身份接入方式
→ 停止推理 Adapter 实现，报告方案阻断
```

### 5.2 模型目录发现

模型目录按三级顺序获得：

```text
S1：在线 OpenCode 模型目录
       ↓ 失败
S2：本地 JSON 缓存
       ↓ 失败
S3：内置静态模型白名单
```

要求：

- 至少返回一个可用模型 ID；
- 在线、缓存、静态三种来源可区分；
- 去重后返回模型；
- 不把未知或付费模型误报为免费模型；
- 刷新失败写入状态和日志；
- 启动时网络未就绪不能阻止插件注册；
- 上游暂时不可用时继续使用缓存或静态名单。

状态文件计划放在：

```text
~/.dsh-opencode-bridge/catalog-status.json
```

状态至少记录：

```json
{
  "source": "online | cache | static | pending",
  "modelCount": 0,
  "lastError": "",
  "writtenAt": "ISO-8601 timestamp"
}
```

### 5.3 纯文本流式请求

MVP 支持：

- system、user、assistant 消息；
- 纯文本输入；
- 流式文本增量；
- usage 统计；
- 正常 finish；
- 上游错误 finish；
- 用户主动取消。

MVP 不支持：

- 工具调用；
- 图片附件；
- reasoning 展示；
- 思考等级选择；
- 多模态内容；
- 多 provider 聚合。

请求转换边界：

```text
DSH 消息
  → OpenAI-compatible messages
  → 上游流
  → DSH chunk 序列
```

不得把 HTTP 细节泄漏到 DSH 主会话逻辑中。

### 5.4 最小同形请求头

第一版实现最小请求头集合：

```text
Authorization: Bearer public
user-agent: OpenCode CLI compatible value
x-opencode-client: cli
x-opencode-session: stable session id
x-opencode-request: random request id
x-opencode-project: stable project id
```

ID 规则：

- session ID：按当前对话稳定派生；
- project ID：按当前工作区稳定派生；
- request ID：每次请求重新生成；
- ID 不得包含用户消息原文；
- 相同会话内 session ID 保持稳定。

请求头必须集中在 `headers.ts`，不得散落在业务模块中。实际联调若证明某字段不是必需字段，再根据真实响应收缩或替换。

### 5.5 错误分类

至少区分以下错误：

| 分类 | 是否默认重试 |
|---|---:|
| `NETWORK` | 是 |
| `TIMEOUT` | 是 |
| `RATE_LIMIT` | 是 |
| `UPSTREAM` | 是 |
| `AUTH` | 否 |
| `REGION_BLOCKED` | 否 |
| `MODEL_UNAVAILABLE` | 否 |
| `INVALID_REQUEST` | 否 |
| `CANCELLED` | 否 |

错误对象至少保留：

```text
category
httpStatus
upstreamCode
upstreamMessage
retryable
```

不得把所有异常都包装成鉴权失败。

### 5.6 重试与退避

MVP 重试策略：

- 只重试 `retryable = true` 的错误；
- 限流和临时网络错误采用指数退避；
- 每次请求有总超时；
- 取消立即终止重试；
- 重试次数、初始延迟、最大延迟可配置；
- 不在确定性错误上重复请求；
- 重试次数耗尽后将错误正常上报 DSH。

建议默认值仅作为实现起点，最终值通过实机联调确定：

```text
maxRetries: 3
initialDelayMs: 1000
maxDelayMs: 10000
requestTimeoutMs: 60000
```

### 5.7 取消传播

DSH 取消请求时必须：

1. 触发上游 `AbortController`；
2. 停止继续读取流；
3. 清理超时计时器；
4. 结束所有 pending Promise；
5. 不继续执行重试；
6. 向 DSH 返回 `CANCELLED` 结束状态。

不得留下悬挂请求或无限等待的 stream。

## 6. 配置范围

MVP 仅开放必要的配置：

| 配置项 | 用途 | MVP 默认策略 |
|---|---|---|
| `baseUrl` | OpenCode-compatible API 地址 | 由联调确定 |
| `modelWhitelist` | 静态模型白名单 | 非空数组 |
| `requestTimeoutMs` | 单次请求超时 | `60000` |
| `maxRetries` | 最大重试次数 | `3` |
| `initialDelayMs` | 首次退避延迟 | `1000` |
| `maxDelayMs` | 最大退避延迟 | `10000` |
| `refreshSeconds` | 模型目录刷新周期 | `300` |

MVP 不开放：

- 代理地址；
- 订阅 URL；
- 出口节点；
- IP 池开关；
- 多 provider 路由；
- sidecar 路径。

## 6A. 推理桥接候选方案

在 `FreeTierError` 被确认后，只评估以下方案：

### 方案 A：纯 HTTP 直连

```text
DSH Adapter → OpenCode HTTP API
```

- 最简单，无额外进程；
- 只有在上游接受公开、稳定的客户端身份时采用；
- 当前探测已返回 `403`，暂不可作为已打通方案。

### 方案 B：本机 OpenCode 客户端桥接

```text
DSH Adapter → 本机 OpenCode 提供的公开本地接口/进程 → OpenCode 推理
```

- 可能提供真实客户端身份；
- 需要额外进程或 CLI 生命周期管理；
- 必须确认存在公开、稳定的本地接口；
- 不得通过伪造私密凭据或规避服务端校验实现。

### 方案 C：受支持的 OpenCode Provider/API

```text
DSH Adapter → 用户配置的受支持 API
```

- 使用正式凭据，不属于匿名免费通道；
- 作为稳定备选，但会改变“免 API Key”的原始目标。

MVP 选型必须由实际协议调查决定，不能因为方案 B 能绕过当前错误就默认采用。

## 7. 参考插件的借鉴与取舍

### 7.1 借鉴

从 `@opencode2dsh/dsh-plugin` 借鉴：

- 原生 DSH `LlmAdapter` 注册；
- providerInfo、listModels、resolveModel、prepareCall、stream 合同；
- 模型目录在线、缓存、静态三级回退；
- DSH chunk 与上游流的转换思路；
- 请求 ID 和会话关联头的集中管理；
- 临时错误退避与确定性错误不重试的边界；
- 流首事件和中途静默超时；
- 错误分类和健康状态落盘。

### 7.2 暂不借鉴

MVP 不复刻：

- IP 池；
- 订阅解析；
- `undici` 全局 dispatcher 替换；
- 全局 `fetch` 替换；
- 本地 Go sidecar；
- 完整 CLI 流量伪装；
- 完整 Web 设置页；
- 多出口健康探测；
- 复杂轮换策略。

这些能力只有在基础链路稳定并通过实机验收后，才进入后续设计讨论。

## 8. MVP 验收标准

以下条件必须全部满足：

1. `npm run typecheck` 通过；
2. 插件入口可被 DSH 识别；
3. 模型选择器出现 `opencode-bridge`；
4. 至少列出一个 OpenCode 可用模型；
5. DSH 能发起一次纯文本请求；
6. 上游至少返回一个流式文本增量；
7. DSH 能收到完整文本响应；
8. usage 和 finish 正常上报；
9. 网络错误不会导致 DSH 主进程崩溃；
10. 取消请求后没有悬挂 Promise；
11. 临时错误按策略重试；
12. 确定性错误不重试；
13. 模型目录失败可降级到缓存或静态名单；
14. 不修改现有 `@opencode2dsh/dsh-plugin`；
15. 不包含 IP 池、订阅或 sidecar。

### 8.1 实机联调用例

用例一：正常文本往返。

```text
输入：
请只返回 OPENCODE_BRIDGE_OK

期望：
响应包含 OPENCODE_BRIDGE_OK
状态：finished
usage 可解析或明确为空
```

用例二：流式增量。

```text
输入：
请逐字返回 STREAMING_OK

期望：
至少收到两个 text-delta
最终拼接结果包含 STREAMING_OK
```

用例三：请求取消。

```text
操作：
发起长回答后立即取消

期望：
上游请求被中止
不继续重试
没有未处理 Promise rejection
```

用例四：目录降级。

```text
操作：
阻断在线目录请求

期望：
插件仍能使用缓存或静态白名单
DSH 启动不失败
状态文件记录 lastError
```

## 9. 非目标

本 MVP 不包含：

- IP 池；
- 订阅；
- sidecar；
- 本地 Go agent；
- 图片输入；
- 工具调用；
- reasoning 展示；
- 完整设置页面；
- 自动安装到当前 DSH profile；
- npm 正式发布；
- 绕过 OpenCode 地区、限流或客户端限制；
- 修改现有 `@opencode2dsh/dsh-plugin`；
- 复刻其全部代码和边界处理。

## 10. 后续实现阶段

```text
阶段 1：工程与目标文档
阶段 2：推理端点身份与协议可行性调查
阶段 3：选择合规桥接方案（纯 HTTP / 本机客户端 / 正式 API）
阶段 4：插件入口与配置
阶段 5：模型目录与缓存
阶段 6：DSH LlmAdapter 合同
阶段 7：OpenCode 流式请求
阶段 8：错误、重试与取消
阶段 9：DSH 实机联调
阶段 10：根据联调结果调整请求头和协议
```

当前阻塞在阶段 2：已确认目录接口可访问，但推理接口返回 `403 FreeTierError`。在阶段 2 和阶段 3 完成前，不开始大规模实现流式 Adapter，也不引入后台进程。

## 11. 完成定义

MVP 只有在以下情况同时成立时才算完成：

- 工程通过类型检查；
- 插件能够注册；
- 模型目录可用；
- 至少一个真实模型完成文本流式往返；
- 取消、降级和错误路径有测试或实机证据；
- 文档与实际实现一致；
- 新工程未覆盖或破坏现有插件。
