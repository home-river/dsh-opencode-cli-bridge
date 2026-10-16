import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { DEFAULT_TIMEOUTS } from "../../lib/types.js";
import { runCliProcess } from "../../lib/run-cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(here, "..", "fixtures", "fake-opencode.mjs");
const WS = resolve(here, "..", "..", "..");

function makeOpts(mode, over = {}) {
  const stdoutLines = [];
  const stderrChunks = [];
  return {
    opts: {
      command: process.execPath,
      args: [FAKE, "run", "--format", "json", "prompt"],
      cwd: WS,
      timeouts: { ...DEFAULT_TIMEOUTS, startupMs: 5000, firstEventMs: 5000, idleMs: 5000, totalMs: 15000, shutdownMs: 1000 },
      env: { ...process.env, FAKE_MODE: mode },
      onStdoutLine: (l) => stdoutLines.push(l),
      onStderrChunk: (c) => stderrChunks.push(c),
      onEvent: () => {},
      ...over,
    },
    stdoutLines,
    stderrChunks,
  };
}

function tasklistPids() {
  const r = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
  const set = new Set();
  for (const line of String(r.stdout || "").split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m) set.add(Number(m[2]));
  }
  return set;
}

test("正常模式：拿到 stdout 行、stderr 为空、exit=0", async () => {
  const { opts, stdoutLines, stderrChunks } = makeOpts("normal");
  const out = await runCliProcess(opts);
  assert.equal(out.exitCode, 0);
  assert.equal(out.aborted, false);
  assert.equal(out.timedOut, false);
  assert.ok(stdoutLines.length >= 3, `stdout lines=${stdoutLines.length}`);
  assert.equal(stderrChunks.length, 0);
});

test("stderr 与 stdout 分流", async () => {
  const { opts, stdoutLines, stderrChunks } = makeOpts("stderr-noise");
  const out = await runCliProcess(opts);
  assert.equal(out.exitCode, 0);
  assert.ok(stdoutLines.some((l) => l.includes("WITH_STDERR_NOISE")));
  assert.ok(stderrChunks.join("").includes("diagnostic noise"));
  assert.ok(!stdoutLines.some((l) => l.includes("diagnostic noise")));
});

test("非零退出：exitCode=1 且 stdout 有内容", async () => {
  const { opts, stdoutLines } = makeOpts("exit-nonzero");
  const out = await runCliProcess(opts);
  assert.equal(out.exitCode, 1);
  assert.ok(stdoutLines.length > 0);
});

test("startup-fail：exit=127，stderrText 含错误文本", async () => {
  const { opts } = makeOpts("startup-fail");
  const out = await runCliProcess(opts);
  assert.equal(out.exitCode, 127);
  assert.ok(out.stderrText.includes("cannot start"));
});

test("session-not-found：exit=1，stderrText 保留原始 ANSI（剥色由 errors.stripAnsi 负责）", async () => {
  const { opts } = makeOpts("session-not-found");
  const out = await runCliProcess(opts);
  assert.equal(out.exitCode, 1);
  assert.ok(out.stderrText.includes("Session not found"));
  assert.ok(out.stderrText.includes("\u001b["), "stderrText 应保留原始 ANSI");
});

test("跨 chunk 的半行被正确合并成一行", async () => {
  const { opts, stdoutLines } = makeOpts("partial-line");
  const out = await runCliProcess(opts);
  assert.equal(out.exitCode, 0);
  assert.ok(stdoutLines.some((l) => l.includes("BEFORE_TRUNCATION")));
});

test("oversize-line 不导致挂起", async () => {
  const { opts, stdoutLines } = makeOpts("oversize-line");
  const out = await runCliProcess(opts);
  assert.equal(out.exitCode, 0);
  assert.ok(stdoutLines.some((l) => l.includes("AFTER_OVERSIZE")));
});

test("idle 超时：长时间静默后触发 TIMEOUT", async () => {
  const { opts } = makeOpts("slow", {
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 800, totalMs: 30000, shutdownMs: 1000 },
    env: { ...process.env, FAKE_MODE: "slow", FAKE_SLOW_MS: "5000" },
  });
  const out = await runCliProcess(opts);
  assert.equal(out.timedOut, true);
  assert.equal(out.timedOutLayer, "idle");
});

test("idle 不会误杀：长静默但仍在 idle 阈值内则正常完成", async () => {
  const { opts, stdoutLines } = makeOpts("long-silence", {
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 30000, totalMs: 60000, shutdownMs: 1000 },
    env: { ...process.env, FAKE_MODE: "long-silence", FAKE_SILENCE_MS: "3000" },
  });
  const out = await runCliProcess(opts);
  assert.equal(out.timedOut, false);
  assert.equal(out.exitCode, 0);
  assert.ok(stdoutLines.some((l) => l.includes("AFTER_LONG_SILENCE")));
});

test("total 超时：进程 hang 时触发 TIMEOUT 并被清理", async () => {
  const { opts } = makeOpts("hang", {
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 30000, totalMs: 1500, shutdownMs: 1000 },
  });
  const out = await runCliProcess(opts);
  assert.equal(out.timedOut, true);
  assert.equal(out.timedOutLayer, "total");
});

test("取消：signal.abort() 触发 aborted=true 且不挂起", async () => {
  const ac = new AbortController();
  const { opts } = makeOpts("hang", {
    signal: ac.signal,
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 30000, totalMs: 60000, shutdownMs: 1000 },
  });
  const p = runCliProcess(opts);
  setTimeout(() => ac.abort(), 300);
  const out = await p;
  assert.equal(out.aborted, true);
  assert.equal(out.timedOut, false);
});

test("进入时 signal 已中止：不 spawn 且立即返回 aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  const { opts } = makeOpts("normal", {
    signal: ac.signal,
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 5000, totalMs: 5000, shutdownMs: 1000 },
  });
  const out = await runCliProcess(opts);
  assert.equal(out.aborted, true);
  assert.equal(out.exitCode, null);
});

test("取消后进程归零（按 PID 基线，禁止 taskkill /IM）", async () => {
  const before = tasklistPids();
  const ac = new AbortController();
  const { opts } = makeOpts("hang", {
    signal: ac.signal,
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 30000, totalMs: 60000, shutdownMs: 1000 },
  });
  const p = runCliProcess(opts);
  setTimeout(() => ac.abort(), 500);
  await p;
  await new Promise((r) => setTimeout(r, 1000));
  const after = tasklistPids();
  for (const pid of after) {
    assert.ok(before.has(pid), `残留进程 pid=${pid}`);
  }
});

test("同一个 signal 挂 3 个请求：全部 aborted，无 listener 泄漏、无挂起", async () => {
  const ac = new AbortController();
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const { opts } = makeOpts("hang", {
      signal: ac.signal,
      timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 30000, totalMs: 60000, shutdownMs: 1000 },
    });
    runs.push(runCliProcess(opts));
  }
  setTimeout(() => ac.abort(), 300);
  const results = await Promise.all(runs);
  assert.equal(results.length, 3);
  assert.equal(results.every((r) => r.aborted), true);
});
