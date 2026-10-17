import { test } from "node:test";
import assert from "node:assert/strict";
import { parseModelsOutput, mergeVerified, toModelInfo, STATIC_MODELS } from "../../lib/catalog.js";

test("parseModelsOutput: 一行一个 id，name=id", () => {
  const models = parseModelsOutput("opencode/a\nopencode/b\n");
  assert.deepEqual(models, [
    { id: "opencode/a", name: "opencode/a" },
    { id: "opencode/b", name: "opencode/b" },
  ]);
});

test("parseModelsOutput: CRLF、空行、无斜杠行、去重", () => {
  const models = parseModelsOutput("opencode/a\r\n\r\nnoise\r\nopencode/a\r\nopencode-go/b\r\n");
  assert.deepEqual(models.map((m) => m.id), ["opencode/a", "opencode-go/b"]);
});

test("parseModelsOutput: 空输出 -> 空数组", () => {
  assert.deepEqual(parseModelsOutput(""), []);
});

test("STATIC_MODELS 含已验证免费模型", () => {
  assert.ok(STATIC_MODELS.some((m) => m.id === "opencode/mimo-v2.6-flash-free"));
});

test("mergeVerified: 缺失的静态模型并入尾部，已有不重复", () => {
  const merged = mergeVerified([{ id: "opencode/x", name: "x" }]);
  assert.equal(merged[0].id, "opencode/x");
  assert.ok(merged.some((m) => m.id === "opencode/mimo-v2.6-flash-free"));
  const twice = mergeVerified([...STATIC_MODELS]);
  assert.equal(twice.filter((m) => m.id === "opencode/mimo-v2.6-flash-free").length, 1);
});

test("toModelInfo: provider 与 inputModalities 固定形态", () => {
  assert.deepEqual(toModelInfo("opencode-bridge", { id: "opencode/a", name: "A" }), {
    provider: "opencode-bridge",
    id: "opencode/a",
    name: "A",
    description: undefined,
    inputModalities: ["text"],
  });
});
