import type { DshStreamChunk, DshTokenUsage } from "./dsh-types.js";
import type { CliDiagnostic, CliTimeouts } from "./types.js";
import { buildPrompt } from "./prompt.js";
import type { PromptMessage } from "./prompt.js";
import { toModelInfo } from "./catalog.js";
import type { CatalogModel } from "./catalog.js";
import { streamDshChunks } from "./cli-bridge.js";

export interface AdapterGenerateOptions {
  provider: string;
  model: string;
  system?: string;
  messages: readonly PromptMessage[];
  signal?: AbortSignal;
  sessionId?: string;
}

export interface OpencodeBridgeDeps {
  resolveWorkspace: (sessionId?: string) => string;
  listModelEntries: () => Promise<readonly CatalogModel[]>;
  cli?: { command?: string; extraArgs?: string[]; timeouts?: Partial<CliTimeouts> };
  onDiagnostic?: (d: CliDiagnostic) => void;
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
 * 七个方法与 @deepseek-ai/dsh-llm 的 LlmAdapter 合同同名同形。
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

  async listModels(provider: string): Promise<readonly ReturnType<typeof toModelInfo>[]> {
    const entries = await this.#deps.listModelEntries();
    return entries.map((entry) => toModelInfo(provider, entry));
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<ReturnType<typeof toModelInfo>> {
    const models = await this.listModels(provider);
    return models.find((m) => m.id === model) ?? {
      provider,
      id: model,
      name: model,
      inputModalities: ["text"],
    };
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: AdapterGenerateOptions) => this.stream(options),
    };
  }

  stream(options: AdapterGenerateOptions): AsyncIterable<DshStreamChunk> {
    const prompt = buildPrompt({ system: options.system, messages: options.messages });
    if (prompt === "") return errorFinishStream("PROMPT_FAILED", "Empty request");
    const workspace = this.#deps.resolveWorkspace(options.sessionId);
    return streamDshChunks(
      {
        workspace,
        model: options.model,
        prompt,
        signal: options.signal,
        onDiagnostic: this.#deps.onDiagnostic,
        ...this.#deps.cli,
      },
      {},
    );
  }
}
