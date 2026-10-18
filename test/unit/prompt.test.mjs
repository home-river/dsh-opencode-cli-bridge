import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, TEXT_ONLY_NOTICE } from "../../lib/prompt.js";

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

test("textOnly：末尾追加禁用工具指令，正文不改写（ISSUE-001 空气泡根因抑制）", () => {
  const messages = [{ role: "user", content: [{ type: "text", text: "看一下工作区" }] }];
  const out = buildPrompt({ messages, textOnly: true });
  assert.ok(out.includes("User:\n看一下工作区"), "原文不改写");
  assert.ok(out.endsWith(TEXT_ONLY_NOTICE), "指令应位于 prompt 最末");
  assert.ok(out.includes("禁止发起任何工具调用"));
  assert.ok(!buildPrompt({ messages }).includes(TEXT_ONLY_NOTICE), "缺省不追加");
});
