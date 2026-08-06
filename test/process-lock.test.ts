import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireServiceProcessLock } from "../src/server/process-lock.js";

test("allows only one service process per state directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = acquireServiceProcessLock(root);
  t.after(() => first.release());

  assert.throws(() => acquireServiceProcessLock(root), /already running/);
  first.release();

  const second = acquireServiceProcessLock(root);
  second.release();
});

test("replaces a stale service process lock", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-stale-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "service.lock"), JSON.stringify({
    pid: 2_147_483_647,
    startedAt: "2026-01-01T00:00:00.000Z"
  }));

  const lock = acquireServiceProcessLock(root);
  lock.release();
});

test("replaces a lock when its PID has been reused by another process", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-reused-pid-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "service.lock"), JSON.stringify({
    pid: 18096,
    startedAt: "2026-08-05T14:47:08.030Z"
  }));

  const lock = acquireServiceProcessLock(root, {
    pid: 32000,
    now: () => new Date("2026-08-06T00:20:00.000Z"),
    isProcessRunning: (pid) => pid === 18096,
    processStartedAt: (pid) => pid === 18096
      ? Date.parse("2026-08-06T00:17:16.000Z")
      : Date.parse("2026-08-06T00:19:59.000Z")
  });

  const record = JSON.parse(fs.readFileSync(lock.path, "utf8")) as { pid: number };
  assert.equal(record.pid, 32000);
  lock.release();
});
