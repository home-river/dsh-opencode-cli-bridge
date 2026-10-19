import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * DSH 会话 ↔ OC 会话绑定（1:1 透传桥的账本）。
 * - ocSessionId：OpenCode 会话 id（ses_*），经 `opencode run --session` 续接；
 * - sentCount：已送达 OC 的 DSH 消息条数（增量透传的水位，不含 system）；
 * - systemHash：最近一次随增量送达的 system 哈希（"" = 从未送过）。
 */
export interface SessionBinding {
  dshSessionId: string;
  ocSessionId: string;
  workspace: string;
  sentCount: number;
  systemHash: string;
  updatedAt: string;
}

/** 短哈希（sha1 截断 16 hex）：system/消息指纹用。 */
export function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/**
 * 进程内单例缓存 + 整文件原子写（tmp + rename）。
 * DSH 单进程内多会话并发请求安全：Map 读写串行化于事件循环，落盘整文件替换。
 * 文件损坏按空库处理（上层凭 sentCount=0 全量重放自愈）。
 */
export class SessionStore {
  readonly #file: string;
  readonly #map = new Map<string, SessionBinding>();

  constructor(file: string) {
    this.#file = file;
    if (existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8")) as { bindings?: SessionBinding[] };
        for (const b of data.bindings ?? []) this.#map.set(b.dshSessionId, b);
      } catch {
        /* 损坏文件按空库处理，触发上层重同步 */
      }
    }
  }

  get(dshSessionId: string): SessionBinding | undefined {
    return this.#map.get(dshSessionId);
  }

  save(binding: SessionBinding): void {
    this.#map.set(binding.dshSessionId, binding);
    this.#flush();
  }

  delete(dshSessionId: string): void {
    this.#map.delete(dshSessionId);
    this.#flush();
  }

  #flush(): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = join(dirname(this.#file), `.sessions.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ bindings: [...this.#map.values()] }, null, 2));
    renameSync(tmp, this.#file);
  }
}
