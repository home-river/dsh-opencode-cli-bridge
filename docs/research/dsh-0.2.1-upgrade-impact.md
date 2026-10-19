# DSH 0.2.1 升级影响排查结论（dsh-opencode-bridge）

> 日期：2026-10-17
> 排查范围：GitHub `deepseek-ai/deepseek-harness` releases（v0.2.1-rc.1 / v0.2.1-rc.2）+ 本地 `F:\Program Files (x86)\DSH\resources\app.asar`（0.2.1-rc.1）运行时代码比对
> 关联 issue：`issues/ISSUE-003-dsh-021-contract-drift.md`
> 性质：**静态合同比对结论，未实机复现**。带「待实机验证」标记的项留待 TODO-27 DSH 实机联调确认。

---

## TL;DR

1. **Changelog 层面对本插件零破坏**：v0.2.1-rc.1 的开发者向变更（invariant 导出移除、stats 入口拆分、`both` 模式移除等）逐条核对后均不触及本插件使用面；v0.2.1-rc.2 只含 DeepSeek 模型与 Search/Fetch API 适配，与插件无关。
2. **asar 合同层有一处阻断性漂移**：`LlmAdapter` 合同由七方法扩为**八方法**，新增 `imageRequestTarget`。本插件是结构化实现（不继承基类、不 import DSH 运行时），拿不到基类默认实现，运行时又是硬调用（无 `?.` 保护）→ 消费方一旦对 `opencode-bridge` 路由查询图片请求目标即 `TypeError`。
3. **一处校验收紧待验证**：携带 `reasoningEffort` 而模型未声明 `reasoning` 元数据的请求会在 provider I/O 前被拒（`UNSUPPORTED_REASONING_EFFORT`）；oc bridge 的 `resolveModel` 恰好从不返回 `reasoning` 字段，而本机 desktop profile 配了 `reasoningEffort: medium`。
4. **两处低风险建议**：补 `engines.dsh` 声明（当前无约束、可正常加载）；`catalog-store` 对 model id 去重防御。
5. **核心合同面未变**：`StreamChunk` / `GenerateOptions` / `AdapterRegistrationHandle` / `registerAdapter` 语义逐字一致，`to-dsh-chunks`、`map-events`、`plugin.ts` 注册逻辑无需改动。

---

## 1. 版本现状

| 项 | 版本 | 说明 |
|---|---|---|
| 本地安装 | `0.2.1-rc.1` | `DeepSeek Harness.exe` FileVersion 确认 |
| GitHub 最新 | [`v0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)（2026-10-17） | 仅 DeepSeek-V4.1-Flash-1017 模型适配 + DeepSeek Search/Fetch API，**与插件无关** |
| 本次变更主体 | [`v0.2.1-rc.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.1)（2026-10-17） | 自 v0.2.0-rc.2 起的全量变更 |
| 插件合同时点 | 2026-10-16 提取 | `docs/research/dsh-llm-contract.md` / `dsh-plugin-contract.md` 基于 0.2.0 系列运行时，与现状存在 §3 漂移 |

官方仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。

## 2. Changelog 逐项核对（v0.2.1-rc.1 开发者向）

| 变更 | 判定 | 依据 |
|---|---|---|
| 移除 runtime invariant 插件及 `./invariant` 导出（**Breaking**） | ✅ 无影响 | 插件未使用 invariant；`package.json` exports 只有 `.` 与 `./cordis.patch.yml` |
| 第三方插件兼容性优先按 `engines.dsh` 判断 | ⚠️ 低风险 | 见 §3.3 |
| 子路径插件不再读独立 `package.json` | ✅ 无影响 | `cordis.patch.yml` 挂的是包根（当时 `@home-river/dsh-opencode-bridge`，2026-10-19 更名为 `dsh-opencode-cli-bridge`） |
| 输入区统计扩展拆为 `activity` / `usage`，旧 `stats` 注册 ID 失效 | ✅ 无影响 | 纯 LLM 插件，无 UI 扩展点 |
| 工具展示移除 `both` 混合模式（仅 native / ptc） | ✅ 无影响 | 未使用 |
| Agent Team 消息改直投 Inbox、移除 outbox 与重发去重 | ✅ 无影响 | 关注方是 collab-pipeline |
| Python PTC 接入 Session 文件沙箱；自定义组合需提供 `sandbox` / `sandboxPolicy` 服务 | ✅ 无影响 | 本插件是插件行，不是自定义组合 |
| headless API Key 读取优先级改环境变量 / .env | ✅ 无影响 | 凭证由 OpenCode CLI 自管 |
| 修复「模型流停摆且底层传输不响应取消时请求挂起」 | ✅ 正向 | CLI 桥接场景更稳 |
| 修复 Agent 关闭时资源提前释放；HMR 刷新包入口与依赖映射 | ✅ 正向 | `registerAdapter` "Disposed with the fiber" 生命周期更可靠 |
| 自定义模型 API 支持 UI 配置各模型推理等级 | ℹ️ 相关 | 与 §3.2 联动：GUI 推理等级最终会以 `reasoningEffort` 进请求 |

