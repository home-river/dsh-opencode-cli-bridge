export interface CliTimeouts {
  startupMs: number;
  firstEventMs: number;
  idleMs: number;
  totalMs: number;
  shutdownMs: number;
}

/**
 * 五层超时默认值（spec §8.1）。2026-10-18 解禁批放宽 idle/total：
 * OC 回合现在执行自有工具，单个工具执行（安装/构建类）可长时间无事件（idle 300s→600s），
 * 完整 agent run 可达数十分钟（total 600s→1800s）；启动两层不变。
 */
export const DEFAULT_TIMEOUTS: CliTimeouts = {
  startupMs: 30_000,
  firstEventMs: 45_000,
  idleMs: 600_000,
  totalMs: 1_800_000,
  shutdownMs: 3_000,
};

export interface CliUsage {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ZERO_USAGE: CliUsage = {
  total: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export type FinishReason = "stop" | "max-tokens" | "tool-calls" | "aborted" | "error";

export type ErrorCode =
  | "CLI_NOT_FOUND"
  | "CLI_START_FAILED"
  | "WORKSPACE_INVALID"
  | "SESSION_INVALID"
  | "PROMPT_FAILED"
  | "TIMEOUT"
  | "CANCELLED"
  | "PROTOCOL_ERROR"
  | "UPSTREAM_ERROR"
  | "EMPTY_RESPONSE"
  | "TOOL_ONLY_RESPONSE"
  | "UNKNOWN";

export type CliDiagnostic =
  | { kind: "unknown-event"; raw: unknown }
  | { kind: "protocol-line"; line: string; reason: string }
  | { kind: "stderr"; chunk: string }
  | { kind: "state"; message: string };

export type CliBridgeEvent =
  | { kind: "start"; sessionId: string; messageId?: string }
  | { kind: "text"; sessionId: string; messageId?: string; text: string }
  | { kind: "reasoning"; sessionId: string; messageId?: string; text: string }
  | { kind: "tool"; sessionId: string; messageId?: string; raw: unknown }
  | {
      kind: "finish";
      sessionId: string;
      messageId?: string;
      reason: FinishReason;
      usage: CliUsage;
      cost: number;
      code?: ErrorCode;
    }
  | { kind: "error"; code: ErrorCode; message: string; raw?: unknown };

export interface CliBridgeOptions {
  workspace: string;
  model: string;
  prompt: string;
  sessionId?: string;
  /** 思考强度透传：非空时作为 `opencode run --variant` 的值（ISSUE-003 问题 2）。 */
  variant?: string;
  signal?: AbortSignal;
  timeouts?: Partial<CliTimeouts>;
  command?: string;
  extraArgs?: string[];
  onDiagnostic?: (d: CliDiagnostic) => void;
  /** OC 自有会话 id（ses_*）首次出现在事件流时回调一次（透传桥绑定层用）。 */
  onSessionId?: (sessionId: string) => void;
}

export interface CliBridgeResult {
  text: string;
  sessionId: string;
  usage: CliUsage;
  finishReason: FinishReason;
  /** 执行期失败时的错误分类（Ruling F15）；正常完成时为 undefined */
  errorCode?: ErrorCode;
  durationMs: number;
  exitCode: number | null;
  diagnostics: CliDiagnostic[];
}
