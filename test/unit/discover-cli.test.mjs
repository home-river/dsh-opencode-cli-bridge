import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverOpencodeCli, resolveShimTarget } from "../../lib/discover-cli.js";

function makeFakeInstall(root) {
  // 模拟 npm 全局布局：<root>/npm/opencode.cmd + <root>/npm/node_modules/opencode-ai/bin/opencode.exe
  const npmDir = join(root, "npm");
  mkdirSync(join(npmDir, "node_modules", "opencode-ai", "bin"), { recursive: true });
  writeFileSync(join(npmDir, "opencode.cmd"), '@ECHO off\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n');
  writeFileSync(join(npmDir, "opencode"), '#!/bin/sh\nexec "$basedir/node_modules/opencode-ai/bin/opencode.exe"   "$@"\n');
  writeFileSync(join(npmDir, "node_modules", "opencode-ai", "bin", "opencode.exe"), "MZ fake binary");
  return npmDir;
}

test("显式 command 优先级最高", async () => {
  const r = await discoverOpencodeCli({ command: "C:/custom/opencode.exe" });
  assert.equal(r.command, "C:/custom/opencode.exe");
  assert.equal(r.source, "explicit");
});

test("PATH 上命中 .cmd shim 时解析出真身 exe，不用 .cmd 本身", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-"));
  try {
    const npmDir = makeFakeInstall(root);
    const r = await discoverOpencodeCli({ env: { PATH: npmDir } });
    assert.equal(r.source, "shim-resolved");
    assert.ok(r.command.endsWith("opencode.exe"), r.command);
    assert.ok(!r.command.endsWith(".cmd"), r.command);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PATH 上命中 .exe 时直接使用", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-"));
  try {
    const dir = join(root, "bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode.exe"), "MZ");
    const r = await discoverOpencodeCli({ env: { PATH: dir } });
    assert.equal(r.source, "path");
    assert.ok(r.command.endsWith("opencode.exe"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("回退到 npm 全局布局", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-"));
  try {
    makeFakeInstall(root);
    const r = await discoverOpencodeCli({ env: { PATH: "", APPDATA: root } });
    assert.equal(r.source, "npm-global");
    assert.ok(r.command.endsWith("opencode.exe"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("全部失败 -> CLI_NOT_FOUND，消息含安装提示", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-"));
  try {
    await assert.rejects(
      () => discoverOpencodeCli({ env: { PATH: "", APPDATA: root } }),
      (e) => {
        assert.equal(e.code, "CLI_NOT_FOUND");
        assert.match(e.message, /opencode-ai/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveShimTarget: 从 .cmd 内容里解析出 exe 绝对路径", () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-"));
  try {
    const npmDir = makeFakeInstall(root);
    const target = resolveShimTarget(join(npmDir, "opencode.cmd"));
    assert.ok(target.endsWith("opencode.exe"), String(target));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveShimTarget: 不是 shim 时返回 null", () => {
  assert.equal(resolveShimTarget("C:/nowhere/opencode.exe"), null);
});

test("显式 command 非绝对路径 -> CLI_NOT_FOUND（编程错误，不让它静默落到 PATH 查找）", async () => {
  await assert.rejects(
    () => discoverOpencodeCli({ command: "opencode.exe" }),
    (e) => { assert.equal(e.code, "CLI_NOT_FOUND"); return true; },
  );
});
