import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  CliBridgeEvent,
  CliBridgeOptions,
  CliBridgeResult,
  CliDiagnostic,
  CliTimeouts,
  ErrorCode,
  FinishReason,
} from "./types.js";
import { DEFAULT_TIMEOUTS, ZERO_USAGE } from "./types.js";
import { CliBridgeAbortError, CliBridgeError, classifyFailure, stripAnsi } from "./errors.js";
import { parseEventLine } from "./parse-lines.js";
import { OpenCodeEventMapper } from "./map-events.js";
import { discoverOpencodeCli } from "./discover-cli.js";
import { runCliProcess, type RunCliOutcome } from "./run-cli.js";
import { toDshChunks } from "./to-dsh-chunks.js";
import type { DshChunkOptions } from "./to-dsh-chunks.js";
import type { DshStreamChunk } from "./dsh-types.js";

interface ExecuteResult {
  events: CliBridgeEvent[];
  diagnostics: CliDiagnostic[];
  outcome: RunCliOutcome;
}

function validateOptions(opts: CliBridgeOptions): void {
  if (typeof opts.prompt !== "string" || opts.prompt.length === 0) {
    throw new TypeError("CliBridgeOptions.prompt must be a non-empty string");
  }
  if (typeof opts.model !== "string" || !opts.model.includes("/")) {
    throw new TypeError('CliBridgeOptions.model must look like "provider/model"');
  }
  if (typeof opts.workspace !== "string" || opts.workspace.length === 0) {
    throw new TypeError("CliBridgeOptions.workspace must be a non-empty string");
  }
}

function resolveWorkspace(workspace: string): string {
  const abs = isAbsolute(workspace) ? workspace : resolve(workspace);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new CliBridgeError("WORKSPACE_INVALID", `workspace does not exist: ${abs}`);
  }
  if (!st.isDirectory()) {
    throw new CliBridgeError("WORKSPACE_INVALID", `workspace is not a directory: ${abs}`);
  }
  return abs;
}

function buildArgs(opts: CliBridgeOptions, workspace: string): string[] {
  // G2: 参数一律走 argv 数组，绝不拼接。
  //
  // extraArgs 必须放在 argv **最前**，不能追加到末尾：
  // 测试注入点的典型用法是 `command: process.execPath, extraArgs: [fakeCliPath, "mode:xxx"]`，
  // 而 node 要求脚本路径是第一个位置参数 —— 追加到 "--format json" 之后会让 node 把 "run"
  // 当脚本名执行。真实调用（opencode.exe）不传 extraArgs，此顺序对其无影响。
  const args = [
    ...(opts.extraArgs ?? []),
    "run",
    "--dir", workspace,
    "--model", opts.model,
    "--format", "json",
  ];
  if (opts.sessionId) args.push("--session", opts.sessionId);
  // 思考强度透传（ISSUE-003 问题 2）：DSH reasoningEffort → `opencode run --variant`。
  // CLI 对任意档位静默接受、不做校验（2026-10-17 实测），模型是否响应因 provider 而异。
  if (opts.variant) args.push("--variant", opts.variant);
  // prompt 不进 argv：Windows 命令行上限 32,767 字符，超长 prompt 会让 spawn 直接失败
  // （CLI_START_FAILED，实机空气泡根因之一）。正文经 stdin 送达，opencode run 无位置参数时从 stdin 读。
  return args;
}

/**
 * Ruling F4：内部执行单元，返回事件、诊断与进程结局。
 * 两个入口（streamCliBridge / runCliBridge）都消费它，因此 runCliBridge 能拿到 outcome.exitCode。
 */
