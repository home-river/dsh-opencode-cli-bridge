import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DshChunkConverter,
  mapUsage,
  toDshChunks,
} from "../../lib/to-dsh-chunks.js";
import { CliBridgeError, CliBridgeAbortError } from "../../lib/errors.js";
import { ZERO_USAGE } from "../../lib/types.js";

function textEvent(text, over = {}) {
  return { kind: "text", sessionId: "ses_1", text, ...over };
}

function finishEvent(over = {}) {
  return {
    kind: "finish",
    sessionId: "ses_1",
    reason: "stop",
    usage: { total: 30, input: 10, output: 15, reasoning: 3, cacheRead: 2, cacheWrite: 0 },
    cost: 0,
    ...over,
  };
}

test("mapUsage: 字段映射正确", () => {
  assert.deepEqual(mapUsage({ total: 30, input: 10, output: 15, reasoning: 3, cacheRead: 2, cacheWrite: 1 }), {
    inputTokens: 10,
    outputTokens: 15,
    totalTokens: 30,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: 3,
  });
});

test("单段 text -> block-start / text-delta* / block-end，index=0", () => {
  const c = new DshChunkConverter({ chunkSize: 4 });
  const chunks = c.push(textEvent("abcdefg"));
  assert.deepEqual(chunks, [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "abcd" },
    { type: "text-delta", index: 0, text: "efg" },
    { type: "block-end", index: 0, block: { type: "text", text: "abcdefg" } },
  ]);
});

test("多段 text -> index 递增 0,1,...", () => {
  const c = new DshChunkConverter({ chunkSize: 100 });
  c.push(textEvent("one"));
  const chunks = c.push(textEvent("two"));
  assert.equal(chunks[0].type, "block-start");
  assert.equal(chunks[0].index, 1);
  assert.equal(chunks.at(-1).type, "block-end");
  assert.equal(chunks.at(-1).index, 1);
});

test("空串 text -> 无输出", () => {
  const c = new DshChunkConverter();
  assert.deepEqual(c.push(textEvent("")), []);
});

test("start 事件 -> 无输出；tool 事件（无名）-> 可见进度块兜名 tool", () => {
  const c = new DshChunkConverter();
  assert.deepEqual(c.push({ kind: "start", sessionId: "ses_1" }), []);
  assert.deepEqual(c.push({ kind: "tool", sessionId: "ses_1", raw: {} }), [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "🔧 tool" },
    { type: "block-end", index: 0, block: { type: "text", text: "🔧 tool" } },
  ]);
});

test("finish 事件不立即产出，end() 产出 usage+finish(stop)", () => {
  const c = new DshChunkConverter();
  assert.deepEqual(c.push(finishEvent()), []);
  assert.deepEqual(c.end(), [
    {
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 15, totalTokens: 30, cacheReadTokens: 2, reasoningTokens: 3 },
    },
    { type: "finish", reason: { kind: "stop" } },
  ]);
});

