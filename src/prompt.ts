import { hashText } from "./session-store.js";

export interface PromptContentBlock {
  readonly type: string;
  readonly text?: string;
}

export interface PromptMessage {
  readonly role: string;
  readonly content?: readonly PromptContentBlock[];
}

export interface BuildPromptInput {
  system?: string;
  messages: readonly PromptMessage[];
}

const ROLE_LABELS: Record<string, string> = {
  system: "System",
  developer: "Developer",
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
};

/**
 * 把 DSH 请求消息压平成 OpenCode CLI 的单段 prompt（保真拼接，不改写文本）。
 *
 * 设计原则（2026-10-18 解禁批）：prompt 不做任何工具声明——工具面归属由架构决定
 * （OC 回合走 OC 自己的工具；DSH 工具结构上不可达，tool-call 块不过桥）。
 * 原 TEXT_ONLY_NOTICE「禁用工具」指令已退役：它防的是 OC 自有工具的不可见执行，
 * 现由工具事件回流（to-dsh-chunks 进度块）+ 零文本保险承接，见 ISSUE-001 演进注记。
 */
export function buildPrompt(input: BuildPromptInput): string {
  const sections: string[] = [];
  if (input.system !== undefined && input.system !== "") {
    sections.push(`System:\n${input.system}`);
  }
  for (const message of input.messages) {
    const texts: string[] = [];
    for (const block of message.content ?? []) {
      if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
        texts.push(block.text);
      }
    }
    if (texts.length === 0) continue;
    const label = ROLE_LABELS[message.role] ?? message.role;
    sections.push(`${label}:\n${texts.join("\n")}`);
  }
  return sections.join("\n\n");
}

export interface BuildDeltaInput {
  system?: string;
  messages: readonly PromptMessage[];
  /** 账本水位：已送达 OC 的消息条数。 */
  sentCount: number;
  /** 账本记录的 system 哈希（"" = 从未送过）。 */
  systemHash: string;
}

export interface DeltaPrompt {
  text: string;
  nextSentCount: number;
  nextSystemHash: string;
}

/**
 * 增量透传（1:1 会话桥）：只渲染 [sentCount, end) 的新消息；
 * system 仅在内容变化时随增量发送（哈希比对），避免 OC 历史膨胀。
 */
export function buildDeltaPrompt(input: BuildDeltaInput): DeltaPrompt {
  const sections: string[] = [];
  const sys = input.system ?? "";
  const sysHash = sys === "" ? input.systemHash : hashText(sys);
  if (sys !== "" && sysHash !== input.systemHash) {
    sections.push(`System:\n${sys}`);
  }
  for (const message of input.messages.slice(input.sentCount)) {
    const texts: string[] = [];
    for (const block of message.content ?? []) {
      if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
        texts.push(block.text);
      }
    }
    if (texts.length === 0) continue;
    const label = ROLE_LABELS[message.role] ?? message.role;
    sections.push(`${label}:\n${texts.join("\n")}`);
  }
  return {
    text: sections.join("\n\n"),
    nextSentCount: input.messages.length,
    nextSystemHash: sysHash,
  };
}
