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

/** 把 DSH 请求消息压平成 OpenCode CLI 的单段 prompt（保真拼接，不改写文本）。 */
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
