import { spawn, type ChildProcess } from "node:child_process";
import type { CliTimeouts } from "./types.js";
import { CliBridgeError } from "./errors.js";

export type TimeoutLayer = "startup" | "firstEvent" | "idle" | "total";

export interface RunCliOptions {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeouts: CliTimeouts;
  env?: Record<string, string | undefined>;
  onStdoutLine: (line: string) => void;
  onStderrChunk: (chunk: string) => void;
  onEvent: () => void;
}

export interface RunCliOutcome {
  exitCode: number | null;
  signal: string | null;
  aborted: boolean;
  timedOut: boolean;
  timedOutLayer: TimeoutLayer | null;
  durationMs: number;
  stderrText: string;
}

/**
 * G3/G4：按 PID 杀子树，绝不用镜像名清理（会误杀 OpenCode Desktop 常驻进程）。
 * child.kill() 只杀直接子进程；opencode.exe 会派生 git 子进程，所以 /T 是必需项。
 */
function killTree(pid: number, onDone: () => void): void {
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    onDone();
  };
  try {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", finish);
    killer.on("exit", finish);
  } catch {
    finish();
    return;
  }
  const t = setTimeout(finish, 5000);
  t.unref?.();
}

export async function runCliProcess(opts: RunCliOptions): Promise<RunCliOutcome> {
  const t0 = Date.now();
  const { timeouts } = opts;

  // 进入时已中止：不 spawn（G：不产生任何进程）
  if (opts.signal?.aborted) {
    return {
      exitCode: null,
      signal: null,
      aborted: true,
      timedOut: false,
      timedOutLayer: null,
      durationMs: Date.now() - t0,
      stderrText: "",
    };
  }

  let child: ChildProcess;
  try {
    // 参数以 argv 数组传入，不经过命令解释器
    child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    throw new CliBridgeError("CLI_START_FAILED", `failed to spawn ${opts.command}`, e);
  }

  const stderrChunks: string[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let idleTimer: NodeJS.Timeout | null = null;
  let aborted = false;
  let timedOut = false;
  let timedOutLayer: TimeoutLayer | null = null;
  let lastExit: { code: number | null; sig: string | null } | null = null;
  let settled = false;

  let resolveOutcome!: (o: RunCliOutcome) => void;
  const completion = new Promise<RunCliOutcome>((r) => {
    resolveOutcome = r;
  });

  const clearTimers = (): void => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      timedOutLayer = "idle";
      finish();
    }, timeouts.idleMs);
  };

  const addTimer = (ms: number, layer: TimeoutLayer): void => {
    const h = setTimeout(() => {
      timedOut = true;
      timedOutLayer = layer;
      finish();
    }, ms);
    timers.add(h);
  };

  function onAbort(): void {
    aborted = true;
    finish();
  }

  /**
   * Ruling F3：幂等单出口。
   * settled 标志管副作用幂等（清理只做一次）；completion 是唯一的 Promise。
   * 绝不每次 new Promise —— 那会让先触发的 abort/timeout 路径丢掉结果，导致永久挂起。
   */
  function finish(): void {
    if (settled) return;
    settled = true;
    clearTimers();
    opts.signal?.removeEventListener("abort", onAbort);

    const emit = (): void => {
      resolveOutcome({
        exitCode: lastExit?.code ?? null,
        signal: lastExit?.sig ?? null,
        aborted,
        timedOut,
        timedOutLayer,
        durationMs: Date.now() - t0,
        stderrText: stderrChunks.join(""),
      });
    };

    if (lastExit !== null) {
      emit();
      return;
    }

    // 进程还没退：先温和 kill，等 shutdown timeout，再 taskkill /T /F
    let done = false;
    const afterKill = (): void => {
      if (done) return;
      done = true;
      emit();
    };

    try {
      child.kill();
    } catch {
      /* 忽略：进程可能已退 */
    }

    const grace = setTimeout(() => {
      if (lastExit === null && child.pid) {
        killTree(child.pid, afterKill);
      } else {
        afterKill();
      }
    }, timeouts.shutdownMs);
    timers.add(grace);

    child.once("exit", () => {
      clearTimeout(grace);
      afterKill();
    });
  }

  // ---- stdio 收集 ----
  child.stdout?.setEncoding("utf8");
  let stdoutBuf = "";
  child.stdout?.on("data", (chunk: string) => {
    opts.onEvent();
    resetIdle();
    stdoutBuf += chunk;
    let nl = stdoutBuf.indexOf("\n");
    while (nl >= 0) {
      let line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) opts.onStdoutLine(line);
      nl = stdoutBuf.indexOf("\n");
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    opts.onEvent();
    resetIdle();
    // G7: stderr 全程收集（失败判定靠它），同时把原文交给调用方
    stderrChunks.push(chunk);
    opts.onStderrChunk(chunk);
  });

  // ---- 终止路径 ----
  child.on("error", (e) => {
    stderrChunks.push(String(e.message));
    finish();
  });

  child.on("exit", (code, sig) => {
    // 给管道 20ms 收尾，避免丢失尾部输出
    setTimeout(() => {
      lastExit = { code, sig };
      finish();
    }, 20);
  });

  if (opts.signal) {
    opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  // ---- 超时分层（G5/G6）----
  addTimer(timeouts.totalMs, "total");
  addTimer(timeouts.firstEventMs, "firstEvent");
  addTimer(timeouts.startupMs, "startup");
  resetIdle();

  return completion;
}
