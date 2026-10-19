# 子代理派发行为实测（opencode 路由）— SUBAGENT-BEHAVIOR

> 实测日期：2026-10-19（第二轮探针）
> 方法：`test/simulation/subagent-sim.test.mjs` 自包含探针套件 + DSH `subagent` 工具派发 3 个 opencode-bridge 路由模型各 1 份，对照派发方持有的基准真值做回传保真校验。
> 关联：[ISSUE-008](../issues/ISSUE-008-subagent-zero-text-close.md)（零文本收尾结果丢失，open）。

---

## 1. 探针设计

`test/simulation/subagent-sim.test.mjs`（自包含、零 `lib/` 依赖，可任意环境独立执行）：

- **模拟层 5 条**：StreamChunk 文本归一、事件映射 tool_use callID 去重、重试策略收紧（ISSUE-006 结论）、模型目录过滤、异常兜底零文本；
- **探针层 5 条**：运行环境（Node/平台/CWD）、自身源码封条 `PROBE-SEAL-2026-10-19` 防篡改、DSH_* 环境变量仅报名、跳过/todo 回传保真、写文件能力（刻意 skip）；
- **防作弊设计**：预期汇总**不写入被测文件与诊断输出**（否则执行方读一眼即可照抄），真值只在派发方手里；
- 1 条 skip + 1 条 todo 刻意制造非平凡汇总形状（`skipped=1 / todo=1`），检验执行方是否会误报为 fail。

**基准真值**（派发方进程内跑 `node test/simulation/subagent-sim.test.mjs`）：

```
tests 11 / suites 0 / pass 9 / fail 0 / cancelled 0 / skipped 1 / todo 1
SELF bytes=5910；ENV node=v24.18.1 platform=win32 arch=x64
DSH_ENV count=6 names=DSH_HOME,DSH_PROFILE,DSH_PROFILE_DIR,DSH_SESSION_ID,DSH_SHELL,DSH_WEB_URL
```

## 2. 派发结果矩阵

| 路由 | 首轮收尾 | 补交情况 | 交付 | 回传保真 | 约束遵守 |
|---|---|---|---|---|---|
| `opencode/deepseek-v4.1-flash-free` | 🔧 bash×4 + 零文本兜底（报告丢失） | 追问 1 轮即完整交付 | ✅ | ✅ 逐项一致 | ✅ 未改文件 |
| `opencode/mimo-v2.6-flash-free` | 🔧 glob/bash/read + 零文本兜底（报告丢失） | 追问 1 轮即完整交付 | ✅ | ✅ 逐项一致 | ✅ 未改文件 |
| `opencode/glm-5.3-flash-free` | 🔧 glob/read + 零文本兜底（报告丢失） | 第 2 轮仍零文本；第 3 轮（禁工具、纯文本）**执行失败且无收尾消息** | ❌ 3 轮 0 交付 | 无从校验 | ✅ 未改文件 |

保真校验细节（deepseek / mimo 两份报告）：汇总 `11/9/0/0/1/1` 与真值逐项一致；`SELF bytes=5910` 一致（封条证明未被篡改）；FIDELITY 诊断行逐字一致；duration 不同（88.57 / 89.85 vs 基准 12.07，属 `node --test` 起子进程 vs 进程内的正常差异）。**未发现任何编造数字**；两位均主动声明"上轮工具输出不在上下文、系重跑取证"，deepseek 还区分了同一测试的两次运行（乱码次 + UTF-8 次）。

## 3. 特性结论

### 3.1 首轮「工具调用 + 零文本」收尾高发，结果直接丢失（3/3）

三路首轮全部以 `🔧 工具` 进度块 + `[OC-bridge] 本轮模型执行了工具（…）但没有产生文本输出。` 兜底通知收尾。主会话场景下这句兜底是"降级体验"，在子代理派发场景里它会被 harness 当作子代理的**最终回答**回传——工具产出没有文本载体，结果永久丢失。→ ISSUE-008。

### 3.2 跨回合工具结果不回灌上下文（2/2 独立印证）

deepseek 与 mimo 在补交轮均自述"只有执行过 bash 的记录，没有输出内容"，被迫重跑取证。含义：**取证与报告必须在同一回合内完成**，跨回合只能拿到文本消息历史。

### 3.3 工具面：无 `send_message`，`task` 在列但委派深度为 0

三路自报工具清单一致：`bash, edit, glob, grep, read, skill, task, todowrite, webfetch, websearch, write`（deepseek/mimo 明确报告，glm 未交付）。要点：

