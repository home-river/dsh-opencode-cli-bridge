# ISSUE-004 真实 CLI 集成测试收尾 rmSync EPERM（CLI 进程树退出竞态）

- 状态：fixed
- 发现日期：2026-10-18
- 相关文件：`test/integration/cli-bridge.real.test.mjs`

## 现象

- **环境**：Windows，本机（`C:\Users\gansh`）首跑 `OCBRIDGE_IT=1 npm run test:integration`；
- **表现**：R01/R02/R07/R08/R11 共 5 条用例标记失败，但失败点全部是 `finally` 清理里的
  `rmSync(dir, { recursive: true, force: true })` 抛
  `Error: EPERM, Permission denied: \\?\C:\Users\gansh\AppData\Local\Temp\ocbridge-it-*`，
  **用例断言本身全部通过**（R03/R05/R06 不做工作区清理，3/3 通过）；
- **复现**：本机 5/5 稳定复现（连续两轮跑同一套）；
- **误导性**：汇总显示 `pass 3 / fail 5`，极易误判为真实 CLI 链路回归或上游模型故障。

## 原因

**清理期瞬时竞态，不是功能失败、不是 ACL 问题**：

1. 每条用例的临时工作区以 `cwd: workspace` 方式交给 `opencode run`（`run-cli.ts` 的
   `spawn(..., { cwd })`），CLI 进程树（含派生的 `git` 子进程）退出后，内核对目录句柄 /
   残留 CWD 的回收存在窗口；
2. 桥内对进程退出的等待只覆盖到直接子进程的 `exit/close` + `taskkill /T` 结果，
   `runCliBridge` resolve 与「目录可被删除」之间没有同步点；
3. `finally` 中的 `rmSync` 恰好落在该窗口内 → `EPERM`；
4. **事后验证**：测试结束后手动 `Remove-Item -Recurse -Force` 7 个残留目录**全部立即成功**，
   逐文件独占打开测试无锁定、`Get-Process` 无 `opencode*` 残留 → 既非文件锁也非持久 ACL。

旧机器（86181）上该竞态恰好不常命中，故 2026-10-16 回归记录为 8/8 通过；本机稳定命中。

## 修复方案（修复后填写）

- **改动**：`test/integration/cli-bridge.real.test.mjs` —— 新增 `async cleanup(dir)`：
  `rmSync` 失败时按 `150ms × n` 退避重试最多 10 次后再抛出；6 处 `finally { rmSync(...) }`
  全部替换为 `finally { await cleanup(dir); }`。功能代码零改动。
- **思路**：把「进程树退出到目录句柄回收」的瞬态窗口用重试吸收，而不是让用例为环境竞态背锅；
  重试上限内仍失败才视为真问题（此时堆栈保留原始 EPERM）。
- **验证**：`OCBRIDGE_IT=1 npm run test:integration` 本机复跑，8/8 通过（见提交记录）。
- **后续**：若产品侧（非测试）也出现「CLI 退出后立刻操作 workspace 偶发 EPERM」，
  可考虑在 `run-cli.ts` 的 settle 流程里加极短的句柄回收宽限；当前不动产品代码。
