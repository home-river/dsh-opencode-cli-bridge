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

test("apply 注册 opencode-bridge 路由并返回组合 disposer", () => {
  let registered = null;
  let adapterDisposed = 0;
  const fakeHandle = Object.assign(() => { adapterDisposed++; }, { replace: () => {} });
  const ctx = {
    llm: { registerAdapter: (providers, adapter) => { registered = { providers, adapter }; return fakeHandle; } },
    get: () => undefined,
  };
  const returned = apply(ctx);
  assert.deepEqual(registered.providers, ["opencode-bridge"]);
  assert.equal(typeof registered.adapter.stream, "function");
  assert.equal(typeof returned, "function", "apply 应返回 disposer");
  assert.equal(typeof returned.replace, "function", "replace 代理保留给 loader 热更新");
  returned();
  assert.equal(adapterDisposed, 1, "disposer 应连带注销 adapter 注册");
});

test("apply 经 connection.fetch 注册模型设置路由（inject 等待式）；disposer 注销；无 connection 时安静降级", () => {
  const routes = [];
  const unregistered = [];
  const conn = {
    fetch: { register: (route) => { routes.push(route); return () => { unregistered.push(route.path); }; } },
  };
  let injectedKeys = null;
  const ctx = {
    llm: { registerAdapter: () => () => {} },
    get: () => undefined,
    // cordis 等待式注入：本用例模拟「connection 已就绪」立即回调；
    // 实机上 apply 早于 connection 注册时，正是靠 inject 等到它（ctx.get 即时查询会错过）
    inject: (keys, cb) => {
      injectedKeys = keys;
      cb({ get: (key) => (key === "connection" ? conn : undefined) });
      return { dispose: () => {} };
    },
  };
  const returned = apply(ctx);
  assert.deepEqual(injectedKeys, ["connection"]);
  assert.deepEqual(routes.map((r) => r.path).sort(), ["/api/opencode-bridge.cli-status", "/api/opencode-bridge.filter", "/api/opencode-bridge.models"]);
  for (const r of routes) {
    assert.ok(r.methods.length > 0);
    assert.equal(r.requestBody, "buffered");
    assert.equal(typeof r.fetch, "function");
  }
  returned();
  assert.equal(unregistered.length, 3, "三条路由都应被注销");

  // 无 inject 且无 connection（如纯 host 组合）：不抛异常、apply 正常返回
  const bare = apply({ llm: { registerAdapter: () => () => {} }, get: () => undefined });
  assert.equal(typeof bare, "function");
  bare();
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

test("打包合同：package.json 声明 bundle patch + client 面，cordis.patch.yml 含插件行", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(pkg.dsh.client.platform, "web", "client 半区声明 platform:web 才会被装载");
  assert.equal(pkg.exports["./client"], "./lib/client.js");
  const patch = readFileSync(resolve(root, "cordis.patch.yml"), "utf8");
  assert.match(patch, /id:\s*llm-opencode-bridge/);

  // client 半区产物形态守卫：模块表注册 + id 等于包名 + 语法可编译
  const client = readFileSync(resolve(root, "lib", "client.js"), "utf8");
  assert.match(client, /window\.__ModuleLoader__\.load\(/);
  assert.ok(client.includes(`id: "${pkg.name}"`), "client 模块 id 必须等于包名");
  assert.doesNotThrow(() => new Function(client), "client.js 必须语法可编译");
  assert.match(patch, /name:\s*'dsh-opencode-cli-bridge'/);
});
