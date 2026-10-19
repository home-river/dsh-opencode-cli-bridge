import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectInstallAdvice,
  NPM_INSTALL_COMMAND,
  DOWNLOAD_URL,
} from "../../lib/install-advice.js";

/** 在临时目录里造一个"PATH 命中"的假包管理器可执行文件。 */
function makeManagerDir(root, fileName) {
  const dir = join(root, fileName.replace(/\..*$/, ""));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), `@ECHO off\r\nfake ${fileName}\r\n`);
  return dir;
}

test("detectInstallAdvice: PATH 命中 npm -> 推荐 npm 命令", () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-advice-"));
  try {
    const dir = makeManagerDir(root, "npm.cmd");
    const advice = detectInstallAdvice({ PATH: dir });
    assert.equal(advice.manager, "npm");
    assert.equal(advice.command, NPM_INSTALL_COMMAND);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectInstallAdvice: 无 npm 有 scoop -> 推荐 scoop 命令", () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-advice-"));
  try {
    const dir = makeManagerDir(root, "scoop.cmd");
    const advice = detectInstallAdvice({ PATH: dir });
    assert.equal(advice.manager, "scoop");
    assert.equal(advice.command, "scoop install opencode");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectInstallAdvice: 仅 choco -> 推荐 choco 命令", () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-advice-"));
  try {
    const dir = makeManagerDir(root, "choco.exe");
    const advice = detectInstallAdvice({ PATH: dir });
    assert.equal(advice.manager, "choco");
    assert.equal(advice.command, "choco install opencode");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectInstallAdvice: npm 优先于 scoop/choco", () => {
  const root = mkdtempSync(join(tmpdir(), "ocbridge-advice-"));
  try {
    const dir = join(root, "bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "npm.cmd"), "fake");
    writeFileSync(join(dir, "scoop.cmd"), "fake");
    writeFileSync(join(dir, "choco.exe"), "fake");
    const advice = detectInstallAdvice({ PATH: dir });
    assert.equal(advice.manager, "npm");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectInstallAdvice: 全无包管理器 -> manager none + npm 兜底命令", () => {
  const advice = detectInstallAdvice({ PATH: "" });
  assert.equal(advice.manager, "none");
  assert.equal(advice.command, NPM_INSTALL_COMMAND);
});

test("detectInstallAdvice: 恒带 GitHub Releases 手动下载链接", () => {
  for (const env of [{ PATH: "" }, { PATH: "" }, { PATH: "C:\\nonexistent-dir" }]) {
    const advice = detectInstallAdvice(env);
    assert.equal(advice.downloadUrl, DOWNLOAD_URL);
    assert.match(advice.downloadUrl, /^https:\/\//);
  }
});

test("安装命令口径：npm 命令含包名 opencode-ai", () => {
  assert.match(NPM_INSTALL_COMMAND, /opencode-ai/);
});
