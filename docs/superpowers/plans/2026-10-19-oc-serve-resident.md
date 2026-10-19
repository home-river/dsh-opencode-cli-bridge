# OC serve 常驻传输（真流式 + 空闲关停）后续计划

> **状态：待执行（deferred）** —— 2026-10-19 记录留档，**本轮不实现**。执行前先做 Task 0 勘察并回填开放问题。
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 传输层从「每轮一次 `opencode run` 进程」升级为「常驻 `opencode serve`（HTTP + SSE）」：省掉每轮进程启动开销、拿到真流式；**空闲 5 分钟自动关停**控制资源占用；`run` 路径保留为降级。

**Architecture:** 单例 serve 进程（每 DSH 宿主一个）承载全部 OC 会话；`sessions.json` 绑定层（已合并）原样复用；每轮消息 = 一次 HTTP 调用 + SSE 事件流，接入现有 `map-events → to-dsh-chunks` 管道；空闲计时器（默认 300s）停服务，新消息自动拉起；serve 不可用时无感降级 `run --session`。

**Tech Stack:** `opencode serve`（HTTP/OpenAPI + SSE，见 `opencode-docs/server.md`）、现有 TypeScript 桥接链路、`node:test`。

**Spec:** 本文自包含；前置已落地能力见 `docs/superpowers/plans/2026-10-19-oc-session-passthrough.md`（会话绑定/增量透传/回传映射，已合并 main）。

---

## 0. 原因结论（为什么值得做、为什么必须是 serve）

1. **`opencode run` 留不住进程**：一次性命令，吃完 prompt → 跑完一个回合 → 打印完事件流即退出，没有"喂下一条消息"的协议。"后台留存"的唯一可行载体是常驻服务进程。
2. **每轮 1~3s 启动开销**（spawn + CLI 初始化 + 会话载入）：短回合占比可达 ~10%；子代理连续追问场景尤其明显。
3. **假打字机退役**：`run --format json` 整段吐（spec §8.1 实测），现在的打字机是 22ms/块的模拟节奏；serve SSE 是真 token 流，直通后呈现质变——这通常是比省启动时间更大的体验收益。
4. **5 分钟空闲关停 = 资源边界**（用户裁定）：不做永久常驻，交互密集时热、闲置自动释放。

## 1. 目标架构

```
DSH 会话 ──► adapter（绑定/增量/账本，复用）
                │ 传输选择器：serve 可用？ ──是──► ServeClient ──HTTP+ SSE──► opencode serve（常驻）
                │                        └─否──► run --session（现状路径，降级）
                ▼
        map-events → to-dsh-chunks（复用；SSE 真 delta 直通）
```

- **单例归属**：每个 DSH 宿主进程一个 serve 实例，多会话共享；生命周期挂宿主（DSH 退出即清理）。
- **空闲关停**：最后一条消息完成后启动 `idleShutdownMs`（默认 300_000ms，可配置）计时器，到点停服务；期间新消息取消计时。
- **崩溃/半死**：健康检查失败 → 杀树重启一次 → 仍失败降级 run。

## 2. 执行任务（概要分解，执行时细化为 TDD 步骤）

- [ ] **Task 0：serve 能力勘察（spike）**——用真实 `opencode serve` 回答 §3 全部开放问题，把结论回填本文档再细化后续任务。产出即勘察报告，不留代码。
- [ ] **Task 1：ServeClient**——起停、健康检查、空闲关停计时器、崩溃重启、Windows 进程树清理（复用现有 `killTree`）。
- [ ] **Task 2：SSE → 事件管道适配**——SSE 事件归一为现有 `CliBridgeEvent`（`map-events` 尽量复用）；真 token delta 直通 `text-delta`/`reasoning-delta`。
- [ ] **Task 3：传输选择器 + 配置**——serve 优先、run 降级（降级不重建会话，绑定层无感）；`config.json` 增 `transport: "auto"|"serve"|"run"`、`idleShutdownMs`。
- [ ] **Task 4：真流式呈现**——serve 模式关闭 `paceMs` 模拟节奏；run 模式保留现状。
- [ ] **Task 5：集成验收 + 文档**——新增延迟对比与空闲关停集成用例；更新 README/memory.md。

## 3. 开放问题（Task 0 必须裁定，否则不得细化实现）

1. SSE 事件形状与 `run --format json` 的差异：是否有真 token delta？tool 事件（tool_use/tool_result）形状是否一致？
2. serve 的会话存储与 run 是否同一套（`--session` 的 `ses_*` 在 serve 侧互通吗）？切换传输层会话是否无感续接？
3. 鉴权与端口：`OPENCODE_SERVER_PASSWORD`、本地端口选择/冲突策略、多 DSH 宿主并存时的单例归属。
4. 常驻进程的资源实测：内存占用、空转 CPU、Windows 下的进程树形态（是否派生 git 等子进程）。
5. 空闲关停与进行中请求的竞态：计时器触发瞬间新消息到达的处置（取消关停 vs 重启后重放）。

## 4. 验收标准

- [ ] 短问答连续 3 轮：第 2/3 轮首字节延迟较现状**显著下降**（记录前后对比数字入 memory.md）。
- [ ] 真流式可见：文本逐段到达而非整段弹出（run 降级路径除外）。
- [ ] 空闲 `idleShutdownMs` 后 serve 进程消失（tasklist 断言），新消息自动拉起并正常回答。
- [ ] serve 故意杀死后下一请求自动降级 run，会话续接不断（追问工具输出仍可答）。
- [ ] 现有全量单测与 R12 保持全绿；`npm run test:integration` 不回归。

## 5. 风险与边界

- 生命周期复杂度是本轮主要成本：起停/端口/崩溃/半死/进程树都要兜；出问题时的降级路径（run）必须永远可用。
- 常驻服务带来新的安全面（本地端口 + 鉴权），默认仅绑定 localhost。
- 本计划**不改变**已定架构原则：工具面归属 OC、不产 tool-call 块（双重执行防护）、账本增量透传语义不变。
