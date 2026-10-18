/**
 * DSH `@deepseek-ai/dsh-llm` 公共合同的本地结构镜像（逐字）。
 * 来源：DSH 发行版 app.asar 内嵌 API manifest（docs/research/dsh-llm-contract.md）。
 * 本包不 import DSH 运行时；联合成员、字段名、可选性必须与 DSH 一致。
 */

declare const BRAND: unique symbol;

export type DshBranded<B extends string> = string & { readonly [BRAND]: B };

export type DshToolCallId = DshBranded<"ToolCallId">;
export type DshProviderRequestId = DshBranded<"ProviderRequestId">;
export type DshAttachmentId = DshBranded<"AttachmentId">;

export type DshImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface DshFileAttachmentRef {
  attachmentId: DshAttachmentId;
  name: string;
  bytes: number;
}

export interface DshImageAttachmentRef {
  attachmentId: DshAttachmentId;
  mediaType: DshImageMediaType;
  bytes: number;
  width: number;
  height: number;
  name?: string;
  originalDimensions?: { width: number; height: number };
}

/**
 * 与 DSH `ImageRequestTarget` 一致（0.2.1 起 `LlmAdapter` 第八方法 `imageRequestTarget` 的返回值）。
 * 来源：docs/research/dsh-0.2.1-upgrade-impact.md §3.1。
 */
export interface DshImageRequestTarget {
  width: number;
  height: number;
  maxBytes: number;
}

export interface DshTextBlock {
  type: "text";
  text: string;
}

export interface DshReasoningBlock {
  type: "reasoning";
  text: string;
}

export interface DshImageBlock {
  type: "image";
  attachment: DshImageAttachmentRef;
  offloaded?: true;
}

export interface DshFileBlock {
  type: "file";
  attachment: DshFileAttachmentRef;
}

export interface DshToolCallBlock {
  type: "tool-call";
  id: DshToolCallId;
  name: string;
  arguments: string;
}

export interface DshToolAdditionBlock {
  type: "tool-addition";
  toolName: string;
  tool?: never;
}

export interface DshToolRemovalBlock {
  type: "tool-removal";
  toolName: string;
}

/** 与 DSH `ContentBlockMap` 的 key 集合一致。 */
export type DshContentBlockType =
  | "text"
  | "reasoning"
  | "image"
  | "file"
  | "tool-call"
  | "tool-addition"
  | "tool-removal";

/** 与 DSH `ContentBlock = ContentBlockMap[ContentBlockType]` 一致。 */
export type DshContentBlock =
  | DshTextBlock
  | DshReasoningBlock
  | DshImageBlock
  | DshFileBlock
  | DshToolCallBlock
  | DshToolAdditionBlock
  | DshToolRemovalBlock;

export interface DshTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface DshLlmFailure {
  readonly message: string;
  readonly code: string;
  readonly status?: number;
  readonly providerRetryAfterMs?: number;
  readonly requestId?: DshProviderRequestId;
  readonly offloadImages?: number;
}

/** 与 DSH `FinishReasonMap[keyof FinishReasonMap]` 一致。 */
export type DshFinishReason =
  | { kind: "stop" }
  | { kind: "tool-calls" }
  | { kind: "max-tokens" }
  | { kind: "aborted"; failure: DshLlmFailure }
  | { kind: "error"; failure: DshLlmFailure };

export interface DshReplayEnvelope {
  response: unknown;
  blocks?: readonly unknown[];
}

/** 与 DSH `StreamChunk` 一致。 */
export type DshStreamChunk =
  | { type: "block-start"; index: number; blockType: DshContentBlockType }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | {
      type: "tool-call-delta";
      index: number;
      id: DshToolCallId;
      name?: string;
      argumentsDelta: string;
    }
  | { type: "block-end"; index: number; block: DshContentBlock }
  | { type: "usage"; usage: DshTokenUsage }
  | { type: "finish"; reason: DshFinishReason; replayState?: DshReplayEnvelope };
