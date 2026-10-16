# OpenCode CLI 行为实测记录

> 记录时间：2026-10-15
> 性质：**实测证据**，不是设计建议。每条结论都有原始输出佐证。
> 范围：`opencode` CLI 的可执行入口、参数传递保真度、进程树与清理行为。
> 用途：作为 `CliBridge` 模块（OC → 插件段）实现时的硬约束依据。

---

## 0. 一句话结论

```text
执行入口只能用 opencode.exe；
opencode.cmd 既跑不起来（Node 24 抛 EINVAL），跑起来也不安全（命令注入 + 孤儿进程）；
CLI 自身单进程，但会派生 git 子进程，所以杀进程必须用 /T 杀子树。
```

---

## 1. 测试环境

| 项 | 值 |
|---|---|
| 操作系统 | Windows x64 |
| Node.js | `v24.18.1` |
| OpenCode CLI | `1.19.0`（npm 包 `opencode-ai`） |
| npm shim（批处理） | `C:\Users\86181\AppData\Roaming\npm\opencode.cmd`（148 bytes） |
| npm shim（sh） | `C:\Users\86181\AppData\Roaming\npm\opencode`（296 bytes） |
| 真身可执行文件 | `C:\Users\86181\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe` |
| 真身文件属性 | 180,714,888 bytes，**HardLink**，Bun 编译的单文件二进制 |
| PATH 命中的目录 | `C:\Users\86181\AppData\Roaming\npm`（**`bin\` 不在 PATH**） |
| 测试用模型 | `opencode/mimo-v2.6-flash-free` |
| 测试用工作区 | `F:\project\DSH\plugin-dev\tmp-probe-ws`（测后已删） |

`opencode-ai` 包的 `package.json` 关键字段：

```json
{
  "name": "opencode-ai",
  "version": "1.19.0",
  "bin": { "opencode": "./bin/opencode.exe" }
}
```

**注意：npm 官方就把 `bin` 指向 `.exe`，`.cmd` 只是 npm 自动生成的调用包装。**

### 1.1 `opencode.cmd` 完整源码（9 行）

```bat
@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\node_modules\opencode-ai\bin\opencode.exe"   %*
```

末行的 **`%*`** 是全部问题的来源：批处理会把参数**重新解析一遍**再交给 exe。

---

## 2. 测量方法

| 用途 | 手段 |
|---|---|
| 进程枚举 | `tasklist /FO CSV /NH` |
| 进程清理 | `taskkill /PID <pid> /T /F` |
| 被证明不可用的手段 | `Get-CimInstance Win32_Process`（见 §7） |
| 探针脚本 | 一次性 `tmp-probe*.mjs`，测完已全部删除（37 项，剩余 0） |

⚠️ **清理进程永远只按 PID，绝不使用 `taskkill /IM <image> /F`** —— 会误杀机器上 OpenCode Desktop 的常驻进程（`opencode-cli.exe serve`）。

---

## 3. A 段：Node 24 的 spawn 语义

### 3.1 结果

| 用例 | 结果 | 判定 |
|---|---|---|
| A1 `spawn(opencode.cmd, args)` **无 shell** | `SYNC THROW code=EINVAL msg=spawn EINVAL` | 🔴 不可用 |
| A2 `spawn(opencode.exe, args)` **无 shell** | `spawned pid=7732` → `EXIT code=0 elapsed=1962ms` | 🟢 可用 |
| A3 `spawn(opencode.cmd, args)` **`shell:true`** | `spawned pid=16136` → `EXIT code=0`，**附带 Node 弃用警告** | 🟡 能跑但不安全 |
| A4 `spawn(opencode.exe, args)` **`shell:true`** | `spawned pid=26056` → `EXIT code=0` | 🟡 能跑但没必要 |

### 3.2 原始输出

```text
A1 spawn(opencode.cmd, [--version], shell:false)
  -> SYNC THROW  code=EINVAL  msg=spawn EINVAL

A2 spawn(opencode.exe, [--version], shell:false)
  -> spawned pid=7732
  -> EXIT  code=0 sig=null elapsed=1962ms

A3 spawn(opencode.cmd, [--version], shell:true)
  -> spawned pid=16136
(node:20004) [DEP0190] DeprecationWarning: Passing args to a child process with
shell option true can lead to security vulnerabilities, as the arguments are not
escaped, only concatenated.
  -> EXIT  code=0 sig=null elapsed=1047ms