- **没有 `send_message`**（3/3 口径一致）：回传父代理的唯一通道是收尾文本——与 memory.md「DSH 工具结构上不可达（tool-call 块不过桥）」的架构裁定吻合；
- **`task` 工具在清单里但委派深度剩余 0**，调用子代理会被拒（deepseek 报告）：嵌套派发不适用于 opencode 路由；
- 子代理持有 `edit`/`write` 写能力，**是否越界完全靠指令约束**（本次 3/3 遵守，git status + 封条双佐证）。

### 3.4 执行环境与父会话不同（两处实测差异）

- **spawn 限制不同**：父会话 pwsh 沙箱内 `node --test` 因 spawn 子进程被 `EPERM` 拦截（每文件起子进程是 node --test 的实现方式），只能进程内 `node <文件>` 跑；子代理 bash 则可直接 `node --test` 成功（duration ~89ms 符合 spawn 特征）。写探针类任务时两种命令都要能跑。
- **DSH_* 环境变量不同**：父 pwsh 6 个（`DSH_HOME, DSH_PROFILE, DSH_PROFILE_DIR, DSH_SESSION_ID, DSH_SHELL, DSH_WEB_URL`），子代理进程只有 1 个（`DSH_CLIENT_VERSION`）。deepseek / mimo 两次独立运行报出同样的值，可信。

### 3.5 适应性与诚实度（deepseek / mimo 表现良好）

- deepseek 遇 PowerShell 5.1 控制台默认编码把中文与 ✔/ℹ/﹣ 打成 `�?`，自行改用 `[Console]::OutputEncoding = UTF8` 重跑拿到可逐字引用的原文，并如实区分两次运行；
- 两位在无法引用上轮输出时选择**坦白 + 重跑**，而不是编造引用。

### 3.6 模型差异：glm-5.3-flash-free 不适合"必须回传结果"的派发

同样指令下，deepseek-v4.1 / mimo-v2.6 均一轮补交恢复；glm-5.3 连续两轮工具调用后零文本，第三轮被明令"纯文本、禁工具"后直接执行失败、无收尾消息，3 轮 0 交付。

## 4. 对派发的实用建议

1. 派发 prompt 把「**先输出文本结果，再调用工具（或不调用）**」写成硬约束，缓解 3.1；
2. 明确要求「取证与报告在同一回合完成」，并让报告自含数据（不能引用工具输出）；
3. 父侧必须持有保真锚点（预期值不进被测文件），逐项比对汇总与关键诊断行；
4. 必备追问补交通道：首轮零文本后追问一轮即可恢复（glm 除外）；
5. 需要 `send_message` 多轮协作或嵌套派发的场景，不要用 opencode 路由；
6. 模型选型：交付型任务选 `deepseek-v4.1-flash-free` 或 `mimo-v2.6-flash-free`；`glm-5.3-flash-free` 仅建议用于不需要回传正文的场景。

## 5. 根因追记（2026-10-19，ISSUE-008/009）

本文第 3.1 节「首轮零文本收尾高发」的结论**已被根因调查修正**：那些"零文本"回合并非模型行为，而是被 **33s 超时墙**（[ISSUE-009](../issues/ISSUE-009-startup-timer-never-cleared.md)：`startupMs` 计时器全程不清除，30s + shutdownMs 3s）杀死的进行中回合，再被「陈旧 step_finish(tool-calls) + 零文本保险」伪装成正常提示语。`~/.dsh-opencode-bridge/requests.log` 中死亡时刻 33.0~33.5s 的聚类、以及 glm 第三轮的 `finish=error:TIMEOUT`（33.0s）为直接证据。修复后 3.1 的现象预期消失；3.2~3.6 的观察（跨回合工具结果不回灌、无 `send_message`、委派深度 0、环境差异、模型差异）不受影响。glm 三轮全灭的机理：它出首轮文本最慢，每轮都死在 33s 墙内。

## 6. 复现

```powershell
# 派发方基准（注意：父沙箱内 node --test 会 EPERM，须进程内跑）
cd F:\project\DSH\plugin-dev\dsh-opencode-bridge
node test/simulation/subagent-sim.test.mjs
# 子代理侧（bash 工具内）两种都可
node --test test/simulation/subagent-sim.test.mjs
```

派发 prompt 要点：硬性禁止改文件/禁 build；命令自选但如实回报命令链；5 段格式（MODEL / TOOLS / COMMANDS / OUTPUT 逐字 / ANOMALY）。
