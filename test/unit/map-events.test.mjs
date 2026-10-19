import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenCodeEventMapper } from "../../lib/map-events.js";

const stepStart = (sessionID, messageID) => ({
  type: "step_start", sessionID,
  part: { type: "step-start", id: "prt_1", messageID },
});
const textEv = (sessionID, messageID, text) => ({
  type: "text", sessionID,
  part: { type: "text", id: "prt_2", messageID, text, time: { start: 1, end: 2 } },
});
const stepFinish = (sessionID, messageID, reason, tokens, cost = 0) => ({
  type: "step_finish", sessionID,
  part: { type: "step-finish", id: "prt_3", messageID, reason, tokens, cost },
});
const toolUse = (sessionID, messageID) => ({
  type: "tool_use", sessionID,
  part: { type: "tool", tool: "bash", callID: "call_1",
          state: { status: "completed", input: { command: "ls" }, output: "ok" } },
});
const TOK_A = { total: 9553, input: 9510, output: 19, reasoning: 24, cache: { read: 0, write: 0 } };
const TOK_B = { total: 9755, input: 214, output: 24, reasoning: 45, cache: { read: 9472, write: 0 } };

test("start 事件只对新 messageId 产出一次", () => {
  const m = new OpenCodeEventMapper();
  const a = m.push(stepStart("ses_1", "msg_1"));
  assert.equal(a.events.length, 1);
  assert.equal(a.events[0].kind, "start");
  assert.equal(a.events[0].sessionId, "ses_1");
  const b = m.push(stepStart("ses_1", "msg_1"));
  assert.equal(b.events.length, 0);
});

test("text 事件透传正文并记录 hasText", () => {
  const m = new OpenCodeEventMapper();
  const r = m.push(textEv("ses_1", "msg_1", "hello"));
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "text");
  assert.equal(r.events[0].text, "hello");
  assert.equal(m.hasText, true);
  assert.equal(m.emittedText, "hello");
});

test("同 messageId 的多条 text 按序拼接，每条仍各自产出", () => {
  const m = new OpenCodeEventMapper();
  m.push(textEv("ses_1", "msg_1", "abc"));
  const r = m.push(textEv("ses_1", "msg_1", "def"));
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].text, "def");
  assert.equal(m.emittedText, "abcdef");
});

test("tool_use 产出 tool 事件但不产出正文", () => {
  const m = new OpenCodeEventMapper();
  const r = m.push(toolUse("ses_1", "msg_1"));
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "tool");
  assert.equal(m.hasText, false);
});

test("stdout error 事件 -> UPSTREAM_ERROR，且不搬运 payload 原文", () => {
  const m = new OpenCodeEventMapper();
  const r = m.push({
    type: "error",
    sessionID: "ses_upstream",
    error: { name: "APIError", data: { message: "sensitive upstream details", statusCode: 500 } },
  });
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "error");
  assert.equal(r.events[0].code, "UPSTREAM_ERROR");
  assert.equal(r.events[0].message, "upstream error");
  assert.ok(!r.events[0].message.includes("sensitive upstream details"));
  assert.equal(r.diagnostics.length, 0);
  assert.equal(m.sawAnyEvent, true);
  assert.equal(m.finalize().length, 0, "error 事件已是终止事件，finalize 不再补 PROTOCOL_ERROR");
});

test("未知事件 -> unknown-event 诊断，不抛错", () => {
  const m = new OpenCodeEventMapper();
  const r = m.push({ type: "something_brand_new", part: { x: 1 } });
  assert.equal(r.events.length, 0);
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0].kind, "unknown-event");
});

test("非对象输入 -> 诊断，不抛错", () => {
  const m = new OpenCodeEventMapper();
  for (const bad of [null, 42, "str", undefined, [1, 2]]) {
    const r = m.push(bad);
    assert.equal(r.events.length, 0);
    assert.equal(r.diagnostics[0].kind, "unknown-event");
  }
});

test("usage 默认跨 step 累加", () => {
  const m = new OpenCodeEventMapper();
  m.push(stepFinish("ses_1", "msg_1", "tool-calls", TOK_A));
  m.push(stepFinish("ses_1", "msg_2", "stop", TOK_B));
  assert.deepEqual(m.usage, {
    total: 19308, input: 9724, output: 43, reasoning: 69, cacheRead: 9472, cacheWrite: 0,
  });
});

test("usageMode=last 时只保留最后一个 step", () => {
  const m = new OpenCodeEventMapper({ usageMode: "last" });
  m.push(stepFinish("ses_1", "msg_1", "tool-calls", TOK_A));
  m.push(stepFinish("ses_1", "msg_2", "stop", TOK_B));
  assert.deepEqual(m.usage, {
    total: 9755, input: 214, output: 24, reasoning: 45, cacheRead: 9472, cacheWrite: 0,
  });
});

