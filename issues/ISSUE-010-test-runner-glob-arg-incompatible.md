# ISSUE-010 测试脚本 glob 参数在 Node 20/21+ 上互补地坏，CI 全红

- 状态：fixed
- 发现日期：2026-10-19
- 相关文件：`package.json`（scripts）、`.github/workflows/ci.yml`、`scripts/run-tests.mjs`

## 现象

- GitHub Actions 的 `test (20)` 矩阵任务 `Process completed with exit code 1`，`test (22)` 被
  矩阵 fail-fast 连坐取消；本地（Node 24）一切正常，CI 却全红。
- 本地用 `npx -y node@20` 复现：`node --test test/unit/*.test.mjs` 输出
  `Could not find '...\test\unit\*.test.mjs'`（exit 1）。

## 原因

`node --test` 的位置参数语义在 Node 大版本间**反转**了（2026-10-19 实测）：

| 参数形态 | Node 20 | Node 21+（22/24 实测） |
|---|---|---|
| `node --test test/unit/`（目录） | ✔ 目录展开，跑目录下测试文件 | ✘ glob 语义不展开目录，把目录当测试文件加载 → `Cannot find module '...\test\unit'` |
| `node --test test/unit/*.test.mjs`（glob） | ✘ 按字面路径找文件 → `Could not find` | ✔ runner 自己做 glob 展开 |

即两种官方形态**互补地坏**：glob 形态（原 scripts 用的）在 Node 20 挂，目录形态在 21+ 挂。
npm scripts 在 Windows 下由 cmd.exe 执行、shell 不展开 glob，所以 Node 20 拿到的是字面量。
CI 矩阵含 Node 20，故 `test (20)` 必挂；本地 Node 24 复现不了。

## 修复方案（2026-10-19）

- 新增 `scripts/run-tests.mjs`：自己 `readdirSync` 展开目标目录下的 `*.test.mjs`，
  显式文件列表交给 `node --test`，绕开两个大版本的语义分歧，全版本行为一致；
- `package.json` 的 `test` / `test:integration` 改走该启动器（`node scripts/run-tests.mjs test/unit|test/integration`）；
- `.github/workflows/ci.yml` 的 `actions/checkout@v4`/`setup-node@v4` 升 `@v5`
  （v4 自身运行时是 Node 20，GitHub 已发弃用警告）。
- **验证**：Node 24（npm test）/ Node 20（npx node@20，连跑 2 轮）/ Node 22（npx node@22）
  全部 239/239 通过。
- **遗留观察**：修复前用目录形态在 Node 20 观察到一次 238/239（1 条失败，未取到用例名），
  其后 3 轮未复现；若 CI 再现，按日志中的用例名另开 issue 定位。
