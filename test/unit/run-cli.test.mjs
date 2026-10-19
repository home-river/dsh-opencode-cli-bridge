import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
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

async function readSpawnedPid(pidFile) {
  for (let i = 0; i < 50; i++) {
    try {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`fake CLI 未写入 PID 文件: ${pidFile}`);
}

async function assertPidGone(pid) {
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err?.code === "ESRCH") return;
      if (err?.code !== "EPERM") throw err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`取消后进程仍在: pid=${pid}`);
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

test("取消后被 spawn 的进程会消失（按本次 PID 断言）", async () => {
  const pidDir = mkdtempSync(join(tmpdir(), "fake-opencode-"));
  const pidFile = join(pidDir, "fake.pid");
  const ac = new AbortController();
  const { opts } = makeOpts("hang", {
    signal: ac.signal,
    timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 30000, totalMs: 60000, shutdownMs: 1000 },
    env: { ...process.env, FAKE_MODE: "hang", FAKE_PID_FILE: pidFile },
  });
  const p = runCliProcess(opts);
  try {
    const pid = await readSpawnedPid(pidFile);
    setTimeout(() => ac.abort(), 500);
    const out = await p;
    assert.equal(out.aborted, true);
    await assertPidGone(pid);
  } finally {
    rmSync(pidDir, { recursive: true, force: true });
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

test("firstEvent 不误杀：总时长超过 firstEventMs 但首事件已到达 → 正常完成", async () => {
  const { opts, stdoutLines } = makeOpts("long-silence", {
    // FAKE_MODE=long-silence 立刻写 step_start（首事件 <100ms），随后静默 2500ms > firstEventMs
    timeouts: { startupMs: 5000, firstEventMs: 1000, idleMs: 30000, totalMs: 60000, shutdownMs: 1000 },
    env: { ...process.env, FAKE_MODE: "long-silence", FAKE_SILENCE_MS: "2500" },
  });
  const out = await runCliProcess(opts);
  assert.equal(out.timedOut, false);
  assert.equal(out.exitCode, 0);
  assert.ok(stdoutLines.some((l) => l.includes("AFTER_LONG_SILENCE")));
});

test("startup 超时：spawn 成功但无任何事件时触发 timedOutLayer=startup", async () => {
  // 用不写任何 stdio 的子进程（与下方 firstEvent 用例同法）：startup 的语义是
  // 「spawn 成功但无任何事件」的看门狗，首个事件到达即应解除（ISSUE-009）。
  const { opts } = makeOpts("normal", {
    args: ["-e", "setTimeout(() => {}, 600000)"],
    timeouts: { startupMs: 50, firstEventMs: 1000, idleMs: 30000, totalMs: 30000, shutdownMs: 1000 },
  });
  const out = await runCliProcess(opts);
  assert.equal(out.timedOut, true);
  assert.equal(out.timedOutLayer, "startup");
});

test("startup 不误杀（ISSUE-009）：首事件已到达的长回合（>startupMs）正常完成", async () => {
  // fake "slow" 立刻写 step_start（首事件 <100ms），随后 800ms 才写正文。
  // startupMs=150 远小于总时长：startup 层必须在首事件到达时解除，
  // 不得在回合进行中把进程杀掉（修复前 timedOut=true / layer=startup）。
  const { opts, stdoutLines } = makeOpts("slow", {
    timeouts: { startupMs: 150, firstEventMs: 5000, idleMs: 5000, totalMs: 5000, shutdownMs: 500 },
    env: { ...process.env, FAKE_MODE: "slow", FAKE_SLOW_MS: "800" },
  });
  const out = await runCliProcess(opts);
  assert.equal(out.timedOut, false);
  assert.equal(out.exitCode, 0);
  assert.ok(stdoutLines.some((l) => l.includes("SLOW_TEXT")));
});

test("firstEvent 超时：spawn 成功但首事件迟迟不到 → timedOutLayer=firstEvent", async () => {
  // 不写任何 stdio 的进程（不调用 fake fixture，直接跑一个 sleep 子进程）
  // → 首事件永远不到 → firstEventMs 到点触发 firstEvent 层。
  // 必须 startupMs > firstEventMs，否则 startup 层先截胡。
  const { opts } = makeOpts("normal", {
    args: ["-e", "setTimeout(() => {}, 600000)"], // node -e 挂起 10 分钟，不写任何 stdio
    timeouts: { startupMs: 5000, firstEventMs: 500, idleMs: 30000, totalMs: 60000, shutdownMs: 1000 },
  });
  const out = await runCliProcess(opts);
  assert.equal(out.timedOut, true);
  assert.equal(out.timedOutLayer, "firstEvent");
});

test("消费方 onStdoutLine 抛错：runCliProcess 仍正常 resolve，不崩不挂", async () => {
  const { opts } = makeOpts("normal", {
    onStdoutLine: () => {
      throw new Error("consumer boom");
    },
  });
  const out = await runCliProcess(opts);
  assert.equal(out.exitCode, 0);
  assert.equal(out.aborted, false);
  assert.equal(out.timedOut, false);
});
