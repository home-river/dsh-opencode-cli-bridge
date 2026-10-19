# ISSUE-001 opencode CLI 在日志目录不可写时启动即失败

- 状态：open（已有规避手段，未在插件内落地）
- 发现日期：2026-10-17
- 相关文件：`src/plugin.ts`、`src/cli-bridge.ts`（`spawn` 的 `env` 传递）

## 现象

在 DSH 命令沙箱（文件策略 `workspace-write`）里跑 `opencode run --format json ...`，命令立刻以 exit=1 结束，stdout 只有：

```text
Error: Unexpected error

Unknown: FileSystem.open (C:\Users\<user>\.local\share\opencode\log\opencode.log)
```

复现步骤：

1. 在「工作区之外不可写」的进程环境里（例如 DSH 沙箱 workspace-write、只读 HOME、受限令牌）；
2. 执行 `opencode run --format json --model opencode/mimo-v2.6-flash-free --dir <dir> "say hi"`；
3. 必现，与模型、`--dir`、prompt 无关；`opencode --version` / `--help` 不受影响（它们不碰日志）。

排查过程中的干扰现象（易误判）：

- 同一时段本机另有 opencode 会话在写同一日志文件，导致「文件被占用」的表象（`ReadAllBytes` 报 being used by another process）；
- 换独立 `USERPROFILE` 后，日志错误消失、暴露出下一层阻塞 `EPERM: operation not permitted, uv_spawn 'git'`（opencode 在 git 仓库目录里会拉 git 做快照跟踪）。

## 原因

opencode CLI 启动的第一步就是以追加方式打开全局日志文件 `~/.local/share/opencode/log/opencode.log`。该路径在**工作区之外**，一旦当前进程无权写它，CLI 在执行任何子命令逻辑之前就中止——`run`、`models` 等一律失败。

验证（同一沙箱内）：

```powershell
Set-Content "C:\Users\<user>\.local\share\opencode\log\sandbox-write-probe.tmp" "probe"
# UnauthorizedAccessException / Access to the path ... is denied.
Set-Content "$env:TEMP\sandbox-write-probe.tmp" "probe"
# 成功
```

即：**不是 opencode 的 bug，也不是日志文件被锁，而是运行环境对 `~/.local/share/opencode` 无写权限**。日志里也没有对应 ERROR 记录（它根本没能打开日志）。官方文档 `opencode-docs/cli.md` 的环境变量表中**没有**可重定向数据/日志目录的变量（只有 `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR`）。

## 规避方案（已实测有效）

给 CLI 进程一个可写的 `HOME`/`USERPROFILE`（Windows 下 Go/Bun 取 `USERPROFILE`），例如指向 `%TEMP%`：

```powershell
$env:USERPROFILE = "$env:TEMP\oc-probe-home"; $env:HOME = $env:USERPROFILE
opencode run --format json --model opencode/mimo-v2.6-flash-free --dir $work "say hi"
# 正常产出 step_start / text / step_finish JSON 事件
```

注意两点：

1. `--dir` 用**非 git 目录**，否则 opencode 会拉起 `git` 做快照跟踪，在某些受限环境里二次报 `EPERM: uv_spawn 'git'`；
2. 换 HOME 后 `~/.local/share/opencode/auth.json` 也跟着换目录，需要保证凭据仍可用（免费模型路径实测可用）。

## 待办（插件侧）

在 `src/cli-bridge.ts` 的 `spawn` 环境里，当检测到默认数据目录不可写时自动重定向 `HOME`/`USERPROFILE` 到插件自己的可写目录（如 `~/.dsh-opencode-bridge/`），并把该现象记入 `diagnostics.log`。落地后在本文件补「修复方案」。
