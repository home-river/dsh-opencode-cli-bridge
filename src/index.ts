export { name, inject, apply, resolveWorkspace, createModelLister } from "./plugin.js";
export type { PluginContext } from "./plugin.js";
export {
  DEFAULT_EXCLUDE,
  DEFAULT_CONFIG_PATH,
  matchesPattern,
  filterModels,
  selectVisibleModels,
  parseModelFilterConfig,
  loadModelFilterConfig,
} from "./model-filter.js";
export type { ModelFilterConfig, LoadedModelFilter } from "./model-filter.js";

export type {
  CliTimeouts,
  CliUsage,
  FinishReason,
  ErrorCode,
  CliDiagnostic,
  CliBridgeEvent,
  CliBridgeOptions,
  CliBridgeResult,
} from "./types.js";
export { DEFAULT_TIMEOUTS, ZERO_USAGE } from "./types.js";
export {
  CliBridgeError,
  CliBridgeAbortError,
  stripAnsi,
  toFinishMapping,
  classifyFailure,
  canRetry,
} from "./errors.js";
export { JsonLineSplitter, parseEventLine, isRecord } from "./parse-lines.js";
export { OpenCodeEventMapper } from "./map-events.js";
export { discoverOpencodeCli } from "./discover-cli.js";
export type { DiscoverOptions, DiscoveredCli } from "./discover-cli.js";
export { runCliProcess } from "./run-cli.js";
export type { RunCliOptions, RunCliOutcome, TimeoutLayer } from "./run-cli.js";
export { streamCliBridge, runCliBridge } from "./cli-bridge.js";

export { streamDshChunks } from "./cli-bridge.js";
export { toDshChunks, DshChunkConverter, mapUsage } from "./to-dsh-chunks.js";
export type { DshChunkOptions } from "./to-dsh-chunks.js";
export { chunkText, DEFAULT_CHUNK_SIZE } from "./chunk-text.js";
export type {
  DshStreamChunk,
  DshContentBlock,
  DshContentBlockType,
  DshTokenUsage,
  DshFinishReason,
  DshLlmFailure,
  DshReplayEnvelope,
} from "./dsh-types.js";
