# ISSUE-008 子代理派发场景零文本收尾导致结果丢失

- 状态：fixed（根因为 [ISSUE-009](./ISSUE-009-startup-timer-never-cleared.md)；残余风险见修复方案）
- 发现日期：2026-10-19
- 相关文件：`src/`（零文本保险兜底逻辑）、`test/simulation/subagent-sim.test.mjs`（探针）

## 现象

在 DSH 用 `subagent` 工具派发 opencode 路由（opencode-bridge provider）子代理执行任务时，子代理首轮高概率以「工具调用 + 零文本」方式收尾，最终交付内容全部丢失，父代理只能收到桥接的零文本兜底通知：

```
🔧 bash🔧 bash🔧 bash🔧 bash[OC-bridge] 本轮模型执行了工具（bash）但没有产生文本输出。
```

复现（2026-10-19，三模型 3/3 命中）：

1. 派发 `opencode/deepseek-v4.1-flash-free` / `opencode/glm-5.3-flash-free` / `opencode/mimo-v2.6-flash-free` 子代理，要求执行 `test/simulation/subagent-sim.test.mjs` 并按 5 段格式回报；
2. 三路首轮全部以「🔧 工具进度 + [OC-bridge] 零文本兜底」收尾，报告 0 字回收；
3. 父代理追问补交后，deepseek-v4.1 / mimo-v2.6 一轮即恢复并交付完整报告；glm-5.3 连续两轮仍零文本收尾，第三轮被明令「纯文本、禁工具」后执行失败且无收尾消息，3 轮 0 交付。

伴随现象：模型跨回合看不到上一轮的工具结果（deepseek / mimo 均独立自述「只有执行过 bash 的记录、没有输出」），因此重跑取证才拿到数据。

## 原因（2026-10-19 追根后改写：现象是零文本，根因是超时误杀 + 掩护层）

初判「free 模型惯于工具轮后零文本收尾」**不成立**。`~/.dsh-opencode-bridge/requests.log` 证明所有"零文本"回合都是被 **33s 超时墙**（ISSUE-009：startup 计时器全程不清除）杀死的进行中回合，再被掩护层伪装成正常输出：

1. **主因（ISSUE-009）**：`startupMs`（30s）计时器无人清除、全程计时，杀掉一切 >30s 的回合（+`shutdownMs` 3s = 33s 墙，与 requests.log 中 33.0~33.5s 的死亡时刻逐条吻合）；
2. **掩护层**：被杀时 `mapper.finalize()` 因已见过 step_finish 而不报错，陈旧的 `step_finish(tool-calls)` 冒充正常收尾，零文本保险再把它改写成 `stop` + 提示语——「超时死亡」呈现为「模型没说话」；
3. **派发侧放大**：DSH 子代理 harness 把这段兜底提示当作最终回答回传，回合结束，工具产出无文本载体，结果丢失；
4. **跨回合**：只有文本进对话历史，工具结果不回灌，续接轮无法引用上一轮工具产出（deepseek/mimo 独立自述印证）。

## 修复方案

- 根治见 [ISSUE-009](./ISSUE-009-startup-timer-never-cleared.md)：① `startup` 计时器随首个事件解除（33s 墙拆除）；② 被击杀且回合未自然收尾时如实上报 `error(TIMEOUT)`，零文本保险不再吞掉超时。全量单测 210/210。
- 残余风险（未修，观察）：真·工具轮零文本（模型自愿以工具步结束回合）仍会以提示语收尾，在子代理场景仍无结果载体。缓解手段（暂不改代码）：派发 prompt 写明「先输出文本结果再调用工具」；若后续实测仍高发，再考虑桥接侧续跑（零文本时不终结回合、驱动 OC 直到产出文本）。
- 跨回合工具结果不回灌（第 4 条）为独立特性，见 `docs/SUBAGENT-BEHAVIOR.md`，暂不处理。
