export interface SplitResult {
  lines: string[];
  droppedOversize: string | null;
}

/**
 * 把 stdout 的任意 chunk 流切成"行"。
 * 处理：CRLF、空行、跨 chunk 半行、超长行截断。
 *
 * 超长行有两条进入路径，都要丢弃：
 *   1) 换行符迟迟不来，缓冲区先超过 maxLineBytes
 *   2) 整行 + 换行符在同一个 chunk 里到达（此时取到的行本身就超长）
 */
export class JsonLineSplitter {
  readonly maxLineBytes: number;
  #buf = "";
  #overflow = false;

  constructor(opts: { maxLineBytes?: number } = {}) {
    this.maxLineBytes = opts.maxLineBytes ?? 1_048_576;
  }

  push(chunk: string): SplitResult {
    const lines: string[] = [];
    let droppedOversize: string | null = null;
    this.#buf += chunk;

    let nl = this.#buf.indexOf("\n");
    while (nl >= 0) {
      let line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (this.#overflow) {
        // 上一段是被截断的超长行，这一段只是它的尾巴，丢掉
        this.#overflow = false;
      } else if (line.length === 0) {
        // 空行跳过
      } else if (line.length > this.maxLineBytes) {
        // 路径 2：整行一次到达且超长
        droppedOversize ??= line.slice(0, 80);
      } else {
        lines.push(line);
      }
      nl = this.#buf.indexOf("\n");
    }

    if (this.#buf.length > this.maxLineBytes) {
      // 路径 1：换行符迟迟不来，缓冲区先爆
      droppedOversize ??= this.#buf.slice(0, 80);
      this.#buf = "";
      this.#overflow = true;
    }

    return { lines, droppedOversize };
  }

  flush(): string | null {
    const rest = this.#buf;
    this.#buf = "";
    if (this.#overflow) {
      this.#overflow = false;
      return null;
    }
    return rest.length > 0 ? rest : null;
  }
}

export type LineParseOutcome =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

/** 单行 JSON 解析；失败不抛错，返回 reason 供 protocol-line 诊断使用。 */
export function parseEventLine(line: string): LineParseOutcome {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
