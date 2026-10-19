import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCliStatus,
  probeVersion,
  buildCliStatusRoute,
  CLI_STATUS_ROUTE_PATH,
} from "../../lib/cli-status.js";

const NODE = process.execPath; // 绝对路径，天然走 discover-cli 的 explicit 通道

test("probeVersion: 真实可执行文件取版本（node --version）", async () => {
  const r = await probeVersion(NODE, { args: ["--version"] });
  assert.equal(r.ok, true);
  assert.match(r.version, /^v?\d+\.\d+\.\d+/);
});

test("probeVersion: 进程超时 -> ok:false + 超时错误，且子进程被杀", async () => {
  const started = Date.now();
  const r = await probeVersion(NODE, { args: ["-e", "setTimeout(()=>{}, 10000)"], timeoutMs: 250 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timeout/i);
  assert.ok(Date.now() - started < 5000, "超时应按 timeoutMs 生效，不应等满挂起脚本");
});

test("probeVersion: 进程非零退出 -> ok:false + exit 信息", async () => {
  const r = await probeVersion(NODE, { args: ["-e", "process.exit(3)"] });
  assert.equal(r.ok, false);
  assert.match(r.error, /exit/i);
});

test("probeVersion: 不可执行的假 exe -> ok:false（spawn 失败降级，不抛异常）", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-status-"));
  try {
    const junk = join(root, "junk.exe");
    writeFileSync(junk, "MZ fake binary");
    const r = await probeVersion(junk);
    assert.equal(r.ok, false);
    assert.ok(r.error.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkCliStatus: 命中 CLI 并取到版本", async () => {
  const report = await checkCliStatus({ command: NODE });
  assert.equal(report.found, true);
  assert.equal(report.command, NODE);
  assert.equal(report.source, "explicit");
  assert.match(report.version, /^v?\d+\.\d+\.\d+/);
  assert.equal(report.versionError, null);
  assert.ok(report.install.downloadUrl.startsWith("https://"));
});

test("checkCliStatus: PATH 命中假 exe -> found + source path + 版本探测失败降级", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-status-"));
  try {
    writeFileSync(join(root, "opencode.exe"), "MZ fake binary");
    const report = await checkCliStatus({ env: { PATH: root, APPDATA: join(root, "nope") } });
    assert.equal(report.found, true);
    assert.equal(report.source, "path");
    assert.equal(report.version, null);
    assert.ok(report.versionError, "版本探测失败要如实上报，不能装作没事");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkCliStatus: 未找到 -> found:false + 安装建议", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-status-"));
  try {
    const report = await checkCliStatus({
      env: { PATH: "", APPDATA: join(root, "nope"), HOME: root, USERPROFILE: root },
    });
    assert.equal(report.found, false);
    assert.equal(report.command, null);
    assert.equal(report.source, null);
    assert.equal(report.version, null);
    assert.equal(report.versionError, null);
    assert.match(report.install.command, /opencode-ai/);
    assert.equal(report.install.manager, "none");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildCliStatusRoute: GET 返回 {ok,value} 信封的 CLI 状态", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-status-"));
  try {
    const route = buildCliStatusRoute({
      env: { PATH: "", APPDATA: join(root, "nope"), HOME: root, USERPROFILE: root },
    });
    assert.equal(route.path, CLI_STATUS_ROUTE_PATH);
    assert.deepEqual(route.methods, ["GET", "POST"]);
    assert.equal(route.requestBody, "buffered");
    const res = await route.fetch(new Request(`http://localhost${CLI_STATUS_ROUTE_PATH}`));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.value.found, false);
    assert.ok(body.value.install.command.includes("opencode-ai"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
