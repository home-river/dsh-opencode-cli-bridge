import type { CliBridgeEvent, CliUsage, ErrorCode, FinishReason } from "./types.js";
import { ZERO_USAGE } from "./types.js";
import { CliBridgeAbortError, CliBridgeError } from "./errors.js";
import { chunkText, DEFAULT_CHUNK_SIZE } from "./chunk-text.js";
import type {
  DshFinishReason,
  DshLlmFailure,
  DshStreamChunk,
  DshTokenUsage,
} from "./dsh-types.js";

export interface DshChunkOptions {
  chunkSize?: number;
}

const FAILURE_MESSAGES: Record<ErrorCode, string> = {
  CLI_NOT_FOUND: "OpenCode CLI not found",
  CLI_START_FAILED: "OpenCode CLI failed to start",
  WORKSPACE_INVALID: "Invalid workspace directory",
  SESSION_INVALID: "OpenCode session is invalid",
  PROMPT_FAILED: "OpenCode CLI failed to process the prompt",
  TIMEOUT: "OpenCode CLI timed out",
  CANCELLED: "Request cancelled",
  PROTOCOL_ERROR: "OpenCode CLI output protocol error",
  UPSTREAM_ERROR: "Upstream model error",
  EMPTY_RESPONSE: "Model returned an empty response",
  TOOL_ONLY_RESPONSE: "Model returned only tool calls",
  UNKNOWN: "Unknown error",
};

/** CliUsage -> DSH TokenUsage 的字段映射（TODO-13）。 */
export function mapUsage(usage: CliUsage): DshTokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.total,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    reasoningTokens: usage.reasoning,
  };
}

function toFailure(code: ErrorCode): DshLlmFailure {
  return { message: FAILURE_MESSAGES[code], code };
}

function toDshFinish(reason: FinishReason, code?: ErrorCode): DshFinishReason {
  switch (reason) {
    case "stop":
      return { kind: "stop" };
    case "max-tokens":
      return { kind: "max-tokens" };
    case "tool-calls":
      return { kind: "tool-calls" };
    case "aborted":
      return { kind: "aborted", failure: toFailure(code ?? "CANCELLED") };
    case "error":
      return { kind: "error", failure: toFailure(code ?? "UNKNOWN") };
  }
}

/**
 * CliBridgeEvent -> DshStreamChunk 的纯状态机。
 * text 立即成块；finish/error 只记录终端状态，由 end()/abort() 收尾，
 * 保证一次请求恰好一条 usage + 一条 finish（G8，兼容多 step 多 finish 的 F16 语义）。
 */
export class DshChunkConverter {
  readonly #chunkSize: number;
  #index = 0;
  #usage: DshTokenUsage | null = null;
  #finish: DshFinishReason | null = null;
  #ended = false;

  constructor(options: DshChunkOptions = {}) {
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new TypeError(`chunkSize must be a positive integer, got ${String(chunkSize)}`);
    }
    this.#chunkSize = chunkSize;
  }

  push(event: CliBridgeEvent): DshStreamChunk[] {
    if (this.#ended) return [];
    switch (event.kind) {
      case "start":
      case "tool":
        return [];
      case "text": {
        if (event.text === "") return [];
        const index = this.#index++;
        const chunks: DshStreamChunk[] = [
          { type: "block-start", index, blockType: "text" },
        ];
        for (const piece of chunkText(event.text, this.#chunkSize)) {
          chunks.push({ type: "text-delta", index, text: piece });
        }
        chunks.push({ type: "block-end", index, block: { type: "text", text: event.text } });
        return chunks;
      }
      case "finish":
        this.#usage = mapUsage(event.usage);
        this.#finish = toDshFinish(event.reason, event.code);
        return [];
      case "error":
        this.#usage = mapUsage(ZERO_USAGE);
        this.#finish = { kind: "error", failure: toFailure(event.code) };
        return [];
    }
  }

  /** 源流自然结束的收尾；幂等。无终端记录时兜底 error(PROTOCOL_ERROR)。 */
  end(): DshStreamChunk[] {
    return this.#finalize({
      kind: "error",
      failure: toFailure("PROTOCOL_ERROR"),
    });
  }

  /** 取消收尾；幂等。 */
  abort(): DshStreamChunk[] {
    return this.#finalize({
      kind: "aborted",
      failure: toFailure("CANCELLED"),
    });
  }

  #finalize(fallback: DshFinishReason): DshStreamChunk[] {
    if (this.#ended) return [];
    this.#ended = true;
    return [
      { type: "usage", usage: this.#usage ?? mapUsage(ZERO_USAGE) },
      { type: "finish", reason: this.#finish ?? fallback },
    ];
  }
}

/**
 * 把 CliBridgeEvent 异步流包装成 DshStreamChunk 异步流。
 * 源的取消/失败异常在此转化为终止 finish（DSH 合同：迭代失败落成终止 chunk）；
 * 其他异常原样抛给调用方。
 */
export async function* toDshChunks(
  events: AsyncIterable<CliBridgeEvent>,
  options: DshChunkOptions = {},
): AsyncIterable<DshStreamChunk> {
  const converter = new DshChunkConverter(options);
  try {
    for await (const event of events) {
      yield* converter.push(event);
    }
  } catch (error) {
    if (error instanceof CliBridgeAbortError) {
      yield* converter.abort();
      return;
    }
    if (error instanceof CliBridgeError) {
      yield* converter.push({ kind: "error", code: error.code, message: error.message });
      yield* converter.end();
      return;
    }
    throw error;
  }
  yield* converter.end();
}
