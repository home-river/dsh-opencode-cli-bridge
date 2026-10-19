import type { CliBridgeEvent, CliUsage, ErrorCode, FinishReason } from "./types.js";
import { ZERO_USAGE } from "./types.js";
import { CliBridgeAbortError, CliBridgeError } from "./errors.js";
import { formatNotFoundMessage } from "./install-advice.js";
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

/** 工具镜像截断上限：input 摘要 200 字符、output 2000 字符（回传面可控）。 */
const TOOL_INPUT_MAX = 200;
const TOOL_OUTPUT_MAX = 2000;

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatInputSummary(input: unknown): string {
  if (input === undefined || input === null) return "";
  const s = typeof input === "string" ? input : JSON.stringify(input);
  if (s === "" || s === "{}") return "";
  return ` ${clipText(s, TOOL_INPUT_MAX)}`;
}

const FAILURE_MESSAGES: Record<ErrorCode, string> = {
  // 与 CLI 状态面板 / discover-cli 报错同一口径（formatNotFoundMessage 共享文案）
  CLI_NOT_FOUND: formatNotFoundMessage(),
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

/**
 * CliUsage -> DSH TokenUsage 的字段映射（TODO-13）。
 * 可选字段缺省值归一（QA-2026-10-18 建议 #3）：0 视为「未上报」不发——
 * 各模型上报形态不一致（glm-5.3 全 0），发 0 会让 DSH 显示一排无意义的零。
 */
export function mapUsage(usage: CliUsage): DshTokenUsage {
  const out: DshTokenUsage = {
    inputTokens: usage.input,
    outputTokens: usage.output,
  };
  if (usage.total !== 0) out.totalTokens = usage.total;
  if (usage.cacheRead !== 0) out.cacheReadTokens = usage.cacheRead;
  if (usage.cacheWrite !== 0) out.cacheWriteTokens = usage.cacheWrite;
  if (usage.reasoning !== 0) out.reasoningTokens = usage.reasoning;
  return out;
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
  #toolProgress = new Set<string>();
  #toolMirrored = new Set<string>();

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
        // 透传桥回传层：工具镜像借 reasoning 块的皮（tool-call 块会触发 DSH 自己的工具循环，
        // 同名工具双重执行；见计划 2026-10-19-oc-session-passthrough §0.2 证据）。
        // 两态语义：进行中（无终态）出一行进度；终态（completed/error/tool_result）出完整镜像，
        // 同一 callID 各至多一次（先进度后终态时，终态只补结果行）。
        const raw = (event.raw ?? {}) as {
          type?: unknown;
          tool?: unknown;
          callID?: unknown;
          part?: {
            tool?: unknown;
            callID?: unknown;
            output?: unknown;
            state?: { status?: unknown; input?: unknown; output?: unknown };
          };
        };
        const name =
          typeof raw.part?.tool === "string" ? raw.part.tool
            : typeof raw.tool === "string" ? raw.tool : "";
        const callId =
          typeof raw.part?.callID === "string" ? raw.part.callID
            : typeof raw.callID === "string" ? raw.callID : "";
        if (name !== "" && !this.#toolNames.includes(name)) this.#toolNames.push(name);
        const state = raw.part?.state;
        const status =
          typeof state?.status === "string" ? state.status
            : raw.type === "tool_result" ? "completed" : "";
        const isFinal = raw.type === "tool_result" || status === "completed" || status === "error";
        const head = `🔧 ${name === "" ? "tool" : name}${formatInputSummary(state?.input)}`;
        const outputRaw =
          typeof state?.output === "string" ? state.output
            : typeof raw.part?.output === "string" ? raw.part.output
              : state?.output === undefined ? "" : JSON.stringify(state.output);
        const statusLabel = status === "" ? "completed" : status;
        const tail = outputRaw === ""
          ? `└─ ${statusLabel}`
          : `└─ ${statusLabel} | ${clipText(outputRaw, TOOL_OUTPUT_MAX)}`;

        if (isFinal) {
          if (callId !== "" && this.#toolMirrored.has(callId)) return [];
          if (callId !== "") this.#toolMirrored.add(callId);
          const priorProgress = callId !== "" && this.#toolProgress.has(callId);
          return this.#emitReasoning(priorProgress ? tail : `${head}\n${tail}`);
        }
        if (callId !== "" && (this.#toolProgress.has(callId) || this.#toolMirrored.has(callId))) return [];
        if (callId !== "") this.#toolProgress.add(callId);
        return this.#emitReasoning(head);
      }
      case "reasoning": {
        // 透传桥回传层：OC 思考原生映射为 DSH reasoning 块（折叠/收起呈现）。
        // 思考不算正文：不置 #sawText，零文本保险语义不受影响。
        if (event.text === "") return [];
        return this.#emitReasoning(event.text);
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

  /** 产出一个 reasoning 块（思考/工具镜像共用载体）。 */
  #emitReasoning(text: string): DshStreamChunk[] {
    const index = this.#index++;
    const chunks: DshStreamChunk[] = [
      { type: "block-start", index, blockType: "reasoning" },
    ];
    for (const piece of chunkText(text, this.#chunkSize)) {
      chunks.push({ type: "reasoning-delta", index, text: piece });
    }
    chunks.push({ type: "block-end", index, block: { type: "reasoning", text } });
    return chunks;
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
    // 零文本保险（原 ISSUE-001 空气泡兜底，2026-10-18 解禁批降级为保险）：
    // 工具执行已由进度块（🔧 行）透明化；这里只防「全程零正文」的空气泡。
    // finish(tool-calls) 但无 tool-call 块会让 DSH 悬在工具语义上，一并改为正常 stop 收尾。
    // 取消（forceFallback）路径不合成：aborted 是明确终态，注入正文反而误导。
    if (!forceFallback && !this.#sawText && this.#finish?.kind === "tool-calls") {
      const names = this.#toolNames.slice(0, 3).join("、");
      const notice =
        names === ""
          ? `[OC-bridge] 本轮没有产生文本输出。`
          : `[OC-bridge] 本轮模型执行了工具（${names}）但没有产生文本输出。`;
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