```

### 3.3 结论

1. **`.cmd` 不是可执行文件，是文本批处理，只能由 cmd.exe 解释。**
2. Node 24 起，对 `.cmd` / `.bat` 目标**不带 `shell: true` 会同步抛 `EINVAL`**（源于 Node 的 CVE-2024-27980 修复）。因此
   `spawn("opencode.cmd", argsArray, { cwd })` 这种写法**直接跑不起来**。
3. 要用 `.cmd` 就**必须** `shell: true`；而 `shell: true` + args 数组正是 Node 用 `DEP0190` 明确标记为不安全的用法
   （参数"只连接、不转义"）。
4. 结论：**`.cmd` 这条路是死的** —— 要么跑不起来，要么不安全。

---

## 4. B 段：参数保真度（含命令注入）

### 4.1 实验设计

构造一个和 npm shim **结构完全一致**的临时批处理（末行 `%*`）：

```bat
@ECHO off
node -e "console.log(JSON.stringify(process.argv.slice(1)))" %*
```

向它传入 4 个参数：

```js
["A%USERNAME%B", "x^&y", "C:\\dir\\", "100%"]
```

### 4.2 结果

| 路径 | 实际到达的 argv |
|---|---|
| **B1** 直接 spawn `node.exe`（`shell:false`，基准） | `["A%USERNAME%B","x^&y","C:\\dir\\","100%"]` |
| **B2** 走 `.cmd` 批处理（`shell:true`） | `["A86181B","x"]` + 一条命令执行错误 |
| **B3** 走 `.cmd` 批处理（`shell:false`） | `SYNC THROW code=EINVAL` |

### 4.3 B2 原始输出

```text
B2 走 .cmd 批处理（shell:true，npm shim 的真实路径）
["A86181B","x"]
'y' is not recognized as an internal or external command,
operable program or batch file.
```

### 4.4 逐条破坏分析

| 输入 | 到达 exe 的值 | 发生了什么 |
|---|---|---|
| `A%USERNAME%B` | `A86181B` | `%VAR%` 被 cmd.exe **展开**，用户原文被改写 |
| `x^&y` | 拆成参数 `x`，**并且执行了命令 `y`** | `&` 被当成**命令分隔符**；`y` 被 cmd 当作命令执行 |
| `C:\dir\` | **消失** | 被 `&` 切断的后半段丢弃 |
| `100%` | **消失** | 同上 |

**4 个参数进去 → 2 个残缺参数 + 1 次命令执行。**

### 4.5 结论

1. 直接 spawn `.exe` 时 Node 走 `CreateProcess` + argv 数组，**逐字保真 100%**。
2. 走 `.cmd` + `%*` 时 cmd.exe 会**重新解析参数**，造成
   - **内容改写**（`%VAR%` 展开）；
   - **参数丢失**（`&` `|` `<` `>` 等元字符切断命令行）；
   - **命令注入**（`&` 后的内容被当作命令执行）。
3. ⛔ **本插件的 prompt 是任意用户文本，走 `.cmd` 等于把用户输入直接喂给 cmd.exe 解析器。这是安全问题，不是兼容性问题。**
4. `shell: true` 一律禁止。

---

## 5. C 段：进程树与清理

### 5.1 基线

```text
=== 基线 ===
  opencode.exe     = []
  opencode-cli.exe = []
  git.exe          = []
```

测试时机器上**没有**任何 OpenCode 相关进程，因此下文出现的进程全部由探针产生，判定无干扰。

### 5.2 C1：直接 spawn `opencode.exe`（`shell:false`）

```text
=== C1) 直接 spawn opencode.exe（shell:false）===
  spawn -> cli pid=28988
  [t4s]   opencode.exe = [28988]   (cli.pid=28988)
  [t4s]   git.exe      = [30444,15128,6204,9836,15456,7384,26024,768]
  [t4s]   进程数判定 = 单进程，无 worker
  cli EXIT code=0 sig=null elapsed=21352ms
  [exit]  opencode.exe = []   判定 = 无残留
