import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../../lib/prompt.js";
import { buildDeltaPrompt } from "../../lib/prompt.js";
import { hashText } from "../../lib/session-store.js";

test("单条 user 消息 -> User 段", () => {
  assert.equal(
    buildPrompt({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    "User:\nhi",
  );
});

test("system 优先成段，消息按序追加", () => {
  const prompt = buildPrompt({
    system: "be brief",
    messages: [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
    ],
  });
  assert.equal(prompt, "System:\nbe brief\n\nUser:\nq\n\nAssistant:\na");
});

test("五种 role 标签映射 + 未知 role 原样", () => {
  const prompt = buildPrompt({
    messages: [
      { role: "system", content: [{ type: "text", text: "s" }] },
      { role: "developer", content: [{ type: "text", text: "d" }] },
      { role: "tool", content: [{ type: "text", text: "t" }] },
      { role: "custom-role", content: [{ type: "text", text: "c" }] },
    ],
  });
  assert.equal(prompt, "System:\ns\n\nDeveloper:\nd\n\nTool:\nt\n\ncustom-role:\nc");
});

test("同一消息多文本块用换行连接，非 text 块跳过", () => {
  const prompt = buildPrompt({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "line1" },
        { type: "image" },
        { type: "text", text: "line2" },
      ],
    }],
  });
  assert.equal(prompt, "User:\nline1\nline2");
});

test("无文本的消息整段跳过", () => {
  assert.equal(buildPrompt({ messages: [{ role: "user", content: [{ type: "image" }] }] }), "");
  assert.equal(buildPrompt({ messages: [{ role: "user", content: [] }] }), "");
  assert.equal(buildPrompt({ messages: [] }), "");
});

test("空串 system 不产生段；文本不改写", () => {
  assert.equal(buildPrompt({ system: "", messages: [{ role: "user", content: [{ type: "text", text: "  x  " }] }] }), "User:\n  x  ");
});

test("解禁批：prompt 不做任何工具声明（原 textOnly 禁用工具指令已退役）", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "看一下工作区" }] }];
  const out = buildPrompt({ messages });
  assert.equal(out, "User:\n看一下工作区", "保真拼接，不附加任何桥级指令");
  assert.ok(!out.includes("工具调用") && !out.includes("bridge constraint"), "不得含工具禁令/声明");
});

test("buildDeltaPrompt：只发新消息，system 变化才随发", () => {
  const msgs = [
    { role: "user", content: [{ type: "text", text: "第一问" }] },
    { role: "assistant", content: [{ type: "text", text: "第一答" }] },
    { role: "user", content: [{ type: "text", text: "第二问" }] },
  ];
  // 从账本 0 起步、system 首次发送
  const first = buildDeltaPrompt({ system: "S1", messages: msgs, sentCount: 0, systemHash: "" });
  assert.ok(first.text.includes("System:\nS1"));
  assert.ok(first.text.includes("第一问") && first.text.includes("第二问"));
  assert.equal(first.nextSentCount, 3);
  assert.equal(first.nextSystemHash, hashText("S1"));
  // 已送 2 条、system 未变：只发第三条、无 System 段
  const second = buildDeltaPrompt({ system: "S1", messages: msgs, sentCount: 2, systemHash: hashText("S1") });
  assert.ok(!second.text.includes("System:"));
  assert.ok(second.text.includes("第二问") && !second.text.includes("第一问"));
  assert.equal(second.nextSentCount, 3);
});

test("buildDeltaPrompt：system 变化时随增量重发 system 段", () => {
  const msgs = [{ role: "user", content: [{ type: "text", text: "q" }] }];
  const d = buildDeltaPrompt({ system: "S2", messages: msgs, sentCount: 0, systemHash: hashText("S1") });
  assert.ok(d.text.includes("System:\nS2"));
});
