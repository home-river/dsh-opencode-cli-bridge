import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { streamDshChunks } from "../../lib/cli-bridge.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(here, "..", "fixtures", "fake-opencode.mjs");

function baseOpts(mode, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ocbridge-dsh-"));
  writeFileSync(join(dir, "alpha.txt"), "alpha\n");
  const defaults = {
    workspace: dir,
    model: "opencode/mimo-v2.6-flash-free",
    prompt: "hello",
    command: process.execPath,
    extraArgs: [FAKE, `mode:${mode}`],
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 5000, totalMs: 15000, shutdownMs: 1000 },
  };
  return { dir, opts: { ...defaults, ...over } };
}

async function collect(opts, options) {
  const chunks = [];
  for await (const c of streamDshChunks(opts, options)) chunks.push(c);
  return chunks;
}

test("fake normal -> 块 + usage + finish(stop)，正文还原", async () => {
  const { dir, opts } = baseOpts("normal");
  try {
    const chunks = await collect(opts, { chunkSize: 8 });
    const types = chunks.map((c) => c.type);
    assert.equal(types[0], "block-start");
    assert.equal(types.at(-2), "usage");
    assert.equal(types.at(-1), "finish");
    const deltas = chunks.filter((c) => c.type === "text-delta");
    assert.ok(deltas.length >= 1);
    const text = deltas.map((c) => c.text).join("");
    assert.equal(text, "FAKE_NORMAL_OK");
    const end = chunks.find((c) => c.type === "block-end");
    assert.deepEqual(end.block, { type: "text", text: "FAKE_NORMAL_OK" });
    assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fake multiline -> 多块 index 递增，正文拼接还原", async () => {
  const { dir, opts } = baseOpts("multiline");
  try {
    const chunks = await collect(opts, { chunkSize: 64 });
    const starts = chunks.filter((c) => c.type === "block-start");
    assert.equal(starts.length, 3);
    assert.deepEqual(starts.map((c) => c.index), [0, 1, 2]);
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
    assert.equal(text, "part-A part-B part-C");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fake multi-step -> 只有一条 usage+finish，reason 取最后（stop）", async () => {
  const { dir, opts } = baseOpts("multi-step");
  try {
    const chunks = await collect(opts, { chunkSize: 64 });
    assert.equal(chunks.filter((c) => c.type === "finish").length, 1);
    assert.equal(chunks.filter((c) => c.type === "usage").length, 1);
    assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fake tool-only -> 工具镜像可见 + 零文本保险 + finish(stop)（透传桥回传层）", async () => {
  const { dir, opts } = baseOpts("tool-only");
  try {
    const chunks = await collect(opts);
    const starts = chunks.filter((c) => c.type === "block-start");
    assert.equal(starts.length, 2, "工具镜像块 + 保险文本块");
    assert.deepEqual(starts.map((s) => s.blockType), ["reasoning", "text"]);
    const mirror = chunks.filter((c) => c.type === "reasoning-delta").map((c) => c.text).join("");
    const body = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
    assert.ok(mirror.includes("🔧 bash") && mirror.includes("a.txt"), mirror);
    assert.ok(body.includes("执行了工具（bash）但没有产生文本输出"), body);
    assert.deepEqual(chunks.at(-1).reason, { kind: "stop" }, "无 tool-call 块不得收尾于 tool-calls");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("超时击杀不得被零文本保险吞掉（ISSUE-009）：tool-only-hang + idle 击杀 -> finish(error, TIMEOUT)", async () => {
  // 现场复现：工具步收尾（step_finish tool-calls）后进程僵住，被 idle 层击杀。
  // 修复前：陈旧的 tool-calls 收尾冒充正常结束，被零文本保险改写成 stop + 提示语
  //（"本轮模型执行了工具…但没有产生文本输出"）——超时被伪装成正常输出。
  const { dir, opts } = baseOpts("tool-only-hang", {
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 300, totalMs: 5000, shutdownMs: 500 },
  });
  try {
    const chunks = await collect(opts);
    const mirror = chunks.filter((c) => c.type === "reasoning-delta").map((c) => c.text).join("");
    const body = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
    assert.ok(mirror.includes("🔧 bash"), mirror);
    assert.ok(!body.includes("没有产生文本输出") && !mirror.includes("没有产生文本输出"),
      `超时不得伪装成零文本提示：${body}`);
    const finish = chunks.at(-1);
    assert.equal(finish.type, "finish");
    assert.equal(finish.reason.kind, "error", "被击杀的未完成回合必须如实收尾为 error");
    assert.equal(finish.reason.failure.code, "TIMEOUT");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fake empty -> finish(error, EMPTY_RESPONSE)", async () => {
  const { dir, opts } = baseOpts("empty");
  try {
    const chunks = await collect(opts);
    const finish = chunks.at(-1);
    assert.equal(finish.reason.kind, "error");
    assert.equal(finish.reason.failure.code, "EMPTY_RESPONSE");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
