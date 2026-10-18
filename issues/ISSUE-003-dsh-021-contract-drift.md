# ISSUE-003 DSH 0.2.1 升级后 LlmAdapter 合同漂移（imageRequestTarget 缺失 / reasoning 校验收紧）

- 状态：fixed
- 发现日期：2026-10-17
- 修复日期：2026-10-18
- 相关文件：`src/adapter.ts`、`src/dsh-types.ts`、`src/catalog.ts`、`src/cli-bridge.ts`、`src/types.ts`、`docs/research/dsh-llm-contract.md`
- 发现方式：静态合同比对（GitHub release notes + `F:\Program Files (x86)\DSH\resources\app.asar` 0.2.1-rc.1 运行时代码），**未实机复现**

## 现象（预测，待 TODO-27 实机确认）

1. **`imageRequestTarget` 调用即 TypeError**：任何消费方对 `opencode-bridge` 路由调用
   `ctx.llm.imageRequestTarget(provider, model, image)`（截图/附件预览按路由查询请求图片目标）
   时，运行时直接调用 `this.registration(provider).adapter.imageRequestTarget(...)`
   （非可选链），`OpencodeBridgeAdapter` 无此方法 → `TypeError: ...imageRequestTarget is not a function`。
2. **携带 reasoningEffort 的请求在 I/O 前失败**：请求装配阶段 `resolveCallWithInfo` 校验
   「模型未声明 `reasoning` 元数据 且 `config.reasoningEffort` 非空」→ 直接抛
   `UNSUPPORTED_REASONING_EFFORT`，OpenCode CLI 根本不会被拉起。
   触发条件：调用方（如 agent-default-model 的 `reasoningEffort: medium` 配置、UI 推理等级）
   向 oc bridge 路由注入了 reasoningEffort。是否全局注入待实机验证。

## 原因

1. **合同变更**：DSH 0.2.1-rc.1 的 `LlmAdapter` 抽象类由七方法扩为**八方法**，新增
   `imageRequestTarget(_provider, _model, image): ImageRequestTarget`（基类默认实现返回
   归一化原图的 `width/height/maxBytes`）。`docs/research/dsh-llm-contract.md` §3（2026-10-16
   提取）的逐字合同没有该方法，插件按七方法合同做了**结构化实现**（G2/G9：不 import
   DSH 运行时、不继承 `LlmAdapter` 基类），因此**不继承基类默认实现**，方法直接缺失。
   运行时侧 `LlmRuntime.imageRequestTarget` 对已注册路由是硬调用
   （`imageRequestPricing` 用了 `?.` 可选链，`imageRequestTarget` 没有），缺失即崩。
2. **校验收紧/生效**：`LlmRuntime.resolveCallWithInfo` 对「无 reasoning 元数据的模型 +
   显式 reasoningEffort」零容忍（`UNSUPPORTED_REASONING_EFFORT`，I/O 前拒绝，无钳制无别名）。
   插件 `resolveModel` 只返回 `{provider, id, name, inputModalities:["text"]}`，从不声明
   `reasoning`，属于该校验定义的「不支持 reasoning 的模型」。

## 修复方案（修复后填写）

> 2026-10-18 修复。修复前补做了运行时取证（0.2.0-rc.2 解包源码 + 本机 DSH app.asar 二进制取证），修正了原候选的两处错误假设，见文末「取证修正」。

### 问题 1：`imageRequestTarget` 八方法合同（确定性修复）

- `src/dsh-types.ts`：镜像 `DshImageRequestTarget { width; height; maxBytes }`（字段名取自 0.2.1 合同；字段类型由基类默认实现赋值推得）。
- `src/adapter.ts`：`OpencodeBridgeAdapter` 补第八方法，与基类默认实现同语义——不缩放，保留归一化原图：`{ width: image.width, height: image.height, maxBytes: image.bytes }`（读 `image.width/height/bytes`，不读 `originalDimensions`；同步返回，非 Promise）。
- `test/unit/adapter.test.mjs`：透传语义 / 同步非 Promise / provider-model 参数忽略 / 八方法合同护栏（防缺方法、防 pricing-target 误合并）。

### 问题 2：reasoningEffort 校验规避（方案：声明 + `--variant` 透传）

