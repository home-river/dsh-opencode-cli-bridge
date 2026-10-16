import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TIMEOUTS, ZERO_USAGE } from "../../lib/types.js";

test("DEFAULT_TIMEOUTS 的值必须与 spec §8.1 实测结论一致", () => {
  assert.deepEqual(DEFAULT_TIMEOUTS, {
    startupMs: 30_000,
    firstEventMs: 45_000,
    idleMs: 300_000,
    totalMs: 600_000,
    shutdownMs: 3_000,
  });
});

test("ZERO_USAGE 全部为 0", () => {
  assert.deepEqual(ZERO_USAGE, {
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});