async function executeCall(opts: CliBridgeOptions): Promise<ExecuteResult> {
  validateOptions(opts);
  const workspace = resolveWorkspace(opts.workspace);
  const timeouts: CliTimeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };

  const diagnostics: CliDiagnostic[] = [];
  const emitDiag = (d: CliDiagnostic): void => {
    diagnostics.push(d);
    try {
      opts.onDiagnostic?.(d);
    } catch {
      // I8：诊断回调异常不得影响主流程
    }
  };

  const discovered = await discoverOpencodeCli({ command: opts.command });
  const args = buildArgs(opts, workspace);

  const mapper = new OpenCodeEventMapper();
  const events: CliBridgeEvent[] = [];
  let sawAnyLine = false;

  const outcome = await runCliProcess({
    command: discovered.command,
    args,
    cwd: workspace,
    stdinText: opts.prompt,
    signal: opts.signal,
    timeouts,
    onStdoutLine: (line) => {
      sawAnyLine = true;
      const parsed = parseEventLine(line);
      if (!parsed.ok) {
        emitDiag({ kind: "protocol-line", line: line.slice(0, 200), reason: parsed.reason });
        return;
      }
      const r = mapper.push(parsed.value);
      for (const d of r.diagnostics) emitDiag(d);
      for (const e of r.events) events.push(e);
    },
    onStderrChunk: (chunk) => {
      // G7 + I8：剥色后进诊断，且限制长度
      emitDiag({ kind: "stderr", chunk: stripAnsi(chunk).slice(0, 2000) });
    },
    onEvent: () => {},
  });

  // I1：取消走抛，其余一切走事件
  if (outcome.aborted) {
    throw new CliBridgeAbortError();
  }

  // I2/I3：finish 至多一次；无 finish 时以 error 结束
  const tail = mapper.finalize();
  for (const e of tail) {
    if (e.kind === "error") {
      // 主控裁定：finalize() 硬编码的 PROTOCOL_ERROR 要用 classifyFailure 的结果覆盖，
      // 这样 TIMEOUT / SESSION_INVALID 才能正确分类。
      const code: ErrorCode = classifyFailure({
        aborted: outcome.aborted,
        timedOut: outcome.timedOut,
        exitCode: outcome.exitCode,
        sawAnyEvent: sawAnyLine,
        sawFinish: mapper.sawFinish,
        sawErrorEvent: mapper.sawErrorEvent,
        stderrText: outcome.stderrText,
      });
      events.push({ ...e, code, message: `CLI call failed: ${code}` });
    } else {
      events.push(e);
    }
  }

  return { events, diagnostics, outcome };
}

/** Ruling F5：简单版 —— 跑完整个进程，再依次 yield。I1/I2 在此显然成立。 */
export function streamCliBridge(opts: CliBridgeOptions): AsyncIterable<CliBridgeEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<CliBridgeEvent> {
      const r = await executeCall(opts);
      for (const e of r.events) yield e;
    },
  };
}

export async function runCliBridge(opts: CliBridgeOptions): Promise<CliBridgeResult> {
  const t0 = Date.now();

  let text = "";
  let sessionId = "";
  let usage = { ...ZERO_USAGE };
  let finishReason: FinishReason = "error";
  let errorCode: ErrorCode | undefined;
  const diagnostics: CliDiagnostic[] = [];
  const collect = (d: CliDiagnostic): void => {
    diagnostics.push(d);
    try {
      opts.onDiagnostic?.(d);
    } catch {
      /* I8 */
    }
  };

  try {
    const r = await executeCall({ ...opts, onDiagnostic: collect });

    for (const ev of r.events) {
      switch (ev.kind) {
        case "start":
          if (!sessionId && ev.sessionId) sessionId = ev.sessionId;
          break;
        case "text":
          text += ev.text;
          if (!sessionId && ev.sessionId) sessionId = ev.sessionId;
          break;
        case "tool":
          break;
        case "finish":
          usage = ev.usage;
          finishReason = ev.reason;
          errorCode = ev.code;
          if (!sessionId && ev.sessionId) sessionId = ev.sessionId;
          break;
        case "error":
          finishReason = "error";
          errorCode = ev.code;
          break;
      }
    }

    return {
      text,
      sessionId,
      usage,
      finishReason,
      errorCode,
      durationMs: Date.now() - t0,
      exitCode: r.outcome.exitCode,
      diagnostics,
    };
  } catch (e) {
    if (e instanceof CliBridgeAbortError) {
      return {
        text,
        sessionId,
        usage,
        finishReason: "aborted",
        errorCode: "CANCELLED",
        durationMs: Date.now() - t0,
        exitCode: null,
        diagnostics,
      };
    }
    // 建立阶段错误按 Ruling F14 直接 reject
    throw e;
  }
}

/**
 * 端到端入口：OpenCode CLI 事件流 -> DSH StreamChunk 流。
 * 取消/超时/失败都落成终止 finish（aborted/error），不会向外抛（建立期参数错误除外）。
 */
export function streamDshChunks(
  opts: CliBridgeOptions,
  options: DshChunkOptions = {},
): AsyncIterable<DshStreamChunk> {
  return toDshChunks(streamCliBridge(opts), options);
}