**决策（2026-10-18，经主理人确认）**：`resolveModel`/`prepareCall` 声明 `reasoning.efforts`，`GenerateOptions.reasoningEffort` 经 `opencode run --variant` 透传。该决策**修订** 2026-10-17 探针结论「实测有响应才声明 efforts」——原前提（不声明没有代价）被 DSH 0.2.1 的 `UNSUPPORTED_REASONING_EFFORT` 硬校验推翻：不声明时携带 effort 的请求在 provider I/O 前被拒，且 `llm/stream` waterfall 拦不住主路径（取证修正 1）。

- `src/catalog.ts`：`REASONING_EFFORTS` 档位表（`off/minimal/low/medium/high/max`，取 `--variant` 词汇 + DSH 生态常用 id）+ `modelReasoningInfo()` + `variantForEffort()`（`off`/缺省不传 `--variant`）；不设 `defaultEffort`，请求不带 effort 时不注入默认值。
- `src/dsh-types.ts`：镜像 `DshLlmReasoningEffortInfo { id; name; description? }`、`DshLlmModelReasoningInfo { efforts; defaultEffort? }`（形状取自 `LlmRuntime.normalizeModelInfo` 的 `INVALID_MODEL_REASONING` 校验逐字）。
- `src/adapter.ts`：`resolveModel` 两个分支（目录命中 / 宽松回退）均附 `reasoning`；`AdapterGenerateOptions` 增 `reasoningEffort`；`stream()` 映射为 `variant` 传入 CliBridge。
- `src/cli-bridge.ts` / `src/types.ts`：`CliBridgeOptions.variant` → argv `--variant <id>`（G2 argv 数组，紧随 `--session`）。
- 单测：reasoning 元数据过运行时校验（efforts 非空 / id 不重复 / defaultEffort 归属）、`reasoningEffort → --variant` 透传（`high`/`medium` 透传、`off`/缺省不传，fake CLI `variant-echo` 模式），既有 deepEqual 断言同步补 `reasoning` 字段。

**诚实边界（必须保留）**：`opencode run --variant` 对任意档位静默接受、CLI 不校验；模型是否响应因 provider 而异（`mimo-v2.6-flash-free` 2026-10-17 实测不响应）。声明的档位语义是「接受并转发」，不是「保证生效」。UI 推理等级选择器会随声明出现（`LlmResolvedModelInfo.reasoning` 是 GUI 档位的唯一来源）。

### 取证修正（修复前补做，0.2.x 运行时源码 / asar）

1. **`llm/stream` waterfall 抹除（原候选 B）不能作为主修复**：agent loop 主路径是 `ctx.llm.prepareCall()`，`resolveCallWithInfo` 校验发生在 `llm/stream` waterfall **之前**（`adapterStream` 才在 `next()` 内校验）；UI 模型选择（`selectModel`）、headless API、ACP 均经 `resolveCallConfig` 直接校验。waterfall 只覆盖 `ctx.llm.stream()` 直调（如压缩摘要）；对 prepared 路径原地改 `options` 还会触发 `INVALID_PREPARED_CALL`（`callConfigEquals` 含 `reasoningEffort` 比对）。校验只读 `resolveModel` 返回的 `reasoning` 元数据与请求的 `reasoningEffort`，adapter 对后者无写回通道 → **声明是唯一全路径杠杆**。
2. **effort id 值域**：`ReasoningEffortId = Branded<'ReasoningEffortId'>`，自由字符串、无全局枚举；但 **UI 档位选择器候选项就是 `resolveModel` 声明的 efforts**（ACP `updateModel` 也按 `info.reasoning.efforts` 校验），声明后 UI/ACP 只会派发已列 id。遗留注入面：stale `agent-default-model` 存档、`agentReasoningEffort` 描述符、headless API 自由参数——任意 id 不在档位表内仍会按 DSH 设计快速失败（`UNSUPPORTED_REASONING_EFFORT`），届时加档位即可。
3. **effort 元素形状**：`{ id: string(非空); name: string(非空); description?: string }`，id 不得重复；`defaultEffort` 若给出必须属于 efforts（`normalizeModelInfo` INVALID_MODEL_REASONING 校验逐字）。

### 验证方式

- `npm test`：189 条单测全绿（含上述新增）。
- `npm run test:integration`：真实 CLI 集成（本次跑为 SKIP 门控，见测试文件的启用条件）。
- 待 TODO-27 实机回归：DSH 0.2.1 环境选 `opencode-bridge` 模型发起带推理等级的请求，确认不再出现 `UNSUPPORTED_REASONING_EFFORT` 与 `imageRequestTarget TypeError`。
