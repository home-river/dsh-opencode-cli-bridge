import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, hashText } from "../../lib/session-store.js";

function tmp() { return mkdtempSync(join(tmpdir(), "ocbridge-sess-")); }

test("get/save/delete 往返", () => {
  const dir = tmp();
  try {
    const file = join(dir, "sessions.json");
    const store = new SessionStore(file);
    assert.equal(store.get("ses_dsh_1"), undefined);
    store.save({ dshSessionId: "ses_dsh_1", ocSessionId: "ses_oc_1", workspace: dir, sentCount: 3, systemHash: hashText("sys"), updatedAt: new Date().toISOString() });
    assert.equal(store.get("ses_dsh_1").ocSessionId, "ses_oc_1");
    // 重新打开（模拟进程重启）后仍可读
    const reopened = new SessionStore(file);
    assert.equal(reopened.get("ses_dsh_1").sentCount, 3);
    reopened.delete("ses_dsh_1");
    assert.equal(new SessionStore(file).get("ses_dsh_1"), undefined);
    assert.ok(existsSync(file));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("save 覆盖同 id 旧绑定（账本推进）", () => {
  const dir = tmp();
  try {
    const store = new SessionStore(join(dir, "sessions.json"));
    store.save({ dshSessionId: "a", ocSessionId: "oc", workspace: dir, sentCount: 1, systemHash: "", updatedAt: "" });
    store.save({ dshSessionId: "a", ocSessionId: "oc", workspace: dir, sentCount: 5, systemHash: "h", updatedAt: "" });
    assert.equal(store.get("a").sentCount, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("hashText 稳定且区分内容", () => {
  assert.equal(hashText("x"), hashText("x"));
  assert.notEqual(hashText("x"), hashText("y"));
});
