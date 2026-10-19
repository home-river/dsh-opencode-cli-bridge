/**
 * 跨 Node 版本的测试启动器。
 *
 * 背景（2026-10-19 实测）：
 *   `node --test test/unit/`        Node 20 ✔ 目录展开；Node 21+ ✘（glob 语义，目录不展开，
 *                                    会把目录当测试文件加载 → Cannot find module）
 *   `node --test test/unit/*.mjs`   Node 21+ ✔（runner 自己做 glob）；Node 20 ✘（字面路径）
 * 两种官方形态在 20 / 21+ 上互补地坏，故自做文件展开：显式列出测试文件，全版本行为一致。
 *
 * 用法：node scripts/run-tests.mjs [test/unit|test/integration]
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = process.argv[2] ?? "test/unit";
const dir = join(root, target);

const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join(dir, name));

if (files.length === 0) {
  console.error(`run-tests: no *.test.mjs files under ${target}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  cwd: root,
});
process.exit(result.status ?? 1);