```

**结论：**

- `opencode.exe` **恰好 1 个进程，PID 就是 `child.pid`** → 调用方拿到的就是真身，不存在中间层。
- 但同一时刻存在 **8 个 `git.exe` 子进程** → CLI 内部会派生 `git` 做 repo 探测 / 快照。
- ⚠️ **推翻一条常见说法**："spawn exe = 1 层进程" 不准确。准确表述是
  **`opencode.exe` 自身单进程，但会派生 `git` 等子进程**。
- 正常路径 exit 0，**无残留**。

### 5.3 C2：走 `.cmd`（`shell:true`）后 `child.kill()`

```text
=== C2) 走 opencode.cmd（shell:true）后 child.kill() ===
  spawn -> wrapper(cmd.exe) pid=9620
  [t4s]   cmd.exe      = [19544,9620]   (wrapper.pid=9620)
  [t4s]   opencode.exe = [4176]   git.exe = [24092]
  >>> wrapped.kill()  —— Node 杀的是【直接子进程】cmd.exe
  wrapper EXIT code=null sig=SIGTERM elapsed=4703ms
  [kill+3s] cmd.exe      = [19544]
  [kill+3s] opencode.exe = [4176]
  >>> 判定 = !! 留下孤儿 opencode.exe !!
  >>> 兜底清理 taskkill /PID 4176 /T /F
      taskkill 输出: SUCCESS: The process with PID 4176 (child process of PID 9620) has been terminated.
  [清理后] opencode.exe = []
  [清理后] git.exe      = []
```

**结论：**

- `.cmd` 路径是**两层**：`cmd.exe (9620)` → `opencode.exe (4176)`，PID 不同。
- `child.kill()` 杀的是**直接子进程 `cmd.exe`**；`opencode.exe` 变成**孤儿继续运行**。
  它会继续占免费额度、继续写 session、继续往一个没人读的管道写 stdout。
- `taskkill` 的输出**官方确认了父子关系**：`4176` 是 `9620` 的子进程。
- `taskkill /PID <pid> /T /F` 兜底清理有效，清理后归零。
- ⛔ **这就是"取消后残留进程"最隐蔽的形态**：表面看进程退了，实际上没有。
  而且它**只在取消/超时路径暴露** —— 正常路径下 cmd.exe 会等 exe 退出，看不出来。

### 5.4 C3：直接 spawn `opencode.exe` 后 `child.kill()`

```text
=== C3) 直接 spawn opencode.exe 后 child.kill() ===
  spawn -> cli pid=24236
  [t4s]   opencode.exe = [24236]  git.exe = [15672,10132,28472]
  >>> cli3.kill()
  [kill+2.5s] opencode.exe = []  git.exe = []
  >>> 判定 = 无残留
