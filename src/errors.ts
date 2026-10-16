import type { ErrorCode, FinishReason } from "./types.js";

export class CliBridgeError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "CliBridgeError";
    this.code = code;
  }
}

export class CliBridgeAbortError extends CliBridgeError {
  constructor(message = "CLI bridge call was aborted") {
    super("CANCELLED", message);
    this.name = "CliBridgeAbortError";
  }
}

const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

const LENGTH_REASONS = new Set(["length", "max_tokens", "max-tokens", "maxtokens"]);
const TOOL_REASONS = new Set(["tool-calls", "tool_calls", "toolcalls", "tool_use", "tool-use"]);

export interface FinishMapping {
  reason: FinishReason;
  code?: ErrorCode;
  rawReason?: string;
}

/**
 * spec §7.2：判定优先级为 "reason 映射" 先于 "空正文检查"。
 * 未知 reason 保守映射为 error + UNKNOWN，绝不抛错。
 */
export function toFinishMapping(
  rawReason: string | undefined,
  hasText: boolean,
): FinishMapping {
  if (rawReason === undefined) {
    return { reason: "error", code: "PROTOCOL_ERROR" };
  }
  const normalized = rawReason.trim().toLowerCase();
  if (normalized === "stop") {
    return hasText
      ? { reason: "stop" }
      : { reason: "error", code: "EMPTY_RESPONSE", rawReason };
  }
  if (LENGTH_REASONS.has(normalized)) {
    return { reason: "max-tokens", rawReason };
  }
  if (TOOL_REASONS.has(normalized)) {
    return hasText
      ? { reason: "tool-calls", rawReason }
      : { reason: "tool-calls", code: "TOOL_ONLY_RESPONSE", rawReason };
  }
  return { reason: "error", code: "UNKNOWN", rawReason };
}

export interface FailureFacts {
  aborted: boolean;
  timedOut: boolean;
  exitCode: number | null;
  sawAnyEvent: boolean;
  sawFinish: boolean;
  stderrText: string;
}

/**
 * spec §6.4 判定链：取消 > 超时 > session 失效 > 无 finish 即退出 > 其他
 */
export function classifyFailure(facts: FailureFacts): ErrorCode {
  if (facts.aborted) return "CANCELLED";
  if (facts.timedOut) return "TIMEOUT";

  const stderr = stripAnsi(facts.stderrText).trim().toLowerCase();

  if (facts.exitCode !== null && facts.exitCode !== 0) {
    if (!facts.sawAnyEvent) {
      if (stderr.includes("session not found")) return "SESSION_INVALID";
      if (stderr.includes("permission") || stderr.includes("denied")) return "PROMPT_FAILED";
      return "PROTOCOL_ERROR";
    }
    return facts.sawFinish ? "UPSTREAM_ERROR" : "PROTOCOL_ERROR";
  }

  if (facts.exitCode === null) return "CLI_START_FAILED";

  // exit 0：进程自称成功。但若全程没有 step_finish，说明协议没走完（判定链第 4 条「无 finish 即退出」）。
  if (!facts.sawFinish) return "PROTOCOL_ERROR";

  return "UNKNOWN";
}

export function canRetry(code: ErrorCode, hasEmittedText: boolean): boolean {
  if (hasEmittedText) return false;
  return code === "CLI_START_FAILED" || code === "TIMEOUT";
}
