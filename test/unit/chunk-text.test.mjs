import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, DEFAULT_CHUNK_SIZE } from "../../lib/chunk-text.js";

test("chunkText: 空串 -> 空数组", () => {
  assert.deepEqual(chunkText(""), []);
});

test("chunkText: 短于 chunkSize -> 单片", () => {
  assert.deepEqual(chunkText("abc", 4), ["abc"]);
});

test("chunkText: 恰好整倍数 -> 等长片", () => {
  assert.deepEqual(chunkText("abcdef", 3), ["abc", "def"]);
});

test("chunkText: 长文本 -> 各片拼接还原原文", () => {
  const text = "0123456789abcdefghij";
  const pieces = chunkText(text, 4);
  assert.equal(pieces.join(""), text);
  assert.equal(pieces.length, 5);
});

test("chunkText: 按码点切分，不拆散代理对", () => {
  const text = "😀😀😀"; // 3 个码点，6 个 UTF-16 code unit
  const pieces = chunkText(text, 2);
  assert.deepEqual(pieces, ["😀😀", "😀"]);
  assert.equal(pieces.join(""), text);
});

test("chunkText: 默认 chunkSize 为 24", () => {
  assert.equal(DEFAULT_CHUNK_SIZE, 24);
  const text = "x".repeat(25);
  const pieces = chunkText(text);
  assert.deepEqual(pieces, ["x".repeat(24), "x"]);
});

test("chunkText: 非法 chunkSize 抛 TypeError", () => {
  assert.throws(() => chunkText("a", 0), TypeError);
  assert.throws(() => chunkText("a", -1), TypeError);
  assert.throws(() => chunkText("a", 1.5), TypeError);
});