```

**结论：** 直接 spawn 真身时，`child.kill()` 杀的就是真身，**2.5 秒内完全归零，无孤儿**。

### 5.5 对比表

| | 直接 spawn `opencode.exe` | spawn `opencode.cmd`（`shell:true`） |
|---|---|---|
| 进程层数 | 真身 1 个（+ `git` 子进程） | `cmd.exe` + `opencode.exe` 两层 |
| `child.kill()` 杀到谁 | ✅ 真身 | ❌ 只杀 `cmd.exe` |
| 取消后残留 | ✅ 无 | 🔴 **留下孤儿 `opencode.exe`** |
| 参数保真 | ✅ 逐字 | 🔴 改写 / 丢失 / **命令注入** |
| Node 24 兼容 | ✅ | 🔴 无 shell 抛 `EINVAL` |
| Node 警告 | 无 | 🔴 `DEP0190` |

---

## 6. 耗时实测（影响超时默认值）

| 场景 | 耗时 |
|---|---|
| `--version` | 857 ~ 1962 ms |
| **一轮真实问答**（极短 prompt） | **21,352 ms** |

⚠️ **[memory.md](../memory.md) 3A.2 记录的"正常路径约 11 秒"偏低**，本次实测为 21.4 秒。
原因可能与工作区 git 扫描（观察到 8 个 `git` 子进程）有关。

**对超时默认值的影响：**

```text
startup    30s    （CLI 启动到首个事件）
firstEvent 45s    （原拟 30s 太紧，会误杀）
idle       120s   （自上一个事件起算，不是自 spawn 起算）
total      10min
shutdown   3s     （kill 前的宽限期）
```

---

## 7. 测量方法踩过的坑（不要重复）

### 7.1 `Get-CimInstance Win32_Process` 不可用

```text
Get-CimInstance : 拒绝访问
+ CategoryInfo          : PermissionDenied: (root\cimv2:Win32_Process:String)
+ FullyQualifiedErrorId : HRESULT 0x80041003
```

受限令牌下 WMI/CIM 被拒绝。**进程树测试必须用 `tasklist` / `taskkill`，不要用 WMI。**

### 7.2 DSH 沙箱会禁 `child_process` 管道捕获

```text
Error: Unexpected error
EPERM: operation not permitted, uv_spawn 'git'
```

这是 `opencode.exe` 内部 spawn `git` 时被沙箱拦下（`stdio: 'pipe'` 走命名管道）。
**这是测试环境限制，不是 CLI 的缺陷。** 真实 DSH 插件运行时不受影响。
在沙箱内做 CLI 集成测试时，要么解除沙箱，要么把 stdio 改为 `'ignore'` / `'inherit'` / 文件描述符。

### 7.3 沙箱还会挡住 CLI 写自己的日志

```text
Error: Unknown: FileSystem.open (C:\Users\86181\.local\share\opencode\log\opencode.log)
```

同样是 workspace-write 沙箱把 `~/.local/` 挡在外面所致，不是 CLI 缺陷。

---

## 8. 由此确定的实现硬约束

| # | 约束 | 依据 |
|---|---|---|
| 1 | **执行入口只能是 `opencode.exe` 真身** | §3、§4、§5 全部 |
| 2 | **禁止 `shell: true`** | §4 命令注入 + Node `DEP0190` |
| 3 | **禁止用 `.cmd` / `.bat` 作为执行入口** | §3 `EINVAL` + §4 + §5 孤儿 |
| 4 | **`.cmd` 只能作为"发现线索"**：命中它时解析出真身 exe | §1.1 npm 布局 |
| 5 | **`taskkill /PID <pid> /T /F` 杀子树是必需项，不是兜底** | §5.2 `git` 子进程 |
| 6 | **禁止 `taskkill /IM`** | §2，会误杀 OpenCode Desktop |
| 7 | **`child.kill()` 只杀直接子进程**，不能假设杀到真身 | §5.3 |
| 8 | **超时按 21s+ 实测留量** | §6 |
| 9 | **参数一律走 argv 数组**，绝不拼接命令行字符串 | §4 |
| 10 | **进程归零验证按 PID 基线做**，不能全机 grep `opencode` | §2 |

### 8.1 CLI 发现优先级（据此定稿）

```text
1. 显式配置的绝对路径              ← 最高优先，尊重用户配置
2. PATH 上的 opencode              ← 命中 .cmd/.ps1/sh shim 时，解析出真身 exe 再用
3. npm 全局 node_modules/opencode-ai/bin/opencode.exe
4. 都找不到 → CLI_NOT_FOUND + 安装提示 "npm i -g opencode-ai"
```

**命中 `.cmd` ≠ 用 `.cmd`。** 既保留"PATH 上能找到"的体验，又拿到单进程 + 参数保真的好处。

---

## 9. 对既有记录的修正

| 文件 | 原记录 | 修正为 |
|---|---|---|
| [memory.md](../memory.md) 3A.2 | "`opencode.cmd` 可作为插件探测到的默认命令" | **错**。只能作发现线索，执行入口用真身 `opencode.exe` |
| [memory.md](../memory.md) 3A.10 | `spawn(opencode.cmd, argsArray, { cwd: workspace })` | **错**。Node 24 上直接抛 `EINVAL` |
| [memory.md](../memory.md) 3A.2 / 3.1 | "正常路径耗时约 11 秒" | **偏低**，实测 21.4s，超时设计按 21s+ 留量 |
| [memory.md](../memory.md) 3A.7 | "本次没有残留 `opencode` 进程" | **结论正确但覆盖不全**：只验了正常路径。取消路径在 `.cmd` 下会留孤儿（§5.3） |

---

## 10. 本次已覆盖 / 仍未验证

### 已由本次实测回答

- [x] Windows 下应 spawn `.exe` 还是 `.cmd` → **`.exe`**
- [x] 是否需要 `shell: true` → **绝对不要**
- [x] 参数是否会被改写 → **`.cmd` 路径会，且可注入；exe 路径逐字保真**
- [x] `child.kill()` 是否足够 → **exe 路径足够；`.cmd` 路径不够**
- [x] 是否需要 `taskkill /T` → **需要**（`git` 子进程）
- [x] 正常路径是否有残留 → **无**
- [x] 取消路径是否有残留 → **`.cmd` 有孤儿，exe 无**
- [x] 一轮问答的耗时量级 → **约 21 秒**

### 仍未验证（留给实现期的集成测试）

- [ ] `--session` 指向不存在 / 失效 session 时的行为
- [ ] `--session` 与 `--dir` 不一致时的行为
- [ ] 同一 session 更换 model 是否允许
- [ ] 中途 kill 后 session 是否已经持久化
- [ ] `tool_use` / `tool_result` 的完整结构
- [ ] 是否存在 `reasoning` / `retry` / `error` 等其他 stdout 事件
- [ ] 多个 `step_finish` 时 usage 是覆盖还是累加
- [ ] 只有 `tool_use` 没有 `text` 时如何结束
- [ ] `--dir` 是否必须绝对路径、workspace 不存在时的行为
- [ ] 非 JSON stderr 在失败路径如何出现
- [ ] JSON 半行 / 超长单行的处理

---

## 11. 如何复现

最小复现脚本（验证 §3 / §4）：

```js
import { spawn } from "node:child_process";

