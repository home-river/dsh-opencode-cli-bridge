import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CliBridgeError,
  CliBridgeAbortError,
  stripAnsi,
  toFinishMapping,
  classifyFailure,
  canRetry,
} from "../../lib/errors.js";

test("stripAnsi 去掉 ANSI 颜色码", () => {
  assert.equal(stripAnsi("\u001b[91m\u001b[1mError: \u001b[0mSession not found"), "Error: Session not found");
});

test("stripAnsi 对无色文本原样返回", () => {
  assert.equal(stripAnsi("plain"), "plain");
});

test("toFinishMapping: reason=stop 且有正文 -> stop", () => {
  assert.deepEqual(toFinishMapping("stop", true), { reason: "stop" });
});

test("toFinishMapping: reason=stop 但无正文 -> error + EMPTY_RESPONSE", () => {
  assert.deepEqual(toFinishMapping("stop", false), {
    reason: "error",
    code: "EMPTY_RESPONSE",
    rawReason: "stop",
  });
});

test("toFinishMapping: 长度截断 -> max-tokens（大小写与下划线变体都认）", () => {
  for (const r of ["length", "max_tokens", "max-tokens", "MaxTokens"]) {
    assert.equal(toFinishMapping(r, true).reason, "max-tokens", r);
  }
});

test("toFinishMapping: tool-calls 有正文 -> tool-calls", () => {
  assert.deepEqual(toFinishMapping("tool-calls", true), { reason: "tool-calls", rawReason: "tool-calls" });
});

test("toFinishMapping: tool-calls 无正文 -> tool-calls + TOOL_ONLY_RESPONSE", () => {
  assert.deepEqual(toFinishMapping("tool-calls", false), {
    reason: "tool-calls",
    code: "TOOL_ONLY_RESPONSE",
    rawReason: "tool-calls",
  });
});

test("toFinishMapping: 未知 reason 保守映射为 error + UNKNOWN，保留原值", () => {
  assert.deepEqual(toFinishMapping("weird-new-reason", true), {
    reason: "error",
    code: "UNKNOWN",
    rawReason: "weird-new-reason",
  });
});

test("toFinishMapping: rawReason 为 undefined -> PROTOCOL_ERROR", () => {
  assert.deepEqual(toFinishMapping(undefined, true), {
    reason: "error",
    code: "PROTOCOL_ERROR",
  });
});

test("classifyFailure: 优先级 —— 取消压过超时与退出码", () => {
  assert.equal(
    classifyFailure({ aborted: true, timedOut: true, exitCode: 1, sawAnyEvent: true, sawFinish: false, stderrText: "Session not found" }),
    "CANCELLED",
  );
});

test("classifyFailure: 超时", () => {
  assert.equal(
    classifyFailure({ aborted: false, timedOut: true, exitCode: null, sawAnyEvent: false, sawFinish: false, stderrText: "" }),
    "TIMEOUT",
  );
});

test("classifyFailure: exit!=0 + 无事件 + stderr 'Session not found' -> SESSION_INVALID", () => {
  assert.equal(
    classifyFailure({
      aborted: false, timedOut: false, exitCode: 1, sawAnyEvent: false, sawFinish: false,
      stderrText: "\u001b[91m\u001b[1mError: \u001b[0mSession not found\r\n",
    }),
    "SESSION_INVALID",
  );
});

test("classifyFailure: exit!=0 + 无事件 + permission -> PROMPT_FAILED", () => {
  assert.equal(
    classifyFailure({ aborted: false, timedOut: false, exitCode: 1, sawAnyEvent: false, sawFinish: false, stderrText: "permission denied" }),
    "PROMPT_FAILED",
  );
});

test("classifyFailure: exit!=0 + 无事件 + 其他 stderr -> PROTOCOL_ERROR", () => {
  assert.equal(
    classifyFailure({ aborted: false, timedOut: false, exitCode: 1, sawAnyEvent: false, sawFinish: false, stderrText: "boom" }),
    "PROTOCOL_ERROR",
  );
});

test("classifyFailure: 见过上游 error 事件优先于「有事件但无 finish」-> UPSTREAM_ERROR", () => {
  assert.equal(
    classifyFailure({
      aborted: false, timedOut: false, exitCode: 1, sawAnyEvent: true,
      sawFinish: false, sawErrorEvent: true, stderrText: "",
    }),
    "UPSTREAM_ERROR",
  );
  assert.equal(
    classifyFailure({
      aborted: false, timedOut: false, exitCode: 0, sawAnyEvent: true,
      sawFinish: false, sawErrorEvent: true, stderrText: "",
    }),
    "UPSTREAM_ERROR",
  );
});

test("classifyFailure: 没见过上游 error 事件时，有事件但无 finish 仍 -> PROTOCOL_ERROR", () => {
  assert.equal(
    classifyFailure({
      aborted: false, timedOut: false, exitCode: 1, sawAnyEvent: true,
      sawFinish: false, sawErrorEvent: false, stderrText: "",
    }),
    "PROTOCOL_ERROR",
  );
});

test("classifyFailure: exit=0 但全程无 finish -> PROTOCOL_ERROR（协议没走完）", () => {
  assert.equal(
    classifyFailure({ aborted: false, timedOut: false, exitCode: 0, sawAnyEvent: true, sawFinish: false, stderrText: "" }),
    "PROTOCOL_ERROR",
  );
});

test("classifyFailure: exit=0 且有 finish -> UNKNOWN（不误判成协议错误）", () => {
  assert.equal(
    classifyFailure({ aborted: false, timedOut: false, exitCode: 0, sawAnyEvent: true, sawFinish: true, stderrText: "" }),
    "UNKNOWN",
  );
});

test("classifyFailure: exit=null 且未取消未超时 -> CLI_START_FAILED", () => {
  assert.equal(
    classifyFailure({ aborted: false, timedOut: false, exitCode: null, sawAnyEvent: false, sawFinish: false, stderrText: "" }),
    "CLI_START_FAILED",
  );
});

test("canRetry: 未产出正文且是启动失败/超时 -> 可重试", () => {
  assert.equal(canRetry("CLI_START_FAILED", false), true);
  assert.equal(canRetry("TIMEOUT", false), true);
});

test("canRetry: 已产出正文一律不重试", () => {
  assert.equal(canRetry("CLI_START_FAILED", true), false);
  assert.equal(canRetry("TIMEOUT", true), false);
});

test("canRetry: 取消/未找到 CLI/工作区非法 均不重试", () => {
  assert.equal(canRetry("CANCELLED", false), false);
  assert.equal(canRetry("CLI_NOT_FOUND", false), false);
  assert.equal(canRetry("WORKSPACE_INVALID", false), false);
});

test("CliBridgeError 携带 code 且是 Error", () => {
  const e = new CliBridgeError("TIMEOUT", "took too long");
  assert.ok(e instanceof Error);
  assert.equal(e.code, "TIMEOUT");
  assert.equal(e.name, "CliBridgeError");
});

test("CliBridgeAbortError 的 code 是 CANCELLED", () => {
  const e = new CliBridgeAbortError();
  assert.equal(e.code, "CANCELLED");
  assert.ok(e instanceof CliBridgeError);
});
