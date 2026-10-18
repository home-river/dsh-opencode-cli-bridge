import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { OpencodeBridgeAdapter } from "../../lib/adapter.js";
import { createModelLister } from "../../lib/plugin.js";

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
  // 重试收紧（ISSUE-006）：CLI 级失败重试代价高，最多 1 次（DSH 默认 5 次）
  assert.deepEqual(adapter.providerRetryPolicy(), {
    mode: "normal",
    maxRetries: 1,
    retryableCodes: ["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"],
    backoff: { initialDelayMs: 1000, maxDelayMs: 3000, jitterRatio: 0.2 },
  });
  assert.equal(adapter.imageRequestPricing(), undefined);
});

test("imageRequestTarget 与基类默认实现同语义：不缩放，保留归一化原图（ISSUE-003）", () => {
  const { adapter } = makeAdapter();
  const ref = {
    attachmentId: "att_1",
    mediaType: "image/png",
    bytes: 1234,
    width: 800,
    height: 600,
    originalDimensions: { width: 1600, height: 1200 },
  };
  const target = adapter.imageRequestTarget("opencode-bridge", "opencode/mimo-v2.6-flash-free", ref);
  // 基类默认实现读 image.width/height/bytes，不读 originalDimensions
  assert.deepEqual(target, { width: 800, height: 600, maxBytes: 1234 });
  // 运行时是同步硬调用（无 await）：返回值不得是 Promise
  assert.equal(target.then, undefined);
  // provider/model 参数被忽略（与基类默认实现一致）
  assert.deepEqual(adapter.imageRequestTarget("p2", "m2", ref), target);
  assert.doesNotThrow(() => adapter.imageRequestTarget("x", "y", {
    attachmentId: "a", mediaType: "image/jpeg", bytes: 1, width: 1, height: 1,
  }));
});

test("LlmAdapter 八方法合同护栏：DSH 0.2.1 起含 imageRequestTarget（ISSUE-003）", () => {
  const { adapter } = makeAdapter();
  for (const name of [
    "providerInfo",
    "providerRetryPolicy",
    "imageRequestPricing",
    "imageRequestTarget",
    "listModels",
    "resolveModel",
    "prepareCall",
    "stream",
  ]) {
    assert.equal(typeof adapter[name], "function", `missing adapter method: ${name}`);
  }
  // pricing 与 target 语义不同，防误合并：一个返回 undefined，一个返回对象
  assert.equal(adapter.imageRequestPricing(), undefined);
  assert.notEqual(adapter.imageRequestTarget("x", "y", {
    attachmentId: "a", mediaType: "image/png", bytes: 1, width: 1, height: 1,
  }), undefined);
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
    assert.deepEqual(unknown, {
      provider: "opencode-bridge",
      id: "opencode/unknown",
      name: "opencode/unknown",
      inputModalities: ["text"],
      reasoning: resolved.reasoning,
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resolveModel/prepareCall 声明 reasoning 档位：过 DSH 0.2.1 运行时校验（ISSUE-003 问题 2）", async () => {
  const { dir, adapter } = makeAdapter();
  try {
    for (const resolved of [
      await adapter.resolveModel("opencode-bridge", "opencode/mimo-v2.6-flash-free"),
      (await adapter.prepareCall("opencode-bridge", "opencode/mimo-v2.6-flash-free")).model,
    ]) {
      // 逐条对应 LlmRuntime.normalizeModelInfo 的 INVALID_MODEL_REASONING 校验：
      // efforts 非空、id/name 非空、id 不重复、defaultEffort 若给出必须属于 efforts
      assert.ok(resolved.reasoning.efforts.length > 0, "efforts 不得为空数组");
      const ids = new Set();
      for (const e of resolved.reasoning.efforts) {
        assert.equal(typeof e.id, "string");
        assert.ok(e.id.length > 0);
        assert.equal(typeof e.name, "string");
        assert.ok(e.name.length > 0);
        assert.ok(!ids.has(e.id), `duplicate effort id: ${e.id}`);
        ids.add(e.id);
      }
      if (resolved.reasoning.defaultEffort !== undefined) {
        assert.ok(ids.has(resolved.reasoning.defaultEffort), "defaultEffort 必须属于 efforts");
      }
    }
    // 请求不带 effort 时不注入默认值（不设 defaultEffort）
    const resolved = await adapter.resolveModel("opencode-bridge", "opencode/mimo-v2.6-flash-free");
    assert.equal(resolved.reasoning.defaultEffort, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reasoningEffort -> opencode run --variant 透传；off/缺省不传（ISSUE-003 问题 2）", async () => {
  const mk = (over) => makeAdapter({
    cli: {
      command: process.execPath,
      extraArgs: [FAKE, "mode:variant-echo"],
      timeouts: { startupMs: 5000, firstEventMs: 5000, idleMs: 5000, totalMs: 15000, shutdownMs: 1000 },
    },
    ...over,
  });
  const run = async (reasoningEffort) => {
    const { dir, adapter } = mk();
    try {
      const chunks = [];
      for await (const c of adapter.stream({
        provider: "opencode-bridge",
        model: "opencode/mimo-v2.6-flash-free",
        messages: MESSAGES,
        reasoningEffort,
      })) chunks.push(c);
      return chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  assert.equal(await run("high"), "VARIANT=high");
  assert.equal(await run("medium"), "VARIANT=medium");
  assert.equal(await run("off"), "VARIANT=null");
  assert.equal(await run(undefined), "VARIANT=null");
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
      reasoningEffort: "medium",
    })) chunks.push(c);
    assert.ok(seen.start, "onRequestStart 应被调用");
    assert.ok(seen.start.prompt.includes("hello"), "start 应携带完整 prompt");
    assert.equal(seen.start.workspace, dir);
    assert.equal(seen.start.sessionId, "ses_dsh_1");
    assert.equal(seen.start.reasoningEffort, "medium", "取证应记录 reasoningEffort（实机注入判定依据）");
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

test("listModels 出口接模型筛选：默认隐藏 opencode-go/*，被过滤模型仍可宽松 resolve", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocbridge-filter-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ models: { exclude: ["opencode/gpt-5"] } }), "utf8");
  const catalog = [
    { id: "opencode/mimo-v2.6-flash-free", name: "MiMo" },
    { id: "opencode/gpt-5", name: "GPT-5" },
    { id: "opencode-go/big", name: "Go Big" },
  ];
  const { adapter } = makeAdapter({
    listModelEntries: createModelLister({ configPath, loadCatalog: async () => catalog }),
  });
  try {
    const models = await adapter.listModels("opencode-bridge");
    assert.deepEqual(models.map((m) => m.id), ["opencode/mimo-v2.6-flash-free"]);
    const hidden = await adapter.resolveModel("opencode-bridge", "opencode-go/big");
    assert.deepEqual({
      provider: hidden.provider,
      id: hidden.id,
      name: hidden.name,
      inputModalities: hidden.inputModalities,
    }, {
      provider: "opencode-bridge",
      id: "opencode-go/big",
      name: "opencode-go/big",
      inputModalities: ["text"],
    });
    assert.ok(hidden.reasoning.efforts.length > 0, "被过滤模型的宽松 resolve 也声明 reasoning 档位");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