test("mapUsage 可选字段缺省值归一：0 值不发（QA-2026-10-18 建议 #3，glm 全 0 上报场景）", () => {
  assert.deepEqual(mapUsage({ input: 1, output: 2, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }), {
    inputTokens: 1,
    outputTokens: 2,
  });
  assert.deepEqual(mapUsage(ZERO_USAGE), { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(
    mapUsage({ input: 1, output: 2, total: 3, cacheRead: 4, cacheWrite: 5, reasoning: 6 }),
    { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5, reasoningTokens: 6 },
  );
});

test("多 step 多个 finish 折叠为最后一个（reason 与 usage 都取最后）", () => {
  const c = new DshChunkConverter({ chunkSize: 100 });
  c.push(textEvent("step one"));
  c.push(finishEvent({ reason: "tool-calls", usage: { total: 100, input: 80, output: 10, reasoning: 5, cacheRead: 5, cacheWrite: 0 } }));
  c.push(textEvent("step two"));
  c.push(finishEvent({ reason: "stop", usage: { total: 200, input: 150, output: 40, reasoning: 8, cacheRead: 2, cacheWrite: 0 } }));
  const tail = c.end();
  assert.equal(tail.length, 2);
  assert.equal(tail[0].type, "usage");
  assert.equal(tail[0].usage.totalTokens, 200);
  assert.deepEqual(tail[1].reason, { kind: "stop" });
});

test("finish(max-tokens) / finish(tool-calls) 映射", () => {
  const a = new DshChunkConverter();
  a.push(finishEvent({ reason: "max-tokens" }));
  assert.deepEqual(a.end()[1].reason, { kind: "max-tokens" });
  const b = new DshChunkConverter();
  b.push(textEvent("done"));
  b.push(finishEvent({ reason: "tool-calls" }));
  assert.deepEqual(b.end()[1].reason, { kind: "tool-calls" });
});

test("工具事件回流：tool_use 产出可见进度块（🔧 行），callID 去重、tool_result 不重复（解禁批 #2）", () => {
  const c = new DshChunkConverter({ chunkSize: 1000 });
  const out = [
    ...c.push({ kind: "tool", sessionId: "ses_1", raw: { tool: "bash", callID: "c1" } }),
    ...c.push({ kind: "tool", sessionId: "ses_1", raw: { tool: "bash", callID: "c1" } }),
    ...c.push({ kind: "tool", sessionId: "ses_1", raw: { type: "tool_result", part: { tool: "read", callID: "c3" } } }),
    ...c.push({ kind: "tool", sessionId: "ses_1", raw: { type: "tool_use", part: { tool: "read", callID: "c3x" } } }),
  ];
  const texts = out.filter((x) => x.type === "text-delta").map((x) => x.text);
  assert.deepEqual(texts, ["🔧 bash", "🔧 read"]);
  assert.equal(out[0].type, "block-start");
  assert.equal(out.at(-1).type, "block-end");
});

test("零文本保险：工具轮零正文 -> 进度块 + 保险文案（含工具名）+ stop 收尾（解禁批 #3）", () => {
  const c = new DshChunkConverter({ chunkSize: 1000 });
  const out = [
    ...c.push({ kind: "tool", sessionId: "ses_1", raw: { tool: "bash", callID: "c1" } }),
    ...c.push({ kind: "tool", sessionId: "ses_1", raw: { tool: "bash", callID: "c2" } }),
    ...c.push({ kind: "tool", sessionId: "ses_1", raw: { tool: "read", callID: "c3" } }),
    ...c.push(finishEvent({ reason: "tool-calls" })),
    ...c.end(),
  ];
  const body = out.filter((x) => x.type === "text-delta").map((x) => x.text).join("");
  assert.ok(body.includes("🔧 bash") && body.includes("🔧 read"), body);
  assert.ok(body.includes("执行了工具（bash、read）但没有产生文本输出"), body);
  assert.equal(out.at(-2).type, "usage");
  assert.deepEqual(out.at(-1).reason, { kind: "stop" }, "无 tool-call 块时不得收尾于 tool-calls");
});

test("零文本保险：无正文无工具 -> 保险文案 + stop 收尾（去异常叙事）", () => {
  const c = new DshChunkConverter();
  c.push(finishEvent({ reason: "tool-calls" }));
  const out = c.end();
  assert.deepEqual(out.at(-1).reason, { kind: "stop" });
  const body = out.filter((x) => x.type === "text-delta").map((x) => x.text).join("");
  assert.ok(body.includes("本轮没有产生文本输出"), body);
  assert.ok(!body.includes("不支持工具调用转发"), "不再使用异常叙事");
});

test("零文本保险不误伤：有正文的工具轮照常透传（进度块独立于正文）", () => {
  const c = new DshChunkConverter();
  const out = [
    ...c.push(textEvent("这是正文")),
    ...c.push({ kind: "tool", sessionId: "ses_1", raw: { tool: "read" } }),
    ...c.push(finishEvent({ reason: "tool-calls" })),
    ...c.end(),
  ];
  const blocks = out.filter((x) => x.type === "text-delta").map((x) => x.text);
  assert.deepEqual(blocks, ["这是正文", "🔧 read"], "正文不被污染，进度独立成块");
  assert.ok(!blocks.join("").includes("本轮"), "有正文时不合成保险文案");
  assert.deepEqual(out.at(-1).reason, { kind: "tool-calls" });
});

test("finish(error, EMPTY_RESPONSE) -> error + 静态文案", () => {
  const c = new DshChunkConverter();
  c.push(finishEvent({ reason: "error", code: "EMPTY_RESPONSE" }));
  assert.deepEqual(c.end()[1].reason, {
    kind: "error",
    failure: { message: "Model returned an empty response", code: "EMPTY_RESPONSE" },
  });
});

test("finish(aborted) -> aborted + CANCELLED", () => {
  const c = new DshChunkConverter();
  c.push(finishEvent({ reason: "aborted" }));
  assert.deepEqual(c.end()[1].reason, {
    kind: "aborted",
    failure: { message: "Request cancelled", code: "CANCELLED" },
  });
});

test("error 事件 -> end() 时 usage 全零 + error(<event.code>)", () => {
  const c = new DshChunkConverter();
  c.push({ kind: "error", code: "UPSTREAM_ERROR", message: "whatever" });
  assert.deepEqual(c.end(), [
    { type: "usage", usage: mapUsage(ZERO_USAGE) },
    { type: "finish", reason: { kind: "error", failure: { message: "Upstream model error", code: "UPSTREAM_ERROR" } } },
  ]);
});

test("无任何终止事件 -> end() 兜底 error(PROTOCOL_ERROR)", () => {
  const c = new DshChunkConverter();
  assert.deepEqual(c.end(), [
    { type: "usage", usage: mapUsage(ZERO_USAGE) },
    { type: "finish", reason: { kind: "error", failure: { message: "OpenCode CLI output protocol error", code: "PROTOCOL_ERROR" } } },
  ]);
});

test("收尾后 push/end/abort 一律返回 []（幂等）", () => {
  const c = new DshChunkConverter();
  c.end();
  assert.deepEqual(c.push(textEvent("late")), []);
  assert.deepEqual(c.end(), []);
  assert.deepEqual(c.abort(), []);
});

test("abort() -> usage + finish(aborted, CANCELLED)", () => {
  const c = new DshChunkConverter({ chunkSize: 100 });
  c.push(textEvent("partial"));
  const tail = c.abort();
  assert.equal(tail[0].type, "usage");
  assert.deepEqual(tail[1].reason, {
    kind: "aborted",
    failure: { message: "Request cancelled", code: "CANCELLED" },
  });
});

test("已有 finish 记录时 abort() 仍强制 aborted + CANCELLED，usage 取记录值", () => {
  const c = new DshChunkConverter({ chunkSize: 100 });
  c.push(finishEvent({ reason: "tool-calls", usage: { total: 100, input: 80, output: 10, reasoning: 5, cacheRead: 5, cacheWrite: 0 } }));
  assert.deepEqual(c.abort(), [
    { type: "usage", usage: { inputTokens: 80, outputTokens: 10, totalTokens: 100, cacheReadTokens: 5, reasoningTokens: 5 } },
    { type: "finish", reason: { kind: "aborted", failure: { message: "Request cancelled", code: "CANCELLED" } } },
  ]);
});

test("toDshChunks: 异步包装产出与状态机一致，自然收尾", async () => {
  async function* source() {
    yield textEvent("hi");
    yield finishEvent();
  }
  const out = [];
  for await (const chunk of toDshChunks(source(), { chunkSize: 100 })) out.push(chunk);
  assert.deepEqual(out.map((c) => c.type), ["block-start", "text-delta", "block-end", "usage", "finish"]);
});

test("toDshChunks: 源抛 CliBridgeAbortError -> aborted 收尾，不向外抛", async () => {
  async function* source() {
    yield textEvent("partial");
    throw new CliBridgeAbortError("aborted");
  }
  const out = [];
  for await (const chunk of toDshChunks(source())) out.push(chunk);
  const finish = out.at(-1);
  assert.equal(finish.type, "finish");
  assert.equal(finish.reason.kind, "aborted");
});

test("toDshChunks: 源抛 CliBridgeError -> error 收尾，不向外抛", async () => {
  async function* source() {
    throw new CliBridgeError("WORKSPACE_INVALID", "bad workspace");
  }
  const out = [];
  for await (const chunk of toDshChunks(source())) out.push(chunk);
  const finish = out.at(-1);
  assert.equal(finish.type, "finish");
  assert.equal(finish.reason.kind, "error");
  assert.equal(finish.reason.failure.code, "WORKSPACE_INVALID");
});

test("toDshChunks: 非 CliBridge 异常原样抛出", async () => {
  async function* source() {
    throw new TypeError("boom");
  }
  await assert.rejects(async () => {
    for await (const _ of toDshChunks(source())) void _;
  }, TypeError);
});
