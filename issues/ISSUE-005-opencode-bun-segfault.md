# ISSUE-005 opencode.exe（Bun 1.3.14）本机间歇段错误，LLM 流式调用中途崩溃

- 状态：open（上游 bug，插件侧无法根治；已定位并给出缓解/排查建议）
- 发现日期：2026-10-18
- 相关文件：`test/integration/cli-bridge.real.test.mjs`（受害方）、`src/run-cli.ts`（诊断收集已覆盖）

## 现象

- **本机**（`C:\Users\gansh`，Windows 10）`OCBRIDGE_IT=1 npm run test:integration` 中所有需要真实推理的
  用例（R01/R02/R07/R08）拿回 **空正文**（`text length=0`），`finishReason=error`、
  `errorCode=PROTOCOL_ERROR`、`exitCode=3`；
- stderr 诊断里出现 Bun 崩溃横幅：

  ```text
  panic(thread ...): Segmentation fault at address 0x3C
  oh no: Bun has crashed. This indicates a bug in Bun, not your code.
  Bun v1.3.14 (0d9b296a) Windows x64 (baseline) | Args: ... --user-agent=opencode/1.19.2 --use-system-ca -- run ...
  ```

- **复现率**：直调 `opencode.exe run --format json` 采样 8 次，**1 成 7 崩**（成功 1 次拿到完整
  `step_start → text → step_finish` 事件流与正常 usage）；崩溃与调用方式无关（cmd shim /
  直调 exe / 桥内 spawn、prompt 走位置参数或 stdin 均可复现）；
- **崩溃点**：`~/.local/share/opencode/log/opencode.log` 中崩溃场次记录到
  `loop session.id=... step=0` 即断流——死在 **LLM 流式调用期间**，不是启动期；
- R03（无效 session）稳定通过：它在本地校验即失败，不发起推理网络调用。

## 原因

**上游/环境问题，与插件代码无关**（直调 exe 复现）：

1. `opencode.exe` 1.19.2 是 Bun v1.3.14 (baseline) 单文件产物，启动器自举时固定注入
   `--use-system-ca`（改用 Windows 系统证书存储做 TLS）；
2. 本机 TLS 凭证环境异常有旁证：同一会话里 `git fetch` 的 schannel 后端报
   `AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)`（换 openssl 后端即恢复）；
   Bun 在系统 CA/TLS 路径上间歇段错误与该环境病高度相关；
3. `~/.local/share/opencode` 可写（排除 ISSUE-001-opencode-log-dir-not-writable 的诱因）；
   `opencode.db-wal/-shm` 为崩溃残留，非根因；
4. 成功 1 次说明链路本身可通：桥内 `discover-cli`（shim-resolved 真身 exe）→ `run` argv →
   stdin prompt → JSON Lines 解析全链无恙。

## 修复方案（修复后填写）

上游 Bun/opencode-ai 的 bug，插件侧无法根治；当前处置：

- **已做**：插件诊断链正确兜住该故障——崩溃横幅完整进 `diagnostics`（`kind:"stderr"`），
  零 stdout + exit 3 → `classifyFailure` 兜底 `PROTOCOL_ERROR` 的 error finish，DSH 不悬挂
  （表现为回答失败而非卡死）；
- **ISSUE-001 空气泡排查联动**：`~/.dsh-opencode-bridge/diagnostics.log` 若含
  `Bun has crashed` 横幅，对应轮次的空气泡即由本 issue 解释（候选 A「模型空响应」之外的
  新候选，已在 ISSUE-001 原因节加注）；
- **集成回归**：ISSUE-004 修复后 `R11` 及清理全部稳定；剩余 4 条推理用例待 CLI 稳定的环境
  （旧机器 86181 上 2026-10-16 曾 8/8 通过）复跑验收；
- **可试缓解**（未验证）：升级/降级 `opencode-ai` 版本、修复本机系统证书/凭据存储后复测。