test("step_finish 的 cache 字段缺失时按 0 处理", () => {
  const m = new OpenCodeEventMapper();
  m.push(stepFinish("ses_1", "msg_1", "stop", { total: 10, input: 6, output: 4, reasoning: 0 }));
  assert.deepEqual(m.usage, { total: 10, input: 6, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
});

test("step_finish 产出 finish 事件，finalize 不再重复产出", () => {
  const m = new OpenCodeEventMapper();
  m.push(textEv("ses_1", "msg_1", "hi"));
  const r = m.push(stepFinish("ses_1", "msg_1", "stop", TOK_A, 5));
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "finish");
  assert.equal(r.events[0].reason, "stop");
  assert.equal(r.events[0].cost, 5);
  assert.equal(m.sawFinish, true);
  assert.equal(m.finalize().length, 0);
});

test("只有 tool_use 没有 text -> finish(tool-calls, TOOL_ONLY_RESPONSE)", () => {
  const m = new OpenCodeEventMapper();
  m.push(toolUse("ses_1", "msg_1"));
  const r = m.push(stepFinish("ses_1", "msg_1", "tool-calls", TOK_A));
  const fin = r.events.find((e) => e.kind === "finish");
  assert.ok(fin, "step_finish 应产出 finish 事件");
  assert.equal(fin.reason, "tool-calls");
  assert.equal(fin.code, "TOOL_ONLY_RESPONSE");
  assert.equal(m.hasText, false);
  assert.equal(m.finalize().length, 0);
});

test("无 finish 即结束 -> finalize 产出 error(PROTOCOL_ERROR)", () => {
  const m = new OpenCodeEventMapper();
  m.push(textEv("ses_1", "msg_1", "hi"));
  const fin = m.finalize();
  assert.equal(fin.length, 1);
  assert.equal(fin[0].kind, "error");
  assert.equal(fin[0].code, "PROTOCOL_ERROR");
});

test("finalize 在完全没有事件时也产出 error(PROTOCOL_ERROR)", () => {
  const m = new OpenCodeEventMapper();
  const fin = m.finalize();
  assert.equal(fin.length, 1);
  assert.equal(fin[0].kind, "error");
});

test("多 step 时 sessionId 取首个非空值", () => {
  const m = new OpenCodeEventMapper();
  m.push(stepStart("ses_A", "msg_1"));
  m.push(stepStart("ses_A", "msg_2"));
  assert.equal(m.sessionId, "ses_A");
});

test("未知 reason -> finish(error, UNKNOWN) 保留原值", () => {
  const m = new OpenCodeEventMapper();
  m.push(textEv("ses_1", "msg_1", "hi"));
  const r = m.push(stepFinish("ses_1", "msg_1", "brand-new-reason", TOK_A));
  assert.equal(r.events[0].kind, "finish");
  assert.equal(r.events[0].reason, "error");
  assert.equal(r.events[0].code, "UNKNOWN");

  const unknownDiagnostics = r.diagnostics.filter((d) => d.kind === "unknown-event");
  assert.equal(unknownDiagnostics.length, 1);
  const [fin_diag] = unknownDiagnostics;
  assert.equal(fin_diag.raw.part.reason, "brand-new-reason");
});

test("step_finish 缺 reason -> finish(error, PROTOCOL_ERROR)", () => {
  const m = new OpenCodeEventMapper();
  m.push(textEv("ses_1", "msg_1", "hi"));
  const r = m.push(stepFinish("ses_1", "msg_1", undefined, TOK_A));
  assert.equal(r.events[0].code, "PROTOCOL_ERROR");
});

test("finish 事件携带的 usage 是当前累计值（不是单步值）", () => {
  const m = new OpenCodeEventMapper();
  m.push(stepFinish("ses_1", "msg_1", "tool-calls", TOK_A));
  const r = m.push(stepFinish("ses_1", "msg_2", "stop", TOK_B));
  assert.equal(r.events[0].usage.total, 19308);
});

test("sawAnyEvent 与 lastMessageId 可用", () => {
  const m = new OpenCodeEventMapper();
  assert.equal(m.sawAnyEvent, false);
  assert.equal(m.lastMessageId, undefined);
  m.push(stepStart("ses_1", "msg_9"));
  assert.equal(m.sawAnyEvent, true);
  assert.equal(m.lastMessageId, "msg_9");
});

test("reasoning 事件 -> CliReasoningEvent（part.text 透传）", () => {
  const m = new OpenCodeEventMapper();
  const r = m.push({ type: "reasoning", sessionID: "ses_1", part: { type: "reasoning", text: "思考内容" } });
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "reasoning");
  assert.equal(r.events[0].text, "思考内容");
  assert.equal(r.diagnostics.length, 0, "reasoning 不得再落 unknown-event 诊断");
});
