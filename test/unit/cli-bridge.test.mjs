import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { streamCliBridge, runCliBridge } from "../../lib/cli-bridge.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(here, "..", "fixtures", "fake-opencode.mjs");

function baseOpts(mode, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ocbridge-ws-"));
  writeFileSync(join(dir, "alpha.txt"), "alpha\n");
  // 约定：extraArgs 在 argv 里紧跟 "run"（fake CLI 脚本路径必须紧跟 node 解释器）；
  // fake CLI 以 argv 中第一个 "mode:xxx" 位覆盖 FAKE_MODE。
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

function collect(opts) {
  return (async () => {
    const events = [];
    for await (const e of streamCliBridge(opts)) events.push(e);
    return events;
  })();
}

test("prompt 经 stdin 送达：常规 prompt 不占 argv（stdin-echo 回显长度）", async () => {
  const { dir, opts } = baseOpts("stdin-echo", { prompt: "hello" });
  try {
    const r = await runCliBridge(opts);
    assert.equal(r.text, "STDIN_LEN=5", "prompt 必须经 stdin 完整送达");
    assert.equal(r.finishReason, "stop");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prompt 经 stdin 送达：40K 超长 prompt 不触发 CLI_START_FAILED（Windows 32767 命令行上限回归）", async () => {
  const { dir, opts } = baseOpts("stdin-echo", { prompt: "x".repeat(40_000) });
  try {
    const r = await runCliBridge(opts);
    assert.equal(r.text, "STDIN_LEN=40000", "超长 prompt 必须经 stdin 送达，不得走 argv");
    assert.equal(r.finishReason, "stop");
    assert.equal(r.errorCode, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("normal -> start/text/finish(stop)，正文与 usage 正确", async () => {
  const { dir, opts } = baseOpts("normal");
  try {
    const r = await runCliBridge(opts);
    assert.equal(r.text, "FAKE_NORMAL_OK");
    assert.equal(r.finishReason, "stop");
    assert.equal(r.exitCode, 0);
    assert.equal(r.usage.total, 100);
    assert.equal(r.sessionId, "ses_fake_0001");
    assert.equal(r.errorCode, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("multiline -> 多段 text 拼接正确", async () => {
  const { dir, opts } = baseOpts("multiline");
  try {
    const r = await runCliBridge(opts);
    assert.equal(r.text, "part-A part-B part-C");
    assert.equal(r.finishReason, "stop");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("multi-step -> usage 跨 step 累加；每个 step_finish 一个 finish（Ruling F16）", async () => {
  const { dir, opts } = baseOpts("multi-step");
  try {
    const events = await collect(opts);
    const finishes = events.filter((e) => e.kind === "finish");
    // Ruling F16：I2 已修订为「每个 step_finish 一个 finish，usage 为累计值」。
    // 实测一次问答就有 2 个 step_finish（tool-calls + stop），压成 1 个会丢 step 边界。
    assert.equal(finishes.length, 2, "每个 step_finish 产出一个 finish");
    assert.equal(finishes[0].reason, "tool-calls");
    assert.equal(finishes[1].reason, "stop");
    // usage 必须是累计值，不是单步值
    assert.equal(finishes[0].usage.total, 100);
    assert.equal(finishes[1].usage.total, 300);
    // I2（修订版）：最后一个 finish 之后不再产出任何事件
    const lastFinish = events.map((e) => e.kind).lastIndexOf("finish");
    assert.equal(events.slice(lastFinish + 1).length, 0, "最后一个 finish 之后不得有事件");
    assert.equal(events.filter((e) => e.kind === "start").length, 2);
    assert.equal(events.find((e) => e.kind === "text")?.text, "SECOND_STEP_TEXT");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tool-only -> finish(tool-calls) + errorCode=TOOL_ONLY_RESPONSE", async () => {
  const { dir, opts } = baseOpts("tool-only");
  try {
    const r = await runCliBridge(opts);
    assert.equal(r.text, "");
    assert.equal(r.finishReason, "tool-calls");
    assert.equal(r.errorCode, "TOOL_ONLY_RESPONSE");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("empty -> finish(error) + errorCode=EMPTY_RESPONSE", async () => {
  const { dir, opts } = baseOpts("empty");
  try {
    const r = await runCliBridge(opts);
    assert.equal(r.text, "");
    assert.equal(r.finishReason, "error");
    assert.equal(r.errorCode, "EMPTY_RESPONSE");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("partial-line -> 半行诊断，正文不受污染，流以 error 结束", async () => {
  const { dir, opts } = baseOpts("partial-line");
  const diags = [];
  try {
    const events = await collect({ ...opts, onDiagnostic: (d) => diags.push(d) });
    assert.equal(events.at(-1).kind, "error", "I1: 无 finish 时以 error 结束");
    assert.ok(diags.some((d) => d.kind === "protocol-line"));
    const texts = events.filter((e) => e.kind === "text").map((e) => e.text).join("");
    assert.equal(texts, "BEFORE_TRUNCATION");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("non-json -> 污染行诊断，正文干净", async () => {
  const { dir, opts } = baseOpts("non-json");
  const diags = [];
  try {
    const r = await runCliBridge({ ...opts, onDiagnostic: (d) => diags.push(d) });
    assert.equal(r.text, "CLEAN_TEXT");
    assert.equal(r.finishReason, "stop");
    assert.ok(diags.some((d) => d.kind === "protocol-line"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stderr-noise -> stderr 进诊断，正文不受污染", async () => {
  const { dir, opts } = baseOpts("stderr-noise");
  const diags = [];
  try {
    const r = await runCliBridge({ ...opts, onDiagnostic: (d) => diags.push(d) });
    assert.equal(r.text, "WITH_STDERR_NOISE");
    assert.equal(r.finishReason, "stop");
    assert.ok(diags.some((d) => d.kind === "stderr"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unknown-events -> 全部诊断，不抛错", async () => {
  const { dir, opts } = baseOpts("unknown-events");
  const diags = [];
  try {
    const r = await runCliBridge({ ...opts, onDiagnostic: (d) => diags.push(d) });
    assert.equal(r.text, "AFTER_UNKNOWN");
    assert.equal(r.finishReason, "stop");
    assert.equal(diags.filter((d) => d.kind === "unknown-event").length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("session-not-found -> 执行期 resolve，errorCode=SESSION_INVALID（Ruling F14）", async () => {
  const { dir, opts } = baseOpts("session-not-found");
  const diags = [];
  try {
    const r = await runCliBridge({ ...opts, onDiagnostic: (d) => diags.push(d) });
    assert.equal(r.finishReason, "error");
    assert.equal(r.errorCode, "SESSION_INVALID");
    assert.ok(diags.some((d) => d.kind === "stderr"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no-finish -> 流以 error 结束，errorCode=PROTOCOL_ERROR", async () => {
  const { dir, opts } = baseOpts("no-finish");
  try {
    const events = await collect(opts);
    const last = events.at(-1);
    assert.equal(last.kind, "error");
    assert.equal(last.code, "PROTOCOL_ERROR");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("oversize-line -> 不 OOM，后续事件仍解析", async () => {
  const { dir, opts } = baseOpts("oversize-line");
  try {
    const r = await runCliBridge(opts);
    assert.equal(r.text, "AFTER_OVERSIZE");
    assert.equal(r.finishReason, "stop");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("session-echo -> sessionId 透传到 CLI 参数", async () => {
  const { dir, opts } = baseOpts("session-echo", { sessionId: "ses_INJECTED" });
  try {
    const r = await runCliBridge(opts);
    assert.equal(r.text, "SESSION=ses_INJECTED");
    assert.equal(r.sessionId, "ses_fake_0001");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("取消 -> runCliBridge resolve 且 finishReason=aborted（I4），不 reject", async () => {
  const { dir, opts } = baseOpts("hang", {
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 30000, totalMs: 60000, shutdownMs: 1000 },
  });
  const ac = new AbortController();
  try {
    const p = runCliBridge({ ...opts, signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    const r = await p;
    assert.equal(r.finishReason, "aborted");
    assert.equal(r.errorCode, "CANCELLED");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("超时 -> runCliBridge resolve 且 errorCode=TIMEOUT（I4）", async () => {
  const { dir, opts } = baseOpts("hang", {
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 30000, totalMs: 1200, shutdownMs: 1000 },
  });
  try {
    const r = await runCliBridge(opts);
    assert.equal(r.finishReason, "error");
    assert.equal(r.errorCode, "TIMEOUT");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("streamCliBridge 取消 -> 抛 CliBridgeAbortError（I1）", async () => {
  const { dir, opts } = baseOpts("hang", {
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 30000, totalMs: 60000, shutdownMs: 1000 },
  });
  const ac = new AbortController();
  try {
    const p = collect({ ...opts, signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(p, (e) => {
      assert.equal(e.name, "CliBridgeAbortError");
      assert.equal(e.code, "CANCELLED");
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workspace 不存在 -> 建立阶段 reject WORKSPACE_INVALID（Ruling F14）", async () => {
  await assert.rejects(
    () => runCliBridge({
      workspace: resolve(here, "no-such-dir-xyz"), model: "a/b", prompt: "x",
      command: process.execPath, extraArgs: [FAKE],
    }),
    (e) => { assert.equal(e.code, "WORKSPACE_INVALID"); return true; },
  );
});

test("model 不含斜杠 -> 建立阶段 TypeError", async () => {
  const { dir, opts } = baseOpts("normal");
  try {
    await assert.rejects(() => runCliBridge({ ...opts, model: "badmodel" }), /model/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prompt 为空 -> 建立阶段 TypeError", async () => {
  const { dir, opts } = baseOpts("normal");
  try {
    await assert.rejects(() => runCliBridge({ ...opts, prompt: "" }), /prompt/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("I2: finish 之后不再产出事件", async () => {
  const { dir, opts } = baseOpts("multi-step");
  try {
    const events = await collect(opts);
    const lastFinish = events.map((e) => e.kind).lastIndexOf("finish");
    assert.ok(lastFinish >= 0);
    const after = events.slice(lastFinish + 1);
    assert.equal(after.length, 0, `finish 之后还有 ${after.length} 个事件`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("I5: 连续 20 轮进程归零（按本次 PID 断言，Ruling F12）", async () => {
  const { runCliProcess } = await import("../../lib/run-cli.js");
  const { DEFAULT_TIMEOUTS } = await import("../../lib/types.js");
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 20; i++) {
    const dir = mkdtempSync(join(tmpdir(), "ocbridge-i5-"));
    const pidFile = join(dir, "fake.pid");
    try {
      const out = await runCliProcess({
        command: process.execPath,
        args: [FAKE, "mode:normal", "run", "--format", "json", "hi"],
        cwd: dir,
        timeouts: { ...DEFAULT_TIMEOUTS, startupMs: 5000, firstEventMs: 5000, idleMs: 5000, totalMs: 15000, shutdownMs: 1000 },
        env: { ...process.env, FAKE_PID_FILE: pidFile },
        onStdoutLine: () => {}, onStderrChunk: () => {}, onEvent: () => {},
      });
      assert.equal(out.exitCode, 0);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      assert.ok(!alive(pid), `第 ${i} 轮残留进程 pid=${pid}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