## 3. asar 合同漂移（changelog 未列出，重点）

### 3.1 `LlmAdapter` 新增第八方法 `imageRequestTarget`（阻断性）

现运行时（0.2.1-rc.1）API manifest 中的合同（逐字，asar 内同一实现有多份 bundle 拷贝，行号以一份拷贝计 ≈ L1655302）：

```ts
export abstract class LlmAdapter {
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined;
    imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined;
    imageRequestTarget(_provider: string, _model: string, image: ImageAttachmentRef): ImageRequestTarget;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
```

对比 `docs/research/dsh-llm-contract.md` §3（2026-10-16 提取的**七方法**合同），新增第 4 个方法 `imageRequestTarget`，返回值 `ImageRequestTarget { width; height; maxBytes }`。

基类默认实现（「不缩放图片的适配器保留归一化原图」语义，≈ L1656370）：

```js
imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes };
}
```

运行时调用点是**硬调用，无 `?.` 保护**（≈ L1654548）：

```js
imageRequestTarget(provider, model, image) {
    return this.registration(provider).adapter.imageRequestTarget(provider, model, image);
}
// 对比 imageRequestPricing 用的是可选链：
//   return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model);
```

**影响**：`OpencodeBridgeAdapter`（`src/adapter.ts`）按 G2/G9 结构化实现、不继承 `LlmAdapter` 基类 → 方法缺失。任何消费方对 `opencode-bridge` 路由查询请求图片目标（截图 / 附件预览按路由取尺寸）即 `TypeError: ...imageRequestTarget is not a function`。触发前提是图片流到达该路由；插件声明 `inputModalities: ["text"]`，正常文本对话不触发，但**查询本身不校验模态**，风险真实存在。

**修复建议**：`OpencodeBridgeAdapter` 补同语义默认实现（约 5 行）；`src/dsh-types.ts` 与单测的「七方法」断言同步更新为八方法。

### 3.2 reasoningEffort 校验收紧（待实机验证）

`LlmRuntime.resolveCallWithInfo`（≈ L1656846）在 provider I/O 前校验：

```js
const reasoning = info.reasoning;
const requested = defaulted.reasoningEffort;
if (reasoning === void 0) {
    if (requested !== void 0) throw new LlmError(
        `provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`,
        "UNSUPPORTED_REASONING_EFFORT");
}
```

即：模型 `resolveModel` 未声明 `reasoning` 元数据、而请求携带 `reasoningEffort` → **CLI 根本不会被拉起**，直接 `UNSUPPORTED_REASONING_EFFORT`。另有 `INVALID_MODEL_REASONING` 校验：声明了 `reasoning` 但 `efforts` 为空数组也拒（≈ L1656808）。

**影响条件（待实机验证）**：oc bridge 的 `resolveModel`（`src/adapter.ts`）只返回 `{provider, id, name, inputModalities:["text"]}`，从不返回 `reasoning`。本机 desktop profile 的 `agent-default-model` 配置含 `reasoningEffort: medium`；该默认值是否随路由注入 oc bridge 请求、或 GUI 推理等级（§2 末行）是否落到该路由，需实机确认。若注入，**所有 oc bridge 请求被拒**。

