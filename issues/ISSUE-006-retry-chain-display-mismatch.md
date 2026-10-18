# ISSUE-006 重试链失败信息混排、计数/耗时数字互相打架（DSH 侧展示）

- 状态：open（DSH 侧问题，已记录归属；插件侧缓解已落地）
- 发现日期：2026-10-18
- 相关文件：`src/adapter.ts`（缓解：`providerRetryPolicy`）；问题本体在 DSH 重试 UI

## 现象

实机失败轮（ISSUE-001/ISSUE-005 的 15:36 那轮，3 次 TIMEOUT + 1 次 PROTOCOL_ERROR）在 DSH UI 的
「处理失败」块中显示：

```text
已重试模型请求（2/5）· 1s ⌄
重试延迟：980 毫秒
失败原因：OpenCode CLI timed out
● 本轮运行失败  OpenCode CLI output protocol error            PROTOCOL_ERROR
```

三处不自洽：

1. **失败原因与最终错误矛盾**：「失败原因」写 `OpenCode CLI timed out`（某次中间尝试的失败），
   最终标记却是 `OpenCode CLI output protocol error / PROTOCOL_ERROR`（最后一次尝试的失败）——
   两个不同尝试的失败信息混排在同一块里，用户无法判断「到底为什么失败」；
2. **计数与时间打架**：「已重试模型请求（2/5）· 1s」但「重试延迟：980 毫秒」、整轮「已完成，用时 33 秒」
   （实际取证：4 次 dispatch 跨约 78 秒，单次 33s 超时）——「1s」「980ms」「33s」与真实时间线对不上；
3. **完成语义误报**：失败块与「已完成，用时 33 秒」同屏，回合观感矛盾。

## 原因

- **归属：DSH 重试 UI 的展示层**（插件侧每次 finish 的 `failure.message` 与 `failure.code` 严格一一对应
  （`to-dsh-chunks.ts` FAILURE_MESSAGES），不存在单次 finish 内的信息矛盾；混排发生在 DSH 组合多次
  尝试的失败信息时——「失败原因」取了早次尝试、「本轮运行失败」取了末次尝试）。
- 重试放大了展示问题：DSH 默认重试策略 `maxRetries` 为 5（0.2.x asar `resolveRetryPolicy`
  默认值），且默认 `retryableCodes` 含 `TIMEOUT`——对本插件这种 **CLI 进程级失败**（每次重试 = 重新
  spawn + 30s 级等待）重试代价极高，失败链一长，展示混乱被放大（取证：一次回合 4 次 dispatch）。

## 修复方案（修复后填写）

插件侧缓解（已落地，2026-10-18）：

- `src/adapter.ts` 的 `providerRetryPolicy()` 返回 `{ mode:"normal", maxRetries:1,
  retryableCodes:["RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],
  backoff:{ initialDelayMs:1000, maxDelayMs:3000, jitterRatio:0.2 } }`（形状对齐
  `resolveRetryPolicy` 解析输出，`dsh-types.ts` 镜像 `DshResolvedRetryPolicy`）——
  对齐 TODO-21「每轮最多一次内部重试，避免 DSH 长时间悬挂」，失败链最多 2 次 dispatch，
  等待与展示噪音都显著下降。单测断言策略形状。
- **建议反馈 DSH**：重试块的「失败原因」应与「本轮运行失败」使用同一次（末次）尝试的失败信息，
  或按尝试逐条列出；计数/耗时应与真实时间线一致。
