import { spawn, type ChildProcess } from "node:child_process";
import type { CliTimeouts } from "./types.js";
import { CliBridgeError } from "./errors.js";

export type TimeoutLayer = "startup" | "firstEvent" | "idle" | "total";

export interface RunCliOptions {
  command: string;
  args: string[];
  cwd: string;
  /** 经 stdin 送达的请求正文（prompt）；写完立即关闭 stdin。 */
  stdinText?: string;
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
  // 注意：taskkill 卡死时此 fallback 会在进程可能仍在运行的情况下就 resolve（afterKill），
  // 属已知取舍——总比永久挂起好；调用方以 outcome 而非进程状态为准。
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
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    throw new CliBridgeError("CLI_START_FAILED", `failed to spawn ${opts.command}`, e);
  }

  // prompt 经 stdin 送达（避开 Windows 32,767 字符命令行上限），写完立即关闭。
  // 子进程提前退出时写入会 EPIPE —— 必须吞掉，不得变成未捕获异常。
  try {
    child.stdin?.on("error", () => { /* EPIPE：子进程已退，忽略 */ });
    child.stdin?.end(opts.stdinText ?? "");
  } catch {
    /* stdin 不可用：忽略，交由后续事件/退出路径收场 */
  }

  const stderrChunks: string[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let idleTimer: NodeJS.Timeout | null = null;
  let firstEventTimer: NodeJS.Timeout | null = null;
  let startupTimer: NodeJS.Timeout | null = null;
  let exitFlushTimer: NodeJS.Timeout | null = null;
  let aborted = false;
  let timedOut = false;
  let timedOutLayer: TimeoutLayer | null = null;
  let lastExit: { code: number | null; sig: string | null } | null = null;
  let settled = false;
  /** stdout 行缓冲。终止时若留有残余（无换行的尾部半行）必须 flush，不得静默丢弃。 */
  let stdoutBuf = "";
  // C1：spawn 后立刻捕获 pid（grace timer 触发时 child.pid 可能已为 undefined）
  const spawnedPid = child.pid ?? null;
  // C1：child.on("exit") 同步记录 lastExit 后，等待管道 20ms 收尾再触发的回调队列
  const exitWaiters: Array<() => void> = [];

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
    // I2：首个事件到达时语义上 firstEvent 已满足；即使没到达，emit 时也必须清掉
    if (firstEventTimer) {
      clearTimeout(firstEventTimer);
      firstEventTimer = null;
    }
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    // C1：20ms 尾部收尾 timer 必须被跟踪并清除，不得悬挂
    if (exitFlushTimer) {
      clearTimeout(exitFlushTimer);
      exitFlushTimer = null;
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

  // I2：首个事件到达时清除 firstEvent 定时器（spec §8.1：spawn 成功 → 首个事件）
  // ISSUE-009：startup 同语义 —— 它是「spawn 成功但无任何事件」的看门狗，
  // 首个事件到达即解除。此前它无人清除、全程计时，把所有超过 startupMs 的
  // 进行中回合全部误杀（30s + shutdownMs 3s ≈ 33s 墙）。
  const markFirstEvent = (): void => {
    if (firstEventTimer) {
      clearTimeout(firstEventTimer);
      firstEventTimer = null;
    }
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
  };

  const addTimer = (ms: number, layer: TimeoutLayer): void => {
    const h = setTimeout(() => {
      timedOut = true;
      timedOutLayer = layer;
      finish();
    }, ms);
    timers.add(h);
    if (layer === "firstEvent") firstEventTimer = h;
    if (layer === "startup") startupTimer = h;
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
      // 尾部半行 flush：最后一行若没带换行符，行缓冲里会留残余。
      // 静默丢弃会让「JSON 半行被截断」这种协议错误无法诊断（spec §6.3），
      // 也可能丢掉无尾换行的合法末行。交给 onStdoutLine，由解析层判定它是合法行还是协议污染。
      const tail = stdoutBuf;
      stdoutBuf = "";
      if (tail.length > 0) {
        try {
          opts.onStdoutLine(tail.endsWith("\r") ? tail.slice(0, -1) : tail);
        } catch (e) {
          stderrChunks.push(`run-cli: onStdoutLine callback threw: ${String(e)}\n`);
        }
      }
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

    // C1：确保 emit 只发生在 lastExit 已知、或明确"已 kill 无退出码"之后
    let emitted = false;
    const afterKill = (): void => {
      if (emitted) return;
      emitted = true;
      emit();
    };

    // C1：真实退出码要等 child 的 exit 事件（含 20ms 管道收尾）；把 afterKill 挂进
    // exitWaiters，而不是另起一个 once("exit")——避免与外层 exit 回调竞态、以 null 退出码收场。
    // spawn error（exit 永远不来）时由 child "error" 事件兜底收场。
    exitWaiters.push(afterKill);

    // 无 pid 说明 spawn 失败：exit 不会到来，立即留下诊断并收场
    if (spawnedPid === null) {
      stderrChunks.push("run-cli: no child pid captured at spawn; killTree skipped — process tree may leak\n");
      afterKill();
      return;
    }

    try {
      child.kill();
    } catch {
      /* 忽略：进程可能已退 */
    }

    const grace = setTimeout(() => {
      if (lastExit === null) {
        // I1：killTree 必须执行；pid 缺失在上面已作为 spawn 失败诊断处理
        killTree(spawnedPid, afterKill);
      } else {
        afterKill();
      }
    }, timeouts.shutdownMs);
    timers.add(grace);
  }

  // ---- stdio 收集 ----
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    markFirstEvent();
    // I3：消费方回调不得让异常窜进流机制
    try {
      opts.onEvent();
    } catch {
      /* 消费方回调抛错：忽略，不中断流处理 */
    }
    resetIdle();
    stdoutBuf += chunk;
    let nl = stdoutBuf.indexOf("\n");
    while (nl >= 0) {
      let line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) {
        try {
          opts.onStdoutLine(line);
        } catch (e) {
          stderrChunks.push(`run-cli: onStdoutLine callback threw: ${String(e)}\n`);
        }
      }
      nl = stdoutBuf.indexOf("\n");
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    markFirstEvent();
    try {
      opts.onEvent();
    } catch {
      /* 消费方回调抛错：忽略，不中断流处理 */
    }
    resetIdle();
    // G7: stderr 全程收集（失败判定靠它），同时把原文交给调用方
    stderrChunks.push(chunk);
    try {
      opts.onStderrChunk(chunk);
    } catch {
      /* I3：消费方回调抛错：忽略，stderr 原文已收集 */
    }
  });

  // ---- 终止路径 ----
  child.on("error", (e) => {
    stderrChunks.push(String(e.message));
    finish();
  });

  child.on("exit", (code, sig) => {
    // C1：lastExit 同步记录——不能等 20ms，否则 finish() 的 kill 路径会以 null 退出码 emit
    lastExit = { code, sig };
    if (settled) return; // finish() 的 kill 路径自行收场，无需再排 20ms 收尾 timer
    // 给管道 20ms 收尾，避免丢失尾部输出；timer 必须被跟踪，emit 时统一清除
    exitFlushTimer = setTimeout(() => {
      exitFlushTimer = null;
      const waiters = exitWaiters.splice(0);
      if (waiters.length > 0) {
        // finish() 的 kill 路径已把 afterKill 挂进来：等退出码已知后再收场
        for (const w of waiters) w();
        return;
      }
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
