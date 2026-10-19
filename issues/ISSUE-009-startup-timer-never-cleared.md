# ISSUE-009 startup 超时计时器全程不清除：所有 >30s 的回合被误杀，且超时被零文本保险伪装成正常输出

- 状态：fixed
- 发现日期：2026-10-19
- 相关文件：`src/run-cli.ts`、`src/cli-bridge.ts`、`src/to-dsh-chunks.ts`（受害层）、`test/unit/run-cli.test.mjs`、`test/unit/stream-dsh-chunks.test.mjs`、`test/fixtures/fake-opencode.mjs`

## 现象

opencode 路由子代理派发实测（2026-10-19，见 `docs/SUBAGENT-BEHAVIOR.md`）中，3 个 free 模型首轮全部「工具调用 + 零文本」收尾、报告丢失；追问后 glm-5.3 三轮全灭。`~/.dsh-opencode-bridge/requests.log` 显示诡异规律：

- 所有死亡回合时长都卡在 **33.0~33.5s**（三路并行回合甚至在 84ms 内同时断气）；
- 正常出文本的回合要么 < 30s 完成，要么也被砍在 30s 附近（mimo 31.3s、deepseek 36.7s，报告侥幸在被砍前吐完）；
- glm 第三轮明确记为 `finish=error:TIMEOUT`（33.0s）；而其余死亡回合却被记为 `finish=stop`，并输出「[OC-bridge] 本轮模型执行了工具（…）但没有产生文本输出。」

## 原因

两层缺陷叠加：

**A. 主因（run-cli.ts）：`startupMs` 计时器注册后无人清除。**

```js
addTimer(timeouts.totalMs, "total");        // 30 分钟
addTimer(timeouts.firstEventMs, "firstEvent"); // 45s，首个事件到达时清除
addTimer(timeouts.startupMs, "startup");      // 30s，无人清除 ← BUG
resetIdle();                                  // 600s
```

`firstEvent` 有 `markFirstEvent()` 清除、`idle` 有 `resetIdle()` 续期，唯独 `startup`（默认 30s）从注册起计满即触发 `finish()` → `child.kill()` + `shutdownMs`（3s）宽限 + `killTree`——即 **33 秒死刑墙**。而 `startupMs` 的设计语义（既有单测名写得明明白白：「startup 超时：**spawn 成功但无任何事件**时触发」）是"无事件看门狗"，首事件到达就该解除。所有需要 >30s 的回合（工具链 + 推理）都会死在回合进行中。

**B. 掩护层（cli-bridge.ts / to-dsh-chunks.ts）：超时死亡被伪装成正常收尾。**

进程被超时击杀时，`mapper.finalize()` 因「已见过 step_finish」而不再产出 error 事件；末尾陈旧的 `step_finish(tool-calls)` 冒充最终收尾进入转换器；零文本保险（解禁批 #3）再把它改写成 `stop` 并输出友好提示语。于是「超时被杀」呈现为「模型没说话」的正常输出——正是子代理场景三路报告丢失的直接机制。只有从未见过任何 finish 的死亡（glm 第三轮）才被正确分类为 `TIMEOUT`。

**为什么此前未暴露**：208 条单测的假 CLI 全部秒回（startupMs=5000 从未到点）；QA 问答与集成用例都在 30s 内完成。只有子代理这类"工具+推理"长回合才会踩中。

## 修复方案

1. **`src/run-cli.ts`（主因）**：`addTimer` 为 `startup` 层保留句柄，`markFirstEvent()` 在首个事件到达时同时清除 `firstEvent` 与 `startup` 两个计时器（与测试名声明的语义对齐）；`clearTimers()` 同步置空。
2. **`src/cli-bridge.ts`（掩护层）**：`executeCall` 在 `outcome.timedOut` 时检查回合是否自然收尾（末个 finish 为 `stop`/`max-tokens`）；未自然收尾且无 error 事件时补发 `error(TIMEOUT)` 事件，使 DSH 如实看到超时失败，不再被零文本保险吞掉。回合已完整（如正文已吐完、进程退得慢被顺手 kill）则不误报。
3. **测试**：`test/fixtures/fake-opencode.mjs` 新增 `tool-only-hang` 模式（工具步收尾后僵死）；`test/unit/run-cli.test.mjs` 新增「startup 不误杀：首事件已到达的长回合（>startupMs）正常完成」；`test/unit/stream-dsh-chunks.test.mjs` 新增「超时击杀不得被零文本保险吞掉」。另修正原 startup 用例（其描述为"无任何事件"，实现却用会发事件的 `hang` 模式，被本 bug 反向遮蔽，改为真正无 stdio 的子进程）。
4. **验证**：两用例先红后绿；全量单测 210/210 通过（原 208 + 新 2）。红灯输出即伪装现场的完整快照：`🔧 bash[OC-bridge] 本轮模型执行了工具（bash）但没有产生文本输出。`
5. **生效验证（运行中 DSH 插件）**：安装为 junction（`%USERPROFILE%\.dsh\profiles\desktop\node_modules\@home-river\dsh-opencode-bridge` → 工作区），盘上 `lib/` 已是新码，但 2026-10-19 01:50Z 的实测回合仍死在 33.0s（`finish=error:TIMEOUT`）——按 spec §8.1「`step_start` 数秒内必到」，新码下该回合不可能被 startup 层击杀，故判定**进程内仍是旧模块**（01:41:35Z 的 `BRIDGE_LOADED` 热重载未真正替换模块实例）。**修复生效需要重启 DSH**（已于 10:02 重启，02:02:50Z 新 `BRIDGE_LOADED`）；**复验通过（02:03–02:05Z）**：deepseek 40 秒计时实验以 **77.3s** 完整交付（`RESULT: TASK-DONE-40S`，`finish=stop`，旧码必死 33.0s）；mimo 模拟测试回报 27.7s 交付 897 字完整报告（工具+正文同回合，保真与真值一致）。
6. **独立 E2E（已通过，2026-10-19）**：`tmp-verify-issue009.mjs`（tmp-* 不入库）绕过 DSH 以修复后的 `lib/` 直调真实 CLI，800 字长回答实测 **49.3s 完整返回**（`reason:"stop"`、正文 1047 字、usage 正常），远超 33s 墙而未被击杀——旧码下此回合必死（正文按 spec §8.1 整段吐、约 49s 才到，33s 时零正文）。与之互证：01:50Z 的实验回合死在 33.0s/零正文，正是旧码签名。
