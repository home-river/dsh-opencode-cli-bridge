import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { OpencodeBridgeAdapter } from "../../lib/adapter.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = resolve(here, "..", "fixtures", "fake-opencode.mjs");

function makeAdapter(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ocbridge-adapter-"));
  writeFileSync(join(dir, "alpha.txt"), "alpha\n");
  const deps = {
    resolveWorkspace: (sessionId) => { deps.seenSessionId = sessionId; return dir; },
    listModelEntries: async () => [{ id: "opencode/mimo-v2.6-flash-free", name: "MiMo Flash" }],
    cli: {
      command: process.execPath,
      extraArgs: [FAKE, "mode:normal"],
      timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 5000, totalMs: 15000, shutdownMs: 1000 },
    },
    ...over,
  };
  return { dir, adapter: new OpencodeBridgeAdapter(deps), deps };
}

const MESSAGES = [{ role: "user", content: [{ type: "text", text: "hello" }] }];

test("providerInfo / providerRetryPolicy / imageRequestPricing", () => {
  const { adapter } = makeAdapter();
  assert.deepEqual(adapter.providerInfo("opencode-bridge"), { id: "opencode-bridge", name: "OpenCode Bridge" });
  assert.equal(adapter.providerRetryPolicy(), undefined);
  assert.equal(adapter.imageRequestPricing(), undefined);
});

test("listModels/resolveModel 映射目录", async () => {
  const { dir, adapter } = makeAdapter();
  try {
    const models = await adapter.listModels("opencode-bridge");
    assert.deepEqual(models, [{
      provider: "opencode-bridge",
      id: "opencode/mimo-v2.6-flash-free",
      name: "MiMo Flash",
      description: undefined,
      inputModalities: ["text"],
    }]);
    const resolved = await adapter.resolveModel("opencode-bridge", "opencode/mimo-v2.6-flash-free");
    assert.equal(resolved.id, "opencode/mimo-v2.6-flash-free");
    const unknown = await adapter.resolveModel("opencode-bridge", "opencode/unknown");
    assert.deepEqual(unknown, { provider: "opencode-bridge", id: "opencode/unknown", name: "opencode/unknown", inputModalities: ["text"] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stream: fake CLI 走通 -> 块 + usage + finish(stop)，workspace/sessionId 接线", async () => {
  const { dir, adapter, deps } = makeAdapter();
  try {
    const chunks = [];
    for await (const c of adapter.stream({
      provider: "opencode-bridge",
      model: "opencode/mimo-v2.6-flash-free",
      messages: MESSAGES,
      sessionId: "ses_dsh_1",
    })) chunks.push(c);
    assert.equal(deps.seenSessionId, "ses_dsh_1");
    assert.equal(chunks[0].type, "block-start");
    assert.equal(chunks.at(-2).type, "usage");
    assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stream: DSH 的 sessionId 只做 workspace 映射，不得透传给 CLI --session（实机 bug：Session not found）", async () => {
  const { dir, adapter, deps } = makeAdapter({
    cli: {
      command: process.execPath,
      extraArgs: [FAKE, "mode:session-echo"],
      timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 5000, totalMs: 15000, shutdownMs: 1000 },
    },
  });
  try {
    const chunks = [];
    for await (const c of adapter.stream({
      provider: "opencode-bridge",
      model: "opencode/mimo-v2.6-flash-free",
      messages: MESSAGES,
      sessionId: "ses_dsh_1",
    })) chunks.push(c);
    // G10：DSH sessionId 继续用于 workspace 解析
    assert.equal(deps.seenSessionId, "ses_dsh_1");
    // G11 / Ruling P8：会话持久化属子项目 4，现阶段不得把 DSH 的 sessionId
    // 传给 `opencode run --session`（该参数要求会话已存在，否则 exit=1 零输出）
    const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
    assert.equal(text, "SESSION=null", "CLI argv 不得携带 --session");
    assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stream: 取证钩子收到完整 prompt 与终态摘要；钩子抛异常不影响主流程", async () => {
  const seen = { start: null, end: null };
  const { dir, adapter } = makeAdapter({
    onRequestStart: (i) => { seen.start = i; },
    onRequestEnd: (i) => { seen.end = i; },
  });
  try {
    const chunks = [];
    for await (const c of adapter.stream({
      provider: "opencode-bridge",
      model: "opencode/mimo-v2.6-flash-free",
      messages: MESSAGES,
      sessionId: "ses_dsh_1",
    })) chunks.push(c);
    assert.ok(seen.start, "onRequestStart 应被调用");
    assert.ok(seen.start.prompt.includes("hello"), "start 应携带完整 prompt");
    assert.equal(seen.start.workspace, dir);
    assert.equal(seen.start.sessionId, "ses_dsh_1");
    assert.ok(seen.end, "onRequestEnd 应被调用");
    assert.equal(seen.end.finishKind, "stop");
    assert.ok(seen.end.textChars > 0);
    assert.ok(seen.end.durationMs >= 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const boom = makeAdapter({
    onRequestStart: () => { throw new Error("boom"); },
    onRequestEnd: () => { throw new Error("boom"); },
  });
  try {
    const chunks = [];
    for await (const c of boom.adapter.stream({
      provider: "opencode-bridge",
      model: "opencode/mimo-v2.6-flash-free",
      messages: MESSAGES,
    })) chunks.push(c);
    assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
  } finally { rmSync(boom.dir, { recursive: true, force: true }); }
});

test("stream: 空请求 -> 直接 error finish，不 spawn", async () => {
  const { dir, adapter } = makeAdapter({ cli: { command: resolve(here, "no-such-exe") } });
  try {
    const chunks = [];
    for await (const c of adapter.stream({ provider: "p", model: "m", messages: [] })) chunks.push(c);
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks[1].reason, {
      kind: "error",
      failure: { message: "Empty request", code: "PROMPT_FAILED" },
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("prepareCall 返回 model + stream，stream 行为一致", async () => {
  const { dir, adapter } = makeAdapter();
  try {
    const prepared = await adapter.prepareCall("opencode-bridge", "opencode/mimo-v2.6-flash-free");
    assert.equal(prepared.model.id, "opencode/mimo-v2.6-flash-free");
    const chunks = [];
    for await (const c of prepared.stream({
      provider: "opencode-bridge",
      model: "opencode/mimo-v2.6-flash-free",
      messages: MESSAGES,
    })) chunks.push(c);
    assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
