import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonLineSplitter, parseEventLine, isRecord } from "../../lib/parse-lines.js";

test("正常：一行一个 JSON 对象", () => {
  const s = new JsonLineSplitter();
  const r = s.push('{"a":1}\n{"b":2}\n');
  assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}']);
  assert.equal(r.droppedOversize, null);
});

test("CRLF：\\r\\n 也被当作换行，行内不残留 \\r", () => {
  const s = new JsonLineSplitter();
  const r = s.push('{"a":1}\r\n{"b":2}\r\n');
  assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}']);
});

test("分块到达：跨 chunk 的半行被正确缓冲", () => {
  const s = new JsonLineSplitter();
  assert.deepEqual(s.push('{"a":').lines, []);
  assert.deepEqual(s.push('1}\n').lines, ['{"a":1}']);
});

test("空行被跳过", () => {
  const s = new JsonLineSplitter();
  assert.deepEqual(s.push('{"a":1}\n\n\n{"b":2}\n').lines, ['{"a":1}', '{"b":2}']);
});

test("flush 返回残留半行", () => {
  const s = new JsonLineSplitter();
  s.push('{"a":1}\n{"partial"');
  assert.deepEqual(s.push("").lines, []);
  assert.equal(s.flush(), '{"partial"');
});

test("flush 在无残留时返回 null", () => {
  const s = new JsonLineSplitter();
  s.push('{"a":1}\n');
  assert.equal(s.flush(), null);
});

test("超长单行被截断并上报，不 OOM", () => {
  const s = new JsonLineSplitter({ maxLineBytes: 100 });
  const r = s.push("x".repeat(500) + "\n");
  assert.deepEqual(r.lines, []);
  assert.equal(typeof r.droppedOversize, "string");
  assert.equal(s.flush(), null);
});

test("超长行之后的正常行仍被解析", () => {
  const s = new JsonLineSplitter({ maxLineBytes: 50 });
  s.push("y".repeat(200));
  const r = s.push('\n{"ok":1}\n');
  assert.deepEqual(r.lines, ['{"ok":1}']);
});

test("parseEventLine 成功解析对象", () => {
  const r = parseEventLine('{"type":"text"}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { type: "text" });
});

test("parseEventLine 失败时给出 reason，不抛错", () => {
  const r = parseEventLine("not json at all");
  assert.equal(r.ok, false);
  assert.equal(typeof r.reason, "string");
});

test("parseEventLine 对空串返回失败", () => {
  assert.equal(parseEventLine("").ok, false);
});

test("isRecord 判定", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord("x"), false);
});
