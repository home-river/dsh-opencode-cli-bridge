#!/usr/bin/env node
// =====================================================================
// fake-opencode —— 可执行测试替身，模拟 opencode.exe 的 --format json 行为
// 由 FAKE_MODE 环境变量控制。仅供测试，不是产品代码。
// =====================================================================
import { appendFileSync, writeFileSync } from "node:fs";

const SID = process.env.FAKE_SESSION_ID ?? "ses_fake_0001";
const args = process.argv.slice(2);

// 主控裁定：CliBridgeOptions 无 env 字段，mode 经 CLI 参数注入 ——
// fake CLI 约定：argv 中第一个形如 "mode:xxx" 的位以此覆盖 FAKE_MODE；
// 不含该前缀时行为不变（既有 FAKE_MODE env 路径共存，不受影响）。
const MODE = args.find((a) => typeof a === "string" && a.startsWith("mode:"))?.slice(5)
  ?? process.env.FAKE_MODE ?? "normal";

function line(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function stepStart(msg) {
  return { type: "step_start", sessionID: SID, part: { type: "step-start", id: "prt_s", messageID: msg } };
}
function text(msg, t) {
  return { type: "text", sessionID: SID, part: { type: "text", id: "prt_t", messageID: msg, text: t, time: { start: 1, end: 2 } } };
}
function finish(msg, reason, tokens, cost = 0) {
  return { type: "step_finish", sessionID: SID, part: { type: "step-finish", id: "prt_f", messageID: msg, reason, tokens, cost } };
}
function tool(msg) {
  return {
    type: "tool_use", sessionID: SID,
    part: { type: "tool", tool: "bash", callID: "call_x",
            state: { status: "completed", input: { command: "ls" }, output: "a.txt" } },
  };
}
const T1 = { total: 100, input: 60, output: 20, reasoning: 10, cache: { read: 10, write: 0 } };
const T2 = { total: 200, input: 120, output: 40, reasoning: 20, cache: { read: 20, write: 0 } };

if (process.env.FAKE_PID_FILE) {
  try { writeFileSync(process.env.FAKE_PID_FILE, String(process.pid)); } catch {}
}

if (process.env.FAKE_LOG_ARGS) {
  try { appendFileSync(process.env.FAKE_LOG_ARGS, JSON.stringify(args) + "\n"); } catch {}
}

switch (MODE) {
  case "normal":
    line(stepStart("msg_1"));
    line(text("msg_1", "FAKE_NORMAL_OK"));
    line(finish("msg_1", "stop", T1));
    break;

  case "multiline":
    line(stepStart("msg_1"));
    line(text("msg_1", "part-A "));
    line(text("msg_1", "part-B "));
    line(text("msg_1", "part-C"));
    line(finish("msg_1", "stop", T1));
    break;

  case "multi-step":
    line(stepStart("msg_1"));
    line(tool("msg_1"));
    line(finish("msg_1", "tool-calls", T1));
    line(stepStart("msg_2"));
    line(text("msg_2", "SECOND_STEP_TEXT"));
    line(finish("msg_2", "stop", T2));
    break;

  case "tool-only":
    line(stepStart("msg_1"));
    line(tool("msg_1"));
    line(finish("msg_1", "tool-calls", T1));
    break;

  case "empty":
    line(stepStart("msg_1"));
    line(finish("msg_1", "stop", T1));
    break;

  case "partial-line":
    line(stepStart("msg_1"));
    line(text("msg_1", "BEFORE_TRUNCATION"));
    process.stdout.write('{"type":"text","part":{"text":"TRUNCATED');
    break;

  case "non-json":
    line(stepStart("msg_1"));
    process.stdout.write("this line is not json at all\n");
    line(text("msg_1", "CLEAN_TEXT"));
    line(finish("msg_1", "stop", T1));
    break;

  case "stderr-noise":
    process.stderr.write("diagnostic noise from cli\n");
    line(stepStart("msg_1"));
    process.stderr.write("more noise\n");
    line(text("msg_1", "WITH_STDERR_NOISE"));
    line(finish("msg_1", "stop", T1));
    break;

  case "exit-nonzero":
    line(stepStart("msg_1"));
    line(text("msg_1", "PARTIAL"));
    process.exit(1);

  case "no-finish":
    line(stepStart("msg_1"));
    line(text("msg_1", "NO_FINISH_TEXT"));
    break;

  case "hang":
    line(stepStart("msg_1"));
    line(text("msg_1", "HANG_TEXT"));
    await sleep(600_000);
    break;

  case "slow":
    line(stepStart("msg_1"));
    await sleep(Number(process.env.FAKE_SLOW_MS ?? 3000));
    line(text("msg_1", "SLOW_TEXT"));
    line(finish("msg_1", "stop", T1));
    break;

  case "startup-fail":
    process.stderr.write("Error: cannot start\n");
    process.exit(127);

  case "oversize-line":
    line(stepStart("msg_1"));
    process.stdout.write("X".repeat(2_000_000) + "\n");
    line(text("msg_1", "AFTER_OVERSIZE"));
    line(finish("msg_1", "stop", T1));
    break;

  case "unknown-events":
    line(stepStart("msg_1"));
    line({ type: "brand_new_event", sessionID: SID, part: { weird: true } });
    line({ type: "reasoning", sessionID: SID, part: { type: "reasoning", text: "thinking" } });
    line(text("msg_1", "AFTER_UNKNOWN"));
    line(finish("msg_1", "stop", T1));
    break;

  case "session-echo": {
    const i = args.indexOf("--session");
    const seen = i >= 0 ? args[i + 1] : null;
    line(stepStart("msg_1"));
    line(text("msg_1", `SESSION=${seen}`));
    line(finish("msg_1", "stop", T1));
    break;
  }

  case "session-not-found":
    process.stderr.write("\u001b[91m\u001b[1mError: \u001b[0mSession not found\r\n");
    process.exit(1);

  case "long-silence":
    line(stepStart("msg_1"));
    await sleep(Number(process.env.FAKE_SILENCE_MS ?? 5000));
    line(text("msg_1", "AFTER_LONG_SILENCE"));
    line(finish("msg_1", "stop", T1));
    break;

  default:
    process.stderr.write(`fake-opencode: unknown FAKE_MODE=${MODE}\n`);
    process.exit(2);
}
