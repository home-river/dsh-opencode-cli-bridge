# ISSUE-003 DSH 0.2.1 升级后 LlmAdapter 合同漂移（imageRequestTarget 缺失 / reasoning 校验收紧）

- 状态：open
- 发现日期：2026-10-17
- 相关文件：`src/adapter.ts`、`src/dsh-types.ts`、`docs/research/dsh-llm-contract.md`
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

（待定：候选 A 为 `OpencodeBridgeAdapter` 增加与基类同语义的 `imageRequestTarget` 默认实现；
候选 B 为 `resolveModel` 按 OpenCode 模型能力声明 `reasoning.efforts` 或经 `llm/stream`
waterfall 抹掉 reasoningEffort；同时更新七方法→八方法合同的单测断言。）