const SHIM = "C:\\Users\\86181\\AppData\\Roaming\\npm\\opencode.cmd";
const EXE = "C:\\Users\\86181\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";

// §3：EINVAL 判定
try { spawn(SHIM, ["--version"]); } catch (e) { console.log("shim no-shell:", e.code); }

// §4：参数保真
const args = ["A%USERNAME%B", "x^&y", "C:\\dir\\", "100%"];
spawn(SHIM, args, { shell: true, stdio: ["ignore", "inherit", "inherit"] });
```

进程树 / 孤儿判定（验证 §5）：

```text
1. tasklist /FO CSV /NH                → 取基线
2. spawn EXE|SHIM 记录 child.pid
3. 等 4 秒，tasklist                   → 看 opencode.exe 的 PID 是不是 child.pid
4. child.kill()
5. 等 3 秒，tasklist                   → 若 opencode.exe 仍在 = 孤儿
6. taskkill /PID <orphan> /T /F        → 兜底清理（保留输出作为父子关系证据）
7. tasklist                            → 确认归零
```

⚠️ 复现时注意：**清理只按 PID**，不要用 `taskkill /IM`；机器上若有 OpenCode Desktop 常驻进程，需先记入基线。

---

## 12. 补充实测：事件流语义与错误通道

> 2026-10-15 第二轮。目的：回答设计 spec §6.3 中 5 个**会改设计**的未决项。
> 探针一次性，已删除；同时验证了 `stdio:'pipe'` 可用性。

### 12.0 预检：`stdio:'pipe'` 可用

```text
=== 预检 stdio:'pipe' ===
  PIPE 可用  exit=0  version=1.19.0
```

`stdio: ["ignore","pipe","pipe"]` 可用，`run-cli.ts` 无需退化到文件描述符。

### 12.1 P1 · 工具调用与多 step（21.5s）

prompt：`请先列出当前目录下的文件，然后用一句话总结。`（临时工作区含 3 个文件）

```text
类型序列 = step_start -> tool_use -> step_finish -> step_start -> text -> step_finish
事件数=6  非 JSON 行=0  sessionID=ses_ebd378c66ffeQVu0WjTl61met2
```

#### 观察

| 观察 | 结论 |
|---|---|
| 2 个 `step_start`、2 个 `messageID` | 多 step 确实存在，`start` 事件会有多条 |
| **`text` 只出现在第 2 个 step** | 不能假设 `text` 在首个 step，也不能假设事件顺序固定 |
| 2 个 `step_finish`，`reason` = `"tool-calls"`、`"stop"` | 映射表已覆盖 |
| **全程无 `reasoning` 事件** | "忽略 reasoning"的保守默认正确 |

#### usage：按 step 报增量，必须累加

```text
step1: total=9553 input=9510 output=19 reasoning=24 cache{read:0,   write:0}
step2: total=9755 input=214  output=24 reasoning=45 cache{read:9472, write:0}

验算：9510 + 19 + 24 + 0    = 9553 ✓
      214  + 24 + 45 + 9472 = 9755 ✓   （total = input + output + reasoning + cache.read）
```

**结论：每个 `step_finish` 报的是该 step 的增量，整轮总用量必须累加。**
→ `usageMode: "sum"` 是正确默认；`total` 字段也可累加。

#### `tool_use` 完整结构

```json
{
  "type": "tool_use",
  "timestamp": 1792121805814,
  "sessionID": "ses_...",
  "part": {
    "type": "tool",
    "tool": "bash",
    "callID": "call_201b653d92264cb78b11663b",
    "state": {
      "status": "completed",
      "input": { "command": "ls" },
      "output": "..."
    }
  }
}
```

⚠️ **`part.type` 是 `"tool"`，不是 `"tool_use"`。** 事件的 `type` 与 `part.type` 命名不一致：

| 事件 `type` | 对应 `part.type` |
|---|---|
| `step_start` | `step-start` |
| `text` | `text` |
| `tool_use` | `tool` |
| `step_finish` | `step-finish` |

**解析时以事件 `type` 为准，不要按 `part.type` 找 `tool_use`。**

### 12.2 P2 · 长回答（60.5s）—— 一条整段，且推翻 idle 默认值

prompt：`请写一篇约 800 字的短文，主题是软件测试的重要性。`

```text
类型序列 = step_start -> text -> step_finish
事件数=3  非 JSON 行=0
text [0] len=1248  messageID=msg_142c8cd7c0018ctldCxic7CUml
       time={"start":1792121827161,"end":1792121873691}
