import type { DshImageAttachmentRef, DshImageRequestTarget, DshStreamChunk, DshTokenUsage } from "./dsh-types.js";
import type { CliDiagnostic, CliTimeouts } from "./types.js";
import { buildPrompt } from "./prompt.js";
import type { PromptMessage } from "./prompt.js";
import { toModelInfo, modelReasoningInfo, variantForEffort } from "./catalog.js";
import type { CatalogModel, ResolvedModelInfo } from "./catalog.js";
import { streamDshChunks } from "./cli-bridge.js";

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
  cli?: { command?: string; extraArgs?: string[]; timeouts?: Partial<CliTimeouts> };
  onDiagnostic?: (d: CliDiagnostic) => void;
  /** 取证钩子：请求开始时拿到完整 prompt（调试用，宿主可落盘）；不得抛异常影响主流程。 */
  onRequestStart?: (info: { prompt: string; model: string; workspace: string; sessionId?: string }) => void;
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

  providerRetryPolicy(): undefined {
    return undefined;
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
    const prompt = buildPrompt({ system: options.system, messages: options.messages });
    const empty = prompt === "";
    const workspace = empty ? "" : this.#deps.resolveWorkspace(options.sessionId);
    try {
      this.#deps.onRequestStart?.({ prompt, model: options.model, workspace, sessionId: options.sessionId });
    } catch { /* 取证钩子不得影响主流程 */ }
    const inner: AsyncIterable<DshStreamChunk> = empty
      ? errorFinishStream("PROMPT_FAILED", "Empty request")
      : streamDshChunks(
          {
            workspace,
            model: options.model,
            prompt,
            variant: variantForEffort(options.reasoningEffort),
            signal: options.signal,
            onDiagnostic: this.#deps.onDiagnostic,
            ...this.#deps.cli,
          },
          {},
        );
    return this.#wrapSummary(inner, options.model);
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
