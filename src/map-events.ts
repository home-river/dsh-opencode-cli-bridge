import type { CliBridgeEvent, CliDiagnostic, CliUsage } from "./types.js";
import { ZERO_USAGE } from "./types.js";
import { toFinishMapping, type FinishMapping } from "./errors.js";
import { isRecord } from "./parse-lines.js";

export interface MapperOptions {
  usageMode?: "sum" | "last";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function readUsage(part: Record<string, unknown>): CliUsage {
  const tokens = isRecord(part.tokens) ? part.tokens : {};
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  return {
    total: num(tokens.total),
    input: num(tokens.input),
    output: num(tokens.output),
    reasoning: num(tokens.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
  };
}

function addUsage(a: CliUsage, b: CliUsage): CliUsage {
  return {
    total: a.total + b.total,
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/**
 * 把 OpenCode 的原始 JSON 事件归一化为 CliBridgeEvent。
 * 纯逻辑、零 Node API。
 *
 * 关键约定（实测）：事件的 `type` 与 `part.type` 命名不一致 —— 解析以事件 `type` 为准。
 * tool_use 事件的 part.type 是 "tool"，不是 "tool_use"。
 */
export class OpenCodeEventMapper {
  readonly usageMode: "sum" | "last";

  #sessionId = "";
  #startedMessageIds = new Set<string>();
  #textByMessage = new Map<string, string>();
  #hasText = false;
  #usage: CliUsage = { ...ZERO_USAGE };
  #sawFinish = false;
  #sawAnyEvent = false;
  #sawErrorEvent = false;
  #lastMessageId: string | undefined;

  constructor(opts: MapperOptions = {}) {
    this.usageMode = opts.usageMode ?? "sum";
  }

  get sessionId(): string { return this.#sessionId; }
  get hasText(): boolean { return this.#hasText; }
  get sawFinish(): boolean { return this.#sawFinish; }
  get sawAnyEvent(): boolean { return this.#sawAnyEvent; }
  get sawErrorEvent(): boolean { return this.#sawErrorEvent; }
  get lastMessageId(): string | undefined { return this.#lastMessageId; }

  get emittedText(): string {
    let out = "";
    for (const t of this.#textByMessage.values()) out += t;
    return out;
  }

  get usage(): CliUsage { return { ...this.#usage }; }

  push(raw: unknown): { events: CliBridgeEvent[]; diagnostics: CliDiagnostic[] } {
    const events: CliBridgeEvent[] = [];
    const diagnostics: CliDiagnostic[] = [];

    if (!isRecord(raw) || typeof raw.type !== "string") {
      diagnostics.push({ kind: "unknown-event", raw });
      return { events, diagnostics };
    }

    this.#sawAnyEvent = true;

    const sessionId = typeof raw.sessionID === "string" ? raw.sessionID : "";
    if (sessionId && !this.#sessionId) this.#sessionId = sessionId;

    const part = isRecord(raw.part) ? raw.part : {};
    const messageId = typeof part.messageID === "string" ? part.messageID : undefined;
    if (messageId) this.#lastMessageId = messageId;

    switch (raw.type) {
      case "step_start": {
        if (messageId && this.#startedMessageIds.has(messageId)) break;
        if (messageId) this.#startedMessageIds.add(messageId);
        events.push({ kind: "start", sessionId, messageId });
        break;
      }

      case "text": {
        const text = typeof part.text === "string" ? part.text : "";
        const key = messageId ?? "";
        this.#textByMessage.set(key, (this.#textByMessage.get(key) ?? "") + text);
        if (text.length > 0) this.#hasText = true;
        events.push({ kind: "text", sessionId, messageId, text });
        break;
      }

      case "tool_use":
      case "tool_result": {
        events.push({ kind: "tool", sessionId, messageId, raw });
        break;
      }

      case "step_finish": {
        this.#usage = this.usageMode === "last"
          ? readUsage(part)
          : addUsage(this.#usage, readUsage(part));

        const mapping: FinishMapping = toFinishMapping(
          typeof part.reason === "string" ? part.reason : undefined,
          this.#hasText,
        );

        this.#sawFinish = true;
        events.push({
          kind: "finish",
          sessionId,
          messageId,
          reason: mapping.reason,
          usage: { ...this.#usage },
          cost: num(part.cost),
          code: mapping.code,
        });
        if (mapping.code === "UNKNOWN") {
          diagnostics.push({ kind: "unknown-event", raw });
        }
        break;
      }

      case "error": {
        this.#sawErrorEvent = true;
        events.push({ kind: "error", code: "UPSTREAM_ERROR", message: "upstream error" });
        break;
      }

      default: {
        diagnostics.push({ kind: "unknown-event", raw });
        break;
      }
    }

    return { events, diagnostics };
  }

  /** 进程结束时调用。若尚未产出 finish，产出一个 error 事件。 */
  finalize(): CliBridgeEvent[] {
    if (this.#sawFinish || this.#sawErrorEvent) return [];
    return [
      { kind: "error", code: "PROTOCOL_ERROR", message: "process exited without a step_finish event" },
    ];
  }
}
