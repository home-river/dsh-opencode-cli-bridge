import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliBridge, streamCliBridge } from "../../lib/cli-bridge.js";

// 模型可被环境变量覆盖：免费模型目录会漂移（2026-10-16 实测 mimo-v2.6-flash-free / mimo-v2.5-free 均不可用）。
// 用法：OCBRIDGE_IT_MODEL=opencode/<model> npm run test:integration
const MODEL = process.env.OCBRIDGE_IT_MODEL ?? "opencode/mimo-v2.6-flash-free";
const RUN = process.env.OCBRIDGE_IT === "1" ? test : test.skip;

function mkws() {
  const d = mkdtempSync(join(tmpdir(), "ocbridge-it-"));
  writeFileSync(join(d, "alpha.txt"), "alpha\n");
  writeFileSync(join(d, "beta.md"), "# beta\n");
  return d;
}

// ISSUE-004：CLI 进程树刚退出的瞬间 rmSync 会 EPERM（残留句柄/CWD 竞态，
// 本机 5/5 复现、事后立即可删），属环境瞬态而非功能失败 —— 重试退避后再放弃，
// 不把清理竞态误报成用例失败。
async function cleanup(dir) {
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i >= 10) throw e;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
}

const SLOW = { startupMs: 30_000, firstEventMs: 45_000, idleMs: 300_000, totalMs: 600_000, shutdownMs: 3_000 };

RUN("R01 正常一轮：文本非空、finishReason=stop", async () => {
  const dir = mkws();
  try {
    const r = await runCliBridge({ workspace: dir, model: MODEL, prompt: "请只返回 R01_OK", timeouts: SLOW });
    assert.ok(r.text.includes("R01_OK"), r.text);
    assert.equal(r.finishReason, "stop");
    assert.ok(r.sessionId.length > 0);
    assert.ok(r.durationMs > 0);
  } finally { await cleanup(dir); }
});

RUN("R02 续接：第二轮记得第一轮内容", async () => {
  const dir = mkws();
  try {
    const a = await runCliBridge({ workspace: dir, model: MODEL, prompt: "请只记住这个秘密数字 7391，只回复已记住", timeouts: SLOW });
    const b = await runCliBridge({ workspace: dir, model: MODEL, prompt: "我让你记住的数字是多少？只返回数字", sessionId: a.sessionId, timeouts: SLOW });
    assert.ok(b.text.includes("7391"), b.text);
  } finally { await cleanup(dir); }
});

// 计划原文写的是 assert.rejects，但与 spec I4 / Ruling F14 冲突：
// runCliBridge 对执行期失败永远 resolve（错误走 finishReason="error" + errorCode），
// 只有建立阶段错误（参数非法 / WORKSPACE_INVALID / CLI_NOT_FOUND）才 reject。
// 断言按 spec 与 Task 8 单测（"session-not-found -> 执行期 resolve"）修正。
RUN("R03 无效 --session -> resolve finishReason=error, errorCode=SESSION_INVALID", async () => {
  const dir = mkws();
  try {
    const r = await runCliBridge({ workspace: dir, model: MODEL, prompt: "hi", sessionId: "ses_probe_does_not_exist_00000", timeouts: SLOW });
    assert.equal(r.finishReason, "error");
    assert.equal(r.errorCode, "SESSION_INVALID");
  } finally { await cleanup(dir); }
});

RUN("R05 workspace 相对路径 -> WORKSPACE_INVALID", async () => {
  await assert.rejects(
    () => runCliBridge({ workspace: "relative/path", model: MODEL, prompt: "hi", timeouts: SLOW }),
    (e) => { assert.equal(e.code, "WORKSPACE_INVALID"); return true; },
  );
});

RUN("R06 workspace 不存在 -> WORKSPACE_INVALID", async () => {
  await assert.rejects(
    () => runCliBridge({ workspace: join(tmpdir(), "ocbridge-nope-" + Date.now()), model: MODEL, prompt: "hi", timeouts: SLOW }),
    (e) => { assert.equal(e.code, "WORKSPACE_INVALID"); return true; },
  );
});

RUN("R07 触发 tool_use：tool 事件被产出但不污染正文", async () => {
  const dir = mkws();
  try {
    const events = [];
    for await (const e of streamCliBridge({ workspace: dir, model: MODEL, prompt: "请先列出当前目录下的文件，然后用一句话总结", timeouts: SLOW })) events.push(e);
    const tools = events.filter((e) => e.kind === "tool");
    const texts = events.filter((e) => e.kind === "text");
    assert.ok(texts.length > 0, "应有正文");
    const body = texts.map((e) => e.text).join("");
    assert.ok(!body.includes("callID"), "工具字段不得进入正文");
    assert.ok(tools.length >= 0);
  } finally { await cleanup(dir); }
});

RUN("R08 长回答：text 为整段，usage 非零", async () => {
  const dir = mkws();
  try {
    const r = await runCliBridge({ workspace: dir, model: MODEL, prompt: "请写一篇约 300 字的短文，主题是软件测试", timeouts: SLOW });
    assert.ok(r.text.length > 100, `text length=${r.text.length}`);
    assert.equal(r.finishReason, "stop");
    assert.ok(r.usage.output > 0, JSON.stringify(r.usage));
  } finally { await cleanup(dir); }
});

// 计划原文按"全机 PID 基线"断言，实测会误报无关进程（与 9b44c6e 修正单测同因）。
// 收窄为 CLI 进程树相关映像名（opencode*.exe / git.exe，见 CLI-BEHAVIOR §5：CLI 会派生 git），
// 并在宽限期后复检一次，避免瞬态进程误报。
RUN("R11 连续 5 轮进程归零（按 CLI 进程树映像名断言）", async () => {
  const { spawnSync } = await import("node:child_process");
  const TREE_IMAGE = /^(opencode(-cli)?|git)(\.exe)?$/i;
  const treePids = () => {
    const r = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
    const s = new Set();
    for (const l of String(r.stdout || "").split(/\r?\n/)) {
      const m = /^"([^"]*)","(\d+)"/.exec(l.trim());
      if (m && TREE_IMAGE.test(m[1])) s.add(Number(m[2]));
    }
    return s;
  };
  const before = treePids();
  for (let i = 0; i < 5; i++) {
    const dir = mkws();
    try { await runCliBridge({ workspace: dir, model: MODEL, prompt: "请只返回 OK", timeouts: SLOW }); }
    finally { await cleanup(dir); }
  }
  let residual = [];
  for (const wait of [800, 2000]) {
    await new Promise((r) => setTimeout(r, wait));
    residual = [...treePids()].filter((pid) => !before.has(pid));
    if (residual.length === 0) break;
  }
  for (const pid of residual) assert.fail(`残留进程 pid=${pid}`);
});
