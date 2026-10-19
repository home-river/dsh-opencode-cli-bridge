// 模拟测试（子代理执行探针）— test/simulation/subagent-sim.test.mjs
//
// 用途（双重）：
//   1. 模拟层：不依赖 lib/ 构建产物，用内联 mock 复现 StreamChunk 归一、事件映射、
//      重试策略、模型目录过滤等桥接语义，验证「模拟测试」可被任意环境独立执行；
//   2. 探针层：把子代理执行环境的事实（Node 版本、CWD、DSH_* 环境变量、文件可读性）
//      以 t.diagnostic 输出，用于分析 opencode 路由子代理的执行与回传特性。
//
// 本文件完全自包含（零 import 依赖）。预期汇总由派发方的基准运行持有，
// 刻意不写入本文件与诊断输出，防止执行方读取后照抄答案（回传保真校验）。
// 执行方式（在 dsh-opencode-bridge 目录下；沙箱内 node --test 会 spawn 子进程被 EPERM 拦截，故直接进程内跑）：
//   node test/simulation/subagent-sim.test.mjs
//
// 封条：PROBE-SEAL-2026-10-19（若子代理擅自改文件，源码探针会失败）

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEAL = "PROBE-SEAL-2026-10-19";

// ---------- 模拟层：内联 mock 复现桥接语义（不 import lib/） ----------

/** 模拟 StreamChunk 文本归一：过滤空片段、按序拼接 */
function normalizeTextParts(parts) {
  return parts.filter((p) => typeof p === "string" && p.length > 0).join("");
}

/** 模拟事件映射：tool_use 进度块按 callID 去重，tool_result 不重复产块 */
function mapEventsToBlocks(events) {
  const seen = new Set();
  const blocks = [];
  for (const ev of events) {
    if (ev.type === "text") blocks.push({ kind: "text", text: ev.text });
    if (ev.type === "tool_use") {
      if (seen.has(ev.callID)) continue;
      seen.add(ev.callID);
      blocks.push({ kind: "progress", text: `🔧 ${ev.name}` });
    }
  }
  return blocks;
}

/** 模拟重试策略（ISSUE-006 结论：CLI 级失败最多重试 1 次） */
function retryPolicy() {
  return { mode: "normal", maxRetries: 1, retryableCodes: ["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"] };
}

/** 模拟模型目录过滤：只保留用户勾选的模型 */
function filterModels(models, selectedIds) {
  return models.filter((m) => selectedIds.includes(m.id));
}

/** 模拟异常兜底：异常一律归一为零文本，不产异常叙事 */
function degradeOn(error) {
  void error;
  return { kind: "text", text: "" };
}

test("模拟：StreamChunk 文本归一（空片段过滤 + 按序拼接）", () => {
  assert.equal(normalizeTextParts(["你", "", "好", null, "，", "世界"]), "你好，世界");
  assert.equal(normalizeTextParts([]), "");
});

test("模拟：事件映射与 tool_use 进度块 callID 去重", () => {
  const blocks = mapEventsToBlocks([
    { type: "text", text: "开始" },
    { type: "tool_use", callID: "c1", name: "read" },
    { type: "tool_use", callID: "c1", name: "read" },
    { type: "tool_result", callID: "c1" },
    { type: "tool_use", callID: "c2", name: "grep" },
    { type: "text", text: "结束" },
  ]);
  assert.deepEqual(blocks, [
    { kind: "text", text: "开始" },
    { kind: "progress", text: "🔧 read" },
    { kind: "progress", text: "🔧 grep" },
    { kind: "text", text: "结束" },
  ]);
});

test("模拟：重试策略收紧（CLI 级失败最多 1 次）", () => {
  assert.deepEqual(retryPolicy(), {
    mode: "normal",
    maxRetries: 1,
    retryableCodes: ["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"],
  });
});

test("模拟：模型目录过滤（只留勾选项）", () => {
  const models = [
    { id: "opencode/deepseek-v4.1-flash-free" },
    { id: "opencode/glm-5.3-flash-free" },
    { id: "opencode/mimo-v2.6-flash-free" },
    { id: "opencode/other-model" },
  ];
  const selected = [
    "opencode/deepseek-v4.1-flash-free",
    "opencode/glm-5.3-flash-free",
    "opencode/mimo-v2.6-flash-free",
  ];
  assert.deepEqual(filterModels(models, selected).map((m) => m.id), selected);
});

test("模拟：异常兜底归一为零文本（不产异常叙事）", () => {
  assert.deepEqual(degradeOn(new Error("boom")), { kind: "text", text: "" });
});

// ---------- 探针层：把执行环境事实写入诊断输出 ----------

test("探针：运行环境（Node / 平台 / CWD）", (t) => {
  const info = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
  };
  t.diagnostic(`ENV node=${info.node} platform=${info.platform} arch=${info.arch}`);
  t.diagnostic(`ENV cwd=${info.cwd}`);
  assert.ok(Number.parseInt(process.version.slice(1), 10) >= 20, "需要 Node >= 20");
});

test("探针：自身源码可读且封条完好（防篡改）", (t) => {
  const selfPath = fileURLToPath(import.meta.url);
  const source = readFileSync(selfPath, "utf8");
  t.diagnostic(`SELF bytes=${Buffer.byteLength(source, "utf8")} path=${selfPath}`);
  assert.ok(source.includes(SEAL), "封条缺失：文件可能被修改");
  assert.ok(source.split("\n").length > 50, "源码行数异常：文件可能被截断");
});

test("探针：DSH_* 环境变量（仅报名称，不报值）", (t) => {
  const names = Object.keys(process.env).filter((k) => k.startsWith("DSH_")).sort();
  t.diagnostic(`DSH_ENV count=${names.length} names=${names.join(",") || "(none)"}`);
  assert.ok(Array.isArray(names));
});

test("探针：跳过与 todo 的回传保真（本条应为 pass）", (t) => {
  t.diagnostic("FIDELITY 期望汇总由派发方持有，不在本文件公布");
  assert.ok(true);
});

test("探针：写文件能力（按指令跳过 — 子代理不应修改任何文件）", {
  skip: "禁止改文件，本条刻意跳过",
}, () => {});

test("探针：多工具编排场景（暂未覆盖）", { todo: true }, () => {});
