# DSH LLM 合同摘录（2026-10-16 提取）

> 来源：DSH 发行版 `F:\Program Files (x86)\DSH\resources\app.asar` 内嵌 API manifest 与参考 adapter 源码（`@deepseek-ai/dsh-llm`，含 DeepSeekAdapter / PiAiAdapter）。
> 用途：`dsh-opencode-bridge` 插件段（子项目 2/3）的类型与合同依据。本文件为只读研究件，逐字引用，不做演绎。
> TODO-01/02/03/15 的答案在此。

## 1. `StreamChunk`（DSH 流协议，逐字）

```ts
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType; }
  | { type: 'text-delta'; index: number; text: string; }
  | { type: 'reasoning-delta'; index: number; text: string; }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string; }
  | { type: 'block-end'; index: number; block: ContentBlock; }
  | { type: 'usage'; usage: TokenUsage; }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope; };
```

## 2. 内容块与结束原因（逐字）

```ts
export interface ContentBlockMap {
    text: TextBlock;
    reasoning: ReasoningBlock;
    image: ImageBlock;
    file: FileBlock;
    'tool-call': ToolCallBlock;
    'tool-addition': ToolAdditionBlock;
    'tool-removal': ToolRemovalBlock;
}
export type ContentBlockType = keyof ContentBlockMap;
export type ContentBlock = ContentBlockMap[ContentBlockType];

export interface TextBlock { type: 'text'; text: string; }
export interface ReasoningBlock { type: 'reasoning'; text: string; }
export interface ToolCallBlock { type: 'tool-call'; id: ToolCallId; name: string; arguments: string; }
export interface ToolAdditionBlock { type: 'tool-addition'; toolName: string; tool?: never; }
export interface ToolRemovalBlock { type: 'tool-removal'; toolName: string; }
export interface ImageBlock { type: 'image'; attachment: ImageAttachmentRef; offloaded?: true; }
export interface FileBlock { type: 'file'; attachment: FileAttachmentRef; }

export interface FinishReasonMap {
    stop: { kind: 'stop'; };
    'tool-calls': { kind: 'tool-calls'; };
    'max-tokens': { kind: 'max-tokens'; };
    aborted: { kind: 'aborted'; failure: LlmFailure; };
    error: { kind: 'error'; failure: LlmFailure; };
}
export type FinishReason = FinishReasonMap[keyof FinishReasonMap];

export interface LlmFailure {
    readonly message: string;
    readonly code: string;
    readonly status?: number;
    readonly providerRetryAfterMs?: number;
    readonly requestId?: ProviderRequestId;
    readonly offloadImages?: number;
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}

export interface ReplayEnvelope { response: unknown; blocks?: readonly unknown[]; }
export type ToolCallId = Branded<'ToolCallId'>;
export type ProviderRequestId = Branded<'ProviderRequestId'>;
export type Branded<B extends string> = string & { readonly [BRAND]: B };
```

## 3. `LlmAdapter` 合同（逐字，TODO-02 答案）

```ts
export abstract class LlmAdapter {
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined;
    imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}

export interface LlmProviderInfo { id: string; name: string; }
export interface LlmModelInfo {
    provider: string; id: string; name: string;
    description?: string; inputModalities?: readonly ModelModality[];
}
export interface LlmResolvedModelInfo extends LlmModelInfo {
    context?: LlmModelContext;             // { contextWindow: number }
    defaultMaxTokens?: number;
    reasoning?: LlmModelReasoningInfo;     // { efforts: readonly LlmReasoningEffortInfo[]; defaultEffort?: ReasoningEffortId }
    systemPromptUpdate?: SystemPromptUpdate; // 'in-history'
    toolUpdate?: ToolUpdate;
}
export interface PreparedAdapterCall {
    readonly model: LlmResolvedModelInfo;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
export type ModelModality = 'text' | 'image';
```

## 4. `GenerateOptions`（逐字，TODO-03 答案）

```ts
export interface GenerateOptions {
    provider: string;
    model: string;
    reasoningEffort?: ReasoningEffortId;
    messages: RequestMessage[];
    system?: string;
    tools?: ToolSchema[];
    toolHistory?: ToolHistory;
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
    signal?: AbortSignal;
    sessionId?: Branded<'SessionId'>;
    purpose?: 'compaction' | 'session-title';
}
export type RequestMessage = Message | RequestUserInput;
export interface MessageBase {
    readonly id: MessageId;
    readonly content: readonly ContentBlock[];
    readonly source: MessageSource;
}
// Message = system | developer | user | assistant | tool 五种 role 的联合
```

**关键事实：`GenerateOptions` 不携带 workspace/cwd/directory 字段**（TODO-04 的 A 候选被否定）；`sessionId` 是 DSH 会话 ID（`Branded<'SessionId'>`），可用于 chat→session 映射（TODO-05）。

## 5. 注册与运行时（逐字，TODO-01 答案）

```ts
// LlmRuntime（ctx.llm）:
registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle
// jsDoc: Register an adapter for the given provider routes. Throws LlmError with code
//   DUPLICATE_ADAPTER if any provider already has an adapter (all-or-nothing).
//   Disposed with the fiber. Returns the disposer, carrying AdapterRegistrationHandle.replace.

export interface AdapterRegistrationHandle {
    (): void;
    replace(providers: string[]): void;
}
```

参考 adapter 的注册范式（DeepSeekAdapter 插件源码）：

```ts
const registration = ctx.llm.registerAdapter([provider], adapter);
```

`LlmRuntime.stream` 的 jsDoc（适配器端注意事项）：

> Stream one model call as raw chunks (token-level deltas). … Adapter selection,
> dispatch, and iteration failures become terminal `error` or `aborted` finish
> chunks; middleware, nested-call, cleanup, and consumer failures remain thrown.

## 6. 参考实现的 chunk 发射范式（PiAiAdapter `toStreamChunks`）

每条内容块：

```text
yield { type: "block-start", index: event.contentIndex, blockType: ... }
yield { type: "text-delta",  index: event.contentIndex, text: ... }   // 一条或多条
yield { type: "block-end",   index: event.contentIndex, block: ... }
```

结尾（正常与错误路径一致）：

```text
yield { type: "usage",  usage: mapUsage(...) }
yield { type: "finish", reason: ... }   // 错误路径 reason.kind = "error"/"aborted"，携带 failure
```

即：`index` 是消息内内容块序号（同一块的三类 chunk 共用），`usage` 紧贴 `finish` 之前，`finish` 是最后一个 chunk。

## 7. 插件打包合同（TODO-25 部分答案）

- bundle 是声明了 `dsh.bundle.patch` 的 npm 包；`package.json` 形如：

```json
{
  "exports": { "./cordis.patch.yml": "./cordis.patch.yml" },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- `cordis.patch.yml` 的 YAML patch 插入插件行（loader YAML 语法，支持 `!!js`）；patch 逐行整体替换 `config`。
- profile 层顺序：bundle patches → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖。
- 热更新：`dsh-hmr` 监视 profile manifest 与 patch 文件；注册句柄随 fiber 销毁（`registerAdapter` 注释明确 "Disposed with the fiber"）。
- DSH 自带插件开发技能：`@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/{decoration,mcp}`（UI 插件四文件模板 / MCP 两文件模板）。

## 8. 遗留改进项（继承自 memory.md 3A.9）

stdout `type:"error"` 事件当前被 CliBridge 按未知事件处理，错误码兜底 `PROTOCOL_ERROR`；应显式映射 `UPSTREAM_ERROR`（子项目 3 前处理）。
