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
  /**
   * 桥接是纯文本通道（工具调用不转发）。为 true 时在 prompt 末尾追加「禁用工具」指令，
   * 抑制模型走 tool_use —— 否则纯工具轮零正文，DSH 渲染成空气泡（ISSUE-001 根因）。
   */
  textOnly?: boolean;
}

const ROLE_LABELS: Record<string, string> = {
  system: "System",
  developer: "Developer",
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
};

/** 桥级约束指令：放在 prompt 最末，作为对本轮回答的最终要求。 */
export const TEXT_ONLY_NOTICE =
  "IMPORTANT (bridge constraint): 你没有可用的工具，禁止发起任何工具调用（tool call）。" +
  "如果问题需要读文件、执行命令或联网，直接用文字说明你的判断或给出可操作的步骤，" +
  "不要声称“我来查看”“我来运行”。";

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
  if (input.textOnly && sections.length > 0) sections.push(TEXT_ONLY_NOTICE);
  return sections.join("\n\n");
}
