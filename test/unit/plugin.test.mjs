import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { name, inject, apply, resolveWorkspace } from "../../lib/plugin.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("导出合同：name/inject 形态正确", () => {
  assert.equal(name, "llm-opencode-bridge");
  assert.deepEqual(inject, ["llm"]);
});

test("apply 注册 opencode-bridge 路由并返回 disposer", () => {
  let registered = null;
  const fakeHandle = () => {};
  const ctx = {
    llm: { registerAdapter: (providers, adapter) => { registered = { providers, adapter }; return fakeHandle; } },
    get: () => undefined,
  };
  const returned = apply(ctx);
  assert.deepEqual(registered.providers, ["opencode-bridge"]);
  assert.equal(typeof registered.adapter.stream, "function");
  assert.equal(returned, fakeHandle);
});

test("resolveWorkspace：sessions cwd -> registry path -> process.cwd()", () => {
  const ctxSessions = {
    get: (id) => (id === "ses_1" ? { header: { cwd: "F:/project/A" } } : undefined),
  };
  const ctxRegistry = {
    list: () => [{ path: "F:/project/B", sessionIds: ["ses_2"] }],
  };
  assert.equal(resolveWorkspace({ get: (k) => (k === "sessions" ? ctxSessions : k === "workspaceRegistry" ? ctxRegistry : undefined) }, "ses_1"), "F:/project/A");
  assert.equal(resolveWorkspace({ get: (k) => (k === "sessions" ? ctxSessions : k === "workspaceRegistry" ? ctxRegistry : undefined) }, "ses_2"), "F:/project/B");
  assert.equal(resolveWorkspace({ get: () => undefined }, "ses_3"), process.cwd());
  assert.equal(resolveWorkspace({ get: () => undefined }, undefined), process.cwd());
});

test("打包合同：package.json 声明 bundle patch，cordis.patch.yml 含插件行", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  const patch = readFileSync(resolve(root, "cordis.patch.yml"), "utf8");
  assert.match(patch, /id:\s*llm-opencode-bridge/);
  assert.match(patch, /name:\s*'@home-river\/dsh-opencode-bridge'/);
});