**修复候选**：A. `resolveModel` 按 OpenCode 模型能力声明 `reasoning.efforts`（顺带获得 GUI 推理等级选择）；B. 在 `llm/stream` waterfall 抹掉 `reasoningEffort`。

### 3.3 `engines.dsh` 兼容性声明（低风险）

0.2.1 起的判定规则（asar 逐字）：清单声明 `engines.dsh` 时只按该范围判断（忽略 peerDependencies）；否则要求 `@deepseek-ai/dsh*` 的 peerDependencies 范围全部匹配；**两者皆无 → 不施加约束**。未满足的要求会**阻断安装与 profile 启动**，需精确版本豁免（`allow-version`）。

本插件 `package.json` 只有 `engines.node`、无 dsh peerDependencies → 落在「无约束」分支，**当前可正常加载**。建议补声明，注意 semver 预发布规则：`>=0.2.1` **不含** `0.2.1-rc.1`（预发布只匹配同 `[major,minor,patch]` 元组且带预发布的范围），宜写 `>=0.2.1-rc.1 <0.4.0` 一类范围。

### 3.4 `listModels` 重复 model id → `INVALID_CATALOG`（轻微）

运行时对 adapter 返回的目录条目逐条校验（≈ L1656753）：provider 匹配、id/name 非空、**id 不得重复**，重复即抛 `INVALID_CATALOG`。OpenCode 端目录若出现重复 model id 会炸在目录加载。建议 `catalog-store` 加去重防御（顺手项）。

### 3.5 确认未变的合同面（本插件核心依赖）

以下与 2026-10-16 提取件逐字一致，**不受本次升级影响**：

- `StreamChunk` 七变体与协议顺序（`usage` 先于 `finish`、`finish` 唯一收尾）；
- `GenerateOptions` 形状（仍无 workspace/cwd 字段，`sessionId` 可选）；
- `AdapterRegistrationHandle`（disposer + `replace()`）；
- `registerAdapter` 语义：`DUPLICATE_ADAPTER`、至少一个 provider、"Disposed with the fiber"、`loader/volatile-update` → `replace()` 热更新范式；
- `LlmResolvedModelInfo` 形状（`systemPromptUpdate` / `toolUpdate` 语义不变）。

→ `to-dsh-chunks`、`map-events`、`cli-bridge`、`plugin.ts` 注册与 workspace 解析（G10）逻辑均无需改动。

## 4. 测试基线说明

本次排查中 `npm test` 在沙箱内失败：`node --test` 需 spawn 子进程跑 fake CLI，被沙箱以 `EPERM` 拒绝（表现为 `CLI_START_FAILED` / `spawn EPERM`）。纯层用例（types / map-events / to-dsh-chunks）不受影响。**这是沙箱边界限制，不是本次升级引起的回归**；修复后应在沙箱外跑全量 `npm test` + `npm run test:integration` 复核。

## 5. 建议动作（按优先级）

1. **必做（TODO-27 实机联调前）**：`OpencodeBridgeAdapter` 补 `imageRequestTarget`（§3.1，确定性修复）；`dsh-types.ts` / 单测断言七→八方法。
2. **联调时验证**：§3.2 reasoningEffort 是否注入 oc bridge 路由；据结果选修复 A 或 B。
3. **顺手**：`package.json` 补 `engines.dsh`（注意预发布范围写法，§3.3）；`catalog-store` model id 去重（§3.4）。
4. 修复后在 `issues/ISSUE-003-dsh-021-contract-drift.md` 补「修复方案」小节（AGENTS.md 第二节规则）。

## 6. 引用

- [v0.2.1-rc.1 release notes](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.1) ／ [v0.2.1-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)
- 合同原文出处：本地 `F:\Program Files (x86)\DSH\resources\app.asar`（0.2.1-rc.1）；asar 内同一实现存在多份 bundle 拷贝，本文行号为其中一份拷贝的近似值，以符号名为准
- 前序提取件：`docs/research/dsh-llm-contract.md`、`docs/research/dsh-plugin-contract.md`（2026-10-16，基于 0.2.0 系列）
- 关联 issue：`issues/ISSUE-003-dsh-021-contract-drift.md`
