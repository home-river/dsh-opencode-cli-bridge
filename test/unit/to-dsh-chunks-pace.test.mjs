import { test } from "node:test";
import assert from "node:assert/strict";
import { toDshChunks, DEFAULT_PACE_MS } from "../../lib/to-dsh-chunks.js";

function textEvent(text) {
  return { kind: "text", sessionId: "ses_1", messageId: "msg_1", text };
}
function finishEvent(over = {}) {
  return {
    kind: "finish",
    sessionId: "ses_1",
    messageId: "msg_1",
    reason: "stop",
    usage: { total: 10, input: 4, output: 3, reasoning: 1, cacheRead: 2, cacheWrite: 0 },
    cost: 0,
    ...over,
  };
}
async function* source(...events) {
  for (const e of events) yield e;
}

test("模拟流式：text-delta 按 paceMs 间隔产出，顺序与内容不变", async () => {
  const text = "模拟流式节奏测试：这段正文会被切成多个 delta，产出间隔应可见。";
  const t0 = Date.now();
  const chunks = [];
  for await (const c of toDshChunks(source(textEvent(text), finishEvent()), { chunkSize: 8, paceMs: 40 })) {
    chunks.push({ ...c, at: Date.now() - t0 });
  }
  const deltas = chunks.filter((c) => c.type === "text-delta");
  assert.ok(deltas.length >= 5, `delta 数应足够多，实际 ${deltas.length}`);
  const body = deltas.map((c) => c.text).join("");
  assert.equal(body, text, "内容与顺序不变");
  // 第一个 delta 即时，其后每个至少隔 ~paceMs（放宽到 30ms 容忍计时抖动）
  assert.equal(deltas[0].at < 30, true, "首个 delta 应即时");
  for (let i = 1; i < deltas.length; i++) {
    assert.ok(deltas[i].at - deltas[i - 1].at >= 30, `delta#${i} 间隔过小`);
  }
  assert.ok(deltas.at(-1).at >= 30 * (deltas.length - 1) * 0.9, "总耗时应随 delta 数增长");
});

test("paceMs: 0 关闭节奏，全部即时产出", async () => {
  const text = "x".repeat(240);
  const t0 = Date.now();
  const chunks = [];
  for await (const c of toDshChunks(source(textEvent(text), finishEvent()), { chunkSize: 8, paceMs: 0 })) chunks.push(c);
  const elapsed = Date.now() - t0;
  assert.equal(chunks.filter((c) => c.type === "text-delta").length, 30);
  assert.ok(elapsed < 100, `关闭节奏应即时，实际 ${elapsed}ms`);
});

test("DEFAULT_PACE_MS 为正数；异常/取消路径同样带节奏但不改变终态", async () => {
  assert.ok(DEFAULT_PACE_MS > 0);
  const chunks = [];
  for await (const c of toDchuncksSafe()) chunks.push(c);
  assert.deepEqual(chunks.at(-1).reason, { kind: "aborted", failure: { message: "Request cancelled", code: "CANCELLED" } });
});

async function* toDchuncksSafe() {
  const { CliBridgeAbortError } = await import("../../lib/errors.js");
  async function* ev() {
    yield textEvent("取消前的部分正文");
    throw new CliBridgeAbortError();
  }
  const { toDshChunks } = await import("../../lib/to-dsh-chunks.js");
  yield* toDshChunks(ev(), { chunkSize: 8, paceMs: 5 });
}