step_finish [0] reason="stop"
       tokens={"total":10334,"input":46,"output":742,"reasoning":74,"cache":{"write":0,"read":9472}}
```

| 观察 | 结论 |
|---|---|
| **只有 1 条 `text`，len=1248** | ✅ **整段一次性，不是 delta 流** —— `map-events` 的设计不用重做 |
| `time.end - time.start` = **46.5 秒** | ⚠️ `text` 事件在**整段生成完之后**才到达 |
| 总耗时 **60.5s** | ⚠️ 远超第一轮的 21.4s |

#### 🔴 由此推翻 `idle = 120s`

`--format json` 是**整段吐**，因此 `step_start` 到 `text` 之间的静默期 **= 整个模型生成时间**：

```text
800 字  → 静默约 46.5s
3000 字 → 静默可能 > 170s        ← idle 120s 会误杀正常回答
```

**`idle` 必须提到 300s。** `firstEvent 45s` 不变（`step_start` 到达得快）。

**修正后的超时默认值：**

```text
startup    30s     （spawn → 首个事件）
firstEvent 45s     （spawn 成功 → 首个事件）
idle       300s    （自上一个事件；实测静默可达 46.5s+，按最长单次生成留量）
total      600s    （实测 60.5s，长回答需更大余量）
shutdown   3s      （kill 前宽限期）
```

### 12.3 P3 · 无效 `--session`（3.0s）—— `SESSION_INVALID` 成立

参数：`--session ses_probe_does_not_exist_00000`

```text
EXIT code=1 sig=null elapsed=3004ms
stdout bytes=0
stderr = "\u001b[91m\u001b[1mError: \u001b[0mSession not found\r\n"
事件数=0
```

| 观察 | 影响 |
|---|---|
| exit 1 + stderr 明确报错 | ✅ **`SESSION_INVALID` 成立**，不是静默新建 session |
| ⚠️ **错误走 `stderr`，不是 stdout JSON** | **错误检测必须读 stderr**，只解析 stdout 事件流会漏掉全部失败 |
| ⚠️ **stderr 带 ANSI 颜色码** `\u001b[91m\u001b[1m` | 解析前必须剥色 |
| ⚠️ **错误是人类可读文本，非结构化** | 判定策略：`exit≠0 && stdout 无任何事件` → 调用失败；再按 stderr 文本细分 `ErrorCode` |
| 顺带回答了一个旧疑问 | `--session` 传**不存在**的 ID **不会自动创建**，直接报错 |

### 12.4 新增实现约束

| # | 约束 | 依据 |
|---|---|---|
| C11 | **错误检测必须读 `stderr`**，不能只解析 stdout 事件流 | §12.3 |
| C12 | **stderr 解析前必须剥 ANSI 转义码** | §12.3 |
| C13 | **`ErrorCode` 判定顺序**：`exit≠0 && stdout 无事件` → 失败，再按 stderr 文本细分 | §12.3 |
| C14 | **`idle` 超时按"最长单次生成"留量，不是按"流式停顿"** | §12.2 |
| C15 | **解析以事件 `type` 为准**，`part.type` 命名与之不一致 | §12.1 |
| C16 | **usage 必须跨 `step_finish` 累加** | §12.1 |

### 12.5 由此更新的超时默认值（最终）

```text
startup    30_000
firstEvent 45_000
idle       300_000     ← 第二轮修订（原 120s 会误杀）
total      600_000
shutdown   3_000
```

### 12.6 仍未验证（更新后）

- [ ] `--session` 与 `--dir` 不一致时的行为
- [ ] 同一 session 更换 model 是否允许
- [ ] 中途 kill 后 session 是否已经持久化
- [ ] 非 JSON stderr 在**其他**失败路径的形态（本次只测了 session 失效）
- [ ] JSON 半行 / 超长单行（真实 CLI 未复现，fake CLI 已覆盖）
- [ ] 是否存在 `retry` / `error` 等其他 stdout 事件类型
- [ ] 空正文且 `reason="stop"` 时的真实形态
