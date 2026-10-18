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
  /**
   * text-delta 之间的模拟流式间隔（ms，TODO-12 方案 A 的节奏层）。
   * OC 的 text 整段一次到达，chunk 切分后若同一瞬间全部 yield，DSH 一帧画完
   * （「一波全部出来」）；按间隔产出才有打字机效果。0 = 关闭。
   */
  paceMs?: number;
}

/** 默认节奏：24 字符/块 × 22ms ≈ 每秒 ~1100 字符，长文约 1~2 秒打完。 */
export const DEFAULT_PACE_MS = 22;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  #sawText = false;
  #toolNames: string[] = [];

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
        return [];
      case "tool": {
        // 工具事件不转发（桥是纯文本通道），只记名字供兜底说明（ISSUE-001）。
        const tool = (event.raw as { tool?: unknown } | undefined)?.tool;
        if (typeof tool === "string" && tool !== "" && !this.#toolNames.includes(tool)) {
          this.#toolNames.push(tool);
        }
        return [];
      }
      case "text": {
        if (event.text === "") return [];
        this.#sawText = true;
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
    return this.#finalize(
      {
        kind: "aborted",
        failure: toFailure("CANCELLED"),
      },
      true,
    );
  }

  #finalize(fallback: DshFinishReason, forceFallback = false): DshStreamChunk[] {
    if (this.#ended) return [];
    this.#ended = true;
    const out: DshStreamChunk[] = [];
    // 空气泡兜底（ISSUE-001 实锤根因：纯工具轮零正文）：
    // 模型只做了工具调用、没有任何正文时，合成一段透明说明，避免 DSH 渲染空气泡；
    // finish(tool-calls) 但无 tool-call 块会让 DSH 悬在工具语义上，一并改为正常 stop 收尾。
    // 取消（forceFallback）路径不合成：aborted 是明确终态，注入正文反而误导。
    if (!forceFallback && !this.#sawText && this.#finish?.kind === "tool-calls") {
      const names = this.#toolNames.slice(0, 3).join(", ");
      const notice =
        `[OC-bridge] 本轮模型只进行了工具调用${names ? `（${names}）` : ""}，` +
        `当前桥接版本不支持工具调用转发，因此没有正文输出。请直接用文字提问，或换个问法。`;
      const index = this.#index++;
      out.push({ type: "block-start", index, blockType: "text" });
      for (const piece of chunkText(notice, this.#chunkSize)) {
        out.push({ type: "text-delta", index, text: piece });
      }
      out.push({ type: "block-end", index, block: { type: "text", text: notice } });
      this.#finish = { kind: "stop" };
    }
    out.push(
      { type: "usage", usage: this.#usage ?? mapUsage(ZERO_USAGE) },
      { type: "finish", reason: forceFallback ? fallback : (this.#finish ?? fallback) },
    );
    return out;
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
  const paceMs = options.paceMs ?? DEFAULT_PACE_MS;
  let seenDelta = false;
  /** 模拟流式节奏：text-delta 之间隔一个 paceMs；block/usage/finish 等即时产出。 */
  const emit = async function* (chunks: readonly DshStreamChunk[]): AsyncIterable<DshStreamChunk> {
    for (const chunk of chunks) {
      if (chunk.type === "text-delta") {
        if (paceMs > 0 && seenDelta) await sleep(paceMs);
        seenDelta = true;
      }
      yield chunk;
    }
  };
  try {
    for await (const event of events) {
      yield* emit(converter.push(event));
    }
  } catch (error) {
    if (error instanceof CliBridgeAbortError) {
      yield* emit(converter.abort());
      return;
    }
    if (error instanceof CliBridgeError) {
      yield* emit(converter.push({ kind: "error", code: error.code, message: error.message }));
      yield* emit(converter.end());
      return;
    }
    throw error;
  }
  yield* emit(converter.end());
}
