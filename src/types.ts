export interface CliTimeouts {
  startupMs: number;
  firstEventMs: number;
  idleMs: number;
  totalMs: number;
  shutdownMs: number;
}

export const DEFAULT_TIMEOUTS: CliTimeouts = {
  startupMs: 30_000,
  firstEventMs: 45_000,
  idleMs: 300_000,
  totalMs: 600_000,
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
  signal?: AbortSignal;
  timeouts?: Partial<CliTimeouts>;
  command?: string;
  extraArgs?: string[];
  onDiagnostic?: (d: CliDiagnostic) => void;
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
