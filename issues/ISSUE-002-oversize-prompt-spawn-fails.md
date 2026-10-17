# ISSUE-002 超长 prompt 触发 CLI_START_FAILED（Windows 命令行上限），表现为请求空气泡

- 状态：fixed
- 发现日期：2026-10-17
- 相关文件：`src/cli-bridge.ts`、`src/run-cli.ts`

## 现象

- **触发条件**：压平后的 prompt（system + 消息历史）超过 Windows 命令行上限（32,767 字符）；
- **表现**：`spawn` 直接失败，抛 `CliBridgeError: CLI_START_FAILED: failed to spawn ...`；经 `toDshChunks` 落成 error finish（`OpenCode CLI failed to start`）→ DSH 渲染为空气泡（无正文无报错字样）；
- **复现步骤**（修复前）：`runCliBridge({ prompt: "x".repeat(40_000), ... })` → 抛 `CLI_START_FAILED`；单测 `test/unit/cli-bridge.test.mjs`「40K 超长 prompt」即该复现的固化；
- **影响面**：长对话（历史累积）与大 system 注入的会话迟早触发；与 ISSUE-001（工作区提问空气泡）症状一致，是否为同一根因待取证日志定案。

## 原因

prompt 此前作为**位置参数**放进 argv（`args.push(opts.prompt)`）。Windows 的 CreateProcess 命令行总长上限为 32,767 字符，node 的 `spawn` 会把 command + 全部 argv 拼成一条命令行；prompt 一大就超限，`spawn` 同步失败。

## 修复方案（2026-10-17）

- `src/run-cli.ts`：`RunCliOptions` 新增 `stdinText?: string`；spawn 的 stdio 从 `["ignore","pipe","pipe"]` 改为 `["pipe","pipe","pipe"]`，spawn 后立即 `child.stdin.end(stdinText)` 写完即关；`child.stdin` 挂 error 处理器吞掉子进程提前退出导致的 EPIPE。
- `src/cli-bridge.ts`：`buildArgs` 不再把 prompt 推入 argv（附上限说明注释）；`executeCall` 经 `stdinText: opts.prompt` 送达。
- **为什么走 stdin**：实测 `opencode run` 在无位置参数时从 stdin 读 message（1.19.0，回执验证正常）；管道无 32K 上限，顺带消除 argv 引号/控制字符转义风险，并天然满足"写完关 stdin"（兼修 Ruling P19 在本 spawn 的同类隐患）。
- **验证**：新增 fixture 模式 `stdin-echo`（回显 stdin 字符数）+ 两条单测（常规 prompt `STDIN_LEN=5`、40K prompt `STDIN_LEN=40000`），修复前红（`STDIN_LEN=0` / `CLI_START_FAILED`）、修复后绿；全量 170/170 通过；真 CLI 40K prompt 复测通过。

## 备注

- Ruling P19（`catalog-store.ts` 的 `runModelsCli` spawn 未关 stdin）仍待顺手修，见 todo.md；
- ISSUE-001 的根因认定依赖 `~/.dsh-opencode-bridge/` 取证日志（若失败请求 `promptChars > 32K` 且 `finish=error:CLI_START_FAILED`，则本 issue 即其根因）。
