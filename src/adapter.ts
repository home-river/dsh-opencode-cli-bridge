import type { DshImageAttachmentRef, DshImageRequestTarget, DshResolvedRetryPolicy, DshStreamChunk, DshTokenUsage } from "./dsh-types.js";
import type { CliDiagnostic, CliTimeouts } from "./types.js";
import { buildPrompt, buildDeltaPrompt } from "./prompt.js";
import type { PromptMessage } from "./prompt.js";
import { toModelInfo, modelReasoningInfo, variantForEffort } from "./catalog.js";
import type { CatalogModel, ResolvedModelInfo } from "./catalog.js";
import { streamDshChunks } from "./cli-bridge.js";
import type { SessionStore } from "./session-store.js";

export interface AdapterGenerateOptions {
  provider: string;
  model: string;
  system?: string;
  messages: readonly PromptMessage[];
  /** 思考强度（DSH GenerateOptions.reasoningEffort）；经 `--variant` 透传给 OpenCode CLI。 */
  reasoningEffort?: string;
  signal?: AbortSignal;
  sessionId?: string;
}

export interface OpencodeBridgeDeps {
  resolveWorkspace: (sessionId?: string) => string;
  listModelEntries: () => Promise<readonly CatalogModel[]>;
  /** 会话绑定账本（1:1 透传桥）：DSH 会话 ↔ OC 会话 + 已送达消息水位。 */
  sessionStore: SessionStore;
  cli?: { command?: string; extraArgs?: string[]; timeouts?: Partial<CliTimeouts> };
  onDiagnostic?: (d: CliDiagnostic) => void;
  /** 取证钩子：请求开始时拿到完整 prompt（调试用，宿主可落盘）；不得抛异常影响主流程。 */
  onRequestStart?: (info: { prompt: string; model: string; workspace: string; sessionId?: string; reasoningEffort?: string; ocSessionId?: string }) => void;
  /** 取证钩子：请求结束时拿到终态摘要。 */
  onRequestEnd?: (info: {
    model: string;
    durationMs: number;
    textChars: number;
    finishKind: string;
    finishCode?: string;
  }) => void;
}

const ZERO_TOKEN_USAGE: DshTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

async function* errorFinishStream(code: string, message: string): AsyncIterable<DshStreamChunk> {
  yield { type: "usage", usage: ZERO_TOKEN_USAGE };
  yield { type: "finish", reason: { kind: "error", failure: { message, code } } };
}

/**
 * DSH LlmAdapter 的结构化实现（不 import DSH 运行时；G2/G9）。
 * 八个方法（DSH 0.2.1 起含 `imageRequestTarget`）与 @deepseek-ai/dsh-llm 的 LlmAdapter 合同同名同形。
 */
export class OpencodeBridgeAdapter {
  readonly #deps: OpencodeBridgeDeps;

  constructor(deps: OpencodeBridgeDeps) {
    this.#deps = deps;
  }

  providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: "OpenCode Bridge" };
  }

  /**
   * 收紧 DSH 侧重试：CLI 进程级失败（超时/崩溃）重试代价极高（每次 30s+ 等待），
   * 且重试链会把多次失败信息混排进 UI。按 TODO-21「每轮最多一次内部重试」取
   * maxRetries: 1（DSH 默认策略允许 5 次，见 ISSUE-006）。
   */
  providerRetryPolicy(): DshResolvedRetryPolicy {
    return {
      mode: "normal",
      maxRetries: 1,
      retryableCodes: ["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"],
      backoff: { initialDelayMs: 1_000, maxDelayMs: 3_000, jitterRatio: 0.2 },
    };
  }

  imageRequestPricing(): undefined {
    return undefined;
  }

  /**
   * DSH 0.2.1 起 LlmAdapter 第八方法（ISSUE-003）：返回图片的请求侧目标。
   * 与基类默认实现同语义：本桥不缩放图片，保留归一化原图（宽/高/字节数直通）。
   * 运行时 `LlmRuntime.imageRequestTarget` 是硬调用（无 `?.`），缺失即 TypeError。
   */
  imageRequestTarget(
    _provider: string,
    _model: string,
    image: DshImageAttachmentRef,
  ): DshImageRequestTarget {
    return { width: image.width, height: image.height, maxBytes: image.bytes };
  }

  async listModels(provider: string): Promise<readonly ReturnType<typeof toModelInfo>[]> {
    const entries = await this.#deps.listModelEntries();
    return entries.map((entry) => toModelInfo(provider, entry));
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<ResolvedModelInfo> {
    const models = await this.listModels(provider);
    const found = models.find((m) => m.id === model) ?? {
      provider,
      id: model,
      name: model,
      inputModalities: ["text"] as const,
    };
    // 声明 reasoning 档位（ISSUE-003 问题 2）：不声明时 DSH 0.2.1 对携带
    // reasoningEffort 的请求在 I/O 前抛 UNSUPPORTED_REASONING_EFFORT。
    return { ...found, reasoning: modelReasoningInfo() };
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: AdapterGenerateOptions) => this.stream(options),
    };
  }

  stream(options: AdapterGenerateOptions): AsyncIterable<DshStreamChunk> {
    return this.#wrapSummary(this.#runTurn(options, true), options.model);
  }

  /**
   * 一轮透传调度（计划 2026-10-19-oc-session-passthrough 语义七条）：
   * 1) 查绑定；2) 漂移检测（消息数 < 账本 → 丢绑定全量重放）；3) 增量构建（无新消息时重发末条）；
   * 4) `--session` 续接；5) 首个 OC 会话 id 到达时推进账本；6) 会话失效回退一次（重建+全量重放）。
   */
  async *#runTurn(options: AdapterGenerateOptions, allowResync: boolean): AsyncIterable<DshStreamChunk> {
    const deps = this.#deps;
    const dshId = options.sessionId ?? "";
    const store = deps.sessionStore;
    let binding = store.get(dshId);
    if (binding !== undefined && options.messages.length < binding.sentCount) {
      store.delete(dshId);
      binding = undefined;
    }
    const delta = buildDeltaPrompt({
      system: options.system,
      messages: options.messages,
      sentCount: binding?.sentCount ?? 0,
      systemHash: binding?.systemHash ?? "",
    });
    const prompt = delta.text !== ""
      ? delta.text
      : (binding !== undefined ? buildPrompt({ messages: options.messages.slice(-1) }) : "");
    const workspace = prompt === "" ? "" : deps.resolveWorkspace(options.sessionId);
    try {
      deps.onRequestStart?.({
        prompt,
        model: options.model,
        workspace,
        sessionId: options.sessionId,
        reasoningEffort: options.reasoningEffort,
        ocSessionId: binding?.ocSessionId,
      });
    } catch { /* 取证钩子不得影响主流程 */ }
    if (prompt === "") {
      yield* errorFinishStream("PROMPT_FAILED", "Empty request");
      return;
    }

    let advanced = false;
    const advance = (ocSessionId: string): void => {
      if (advanced || ocSessionId === "") return;
      advanced = true;
      store.save({
        dshSessionId: dshId,
        ocSessionId,
        workspace,
        sentCount: delta.nextSentCount,
        systemHash: delta.nextSystemHash,
        updatedAt: new Date().toISOString(),
      });
    };
    let sessionLost = false;
    const onDiag = (d: CliDiagnostic): void => {
      if (d.kind === "stderr" && d.chunk.includes("Session not found")) sessionLost = true;
      try { deps.onDiagnostic?.(d); } catch { /* 诊断回调不影响主流程 */ }
    };

    const inner = streamDshChunks(
      {
        workspace,
        model: options.model,
        prompt,
        variant: variantForEffort(options.reasoningEffort),
        sessionId: binding?.ocSessionId,
        signal: options.signal,
        onSessionId: advance,
        onDiagnostic: onDiag,
        ...deps.cli,
      },
      {},
    );
    // usage/finish 尾巴缓存到最后再决定：会话失效时吞掉本次终态、换新会话全量重放一次
    const tail: DshStreamChunk[] = [];
    for await (const chunk of inner) {
      if (chunk.type === "usage" || chunk.type === "finish") {
        tail.push(chunk);
        continue;
      }
      yield chunk;
    }
    const lastFinish = tail.find((c) => c.type === "finish");
    const invalid = sessionLost || (
      lastFinish?.type === "finish"
      && lastFinish.reason.kind === "error"
      && "failure" in lastFinish.reason
      && lastFinish.reason.failure.code === "SESSION_INVALID"
    );
    if (allowResync && invalid && options.messages.length > 0) {
      store.delete(dshId);
      yield* this.#runTurn(options, false);
      return;
    }
    for (const chunk of tail) yield chunk;
  }

  /** 取证：统计正文字符数与终态，请求收尾时经 onRequestEnd 回调（钩子异常不影响流）。 */
  #wrapSummary(inner: AsyncIterable<DshStreamChunk>, model: string): AsyncIterable<DshStreamChunk> {
    const deps = this.#deps;
    return (async function* () {
      const t0 = Date.now();
      let textChars = 0;
      let finishKind = "";
      let finishCode: string | undefined;
      try {
        for await (const chunk of inner) {
          if (chunk.type === "text-delta") textChars += chunk.text.length;
          if (chunk.type === "finish") {
            finishKind = chunk.reason.kind;
            finishCode = "failure" in chunk.reason ? chunk.reason.failure?.code : undefined;
          }
          yield chunk;
        }
      } finally {
        try {
          deps.onRequestEnd?.({ model, durationMs: Date.now() - t0, textChars, finishKind, finishCode });
        } catch { /* 取证钩子不得影响主流程 */ }
      }
    })();
  }
}
