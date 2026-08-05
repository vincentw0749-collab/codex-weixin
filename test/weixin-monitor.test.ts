import assert from "node:assert/strict";
import test from "node:test";

import { monitorWeixin } from "../src/weixin/monitor.js";
import type { WeixinApiClient } from "../src/weixin/api.js";

test("continues polling after a getUpdates failure", async (t) => {
  t.mock.method(console, "error", () => {});
  const controller = new AbortController();
  let polls = 0;
  const client = {
    async getUpdates() {
      polls += 1;
      if (polls === 1) {
        throw new Error("temporary poll failure");
      }
      controller.abort();
      return { msgs: [] };
    }
  } as WeixinApiClient;

  await monitorWeixin({
    client,
    signal: controller.signal,
    pollIntervalMs: 0,
    async onMessage() {}
  });

  assert.equal(polls, 2);
});

test("continues polling after a malformed getUpdates response", async (t) => {
  t.mock.method(console, "error", () => {});
  const controller = new AbortController();
  let polls = 0;
  const client = {
    async getUpdates() {
      polls += 1;
      if (polls === 1) {
        return { msgs: {} };
      }
      controller.abort();
      return { msgs: [] };
    }
  } as WeixinApiClient;

  await monitorWeixin({
    client,
    signal: controller.signal,
    pollIntervalMs: 0,
    async onMessage() {}
  });

  assert.equal(polls, 2);
});

test("stops immediately when polling aborts before the retry delay", async (t) => {
  t.mock.method(console, "error", () => {});
  const controller = new AbortController();
  const client = {
    async getUpdates() {
      controller.abort();
      throw new Error("poll interrupted");
    }
  } as WeixinApiClient;
  const startedAt = Date.now();

  await monitorWeixin({
    client,
    signal: controller.signal,
    pollIntervalMs: 250,
    async onMessage() {}
  });

  assert.ok(Date.now() - startedAt < 150);
});

test("continues with the remaining batch after one message fails", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const controller = new AbortController();
  let polls = 0;
  const handled: string[] = [];
  const failures: string[] = [];
  const client = {
    async getUpdates() {
      polls += 1;
      if (polls === 1) {
        return {
          msgs: [
            { message_id: "first", from_user_id: "alice", text: "one" },
            { message_id: "second", from_user_id: "alice", text: "two" }
          ]
        };
      }
      controller.abort();
      return { msgs: [] };
    }
  } as WeixinApiClient;

  await monitorWeixin({
    client,
    signal: controller.signal,
    pollIntervalMs: 0,
    async onMessage(message) {
      handled.push(message.id);
      if (message.id === "first") {
        throw new Error("message failed");
      }
    },
    async onMessageError(error, message) {
      failures.push(`${message.id}:${error instanceof Error ? error.message : String(error)}`);
    }
  });

  assert.deepEqual(handled, ["first", "second"]);
  assert.deepEqual(failures, ["first:message failed"]);
});

test("dispatches /stop while an earlier message from the same batch is still active", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const controller = new AbortController();
  let polls = 0;
  let releaseTask!: () => void;
  const taskGate = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  let taskActive = false;
  let stopObservedActiveTask = false;
  const failsafe = setTimeout(releaseTask, 500);
  t.after(() => clearTimeout(failsafe));

  const client = {
    async getUpdates() {
      polls += 1;
      if (polls === 1) {
        return {
          msgs: [
            { message_id: "task", from_user_id: "alice", text: "long task" },
            { message_id: "stop", from_user_id: "alice", text: "/stop" }
          ]
        };
      }
      controller.abort();
      return { msgs: [] };
    }
  } as WeixinApiClient;

  await monitorWeixin({
    client,
    signal: controller.signal,
    pollIntervalMs: 0,
    async onMessage(message) {
      if (message.id === "task") {
        taskActive = true;
        await taskGate;
        taskActive = false;
        return;
      }
      stopObservedActiveTask = taskActive;
      releaseTask();
    }
  });

  assert.equal(stopObservedActiveTask, true);
});

test("dispatches /api while an earlier message from the same sender is still active", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const controller = new AbortController();
  let polls = 0;
  let releaseTask!: () => void;
  const taskGate = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  let taskActive = false;
  let apiObservedActiveTask = false;
  const failsafe = setTimeout(releaseTask, 500);
  t.after(() => clearTimeout(failsafe));

  const client = {
    async getUpdates() {
      polls += 1;
      if (polls === 1) {
        return {
          msgs: [
            { message_id: "task", from_user_id: "alice", text: "long task" },
            { message_id: "api", from_user_id: "alice", text: "/api use 2" }
          ]
        };
      }
      controller.abort();
      return { msgs: [] };
    }
  } as WeixinApiClient;

  await monitorWeixin({
    client,
    signal: controller.signal,
    pollIntervalMs: 0,
    async onMessage(message) {
      if (message.id === "task") {
        taskActive = true;
        await taskGate;
        taskActive = false;
        return;
      }
      apiObservedActiveTask = taskActive;
      releaseTask();
    }
  });

  assert.equal(apiObservedActiveTask, true);
});

test("skips duplicate message ids and persists the latest sync key", async (t) => {
  t.mock.method(console, "log", () => {});
  const controller = new AbortController();
  const claimed = new Set<string>();
  const handled: string[] = [];
  const syncKeys: string[] = [];
  let polls = 0;
  const client = {
    async getUpdates(syncKey?: string) {
      polls += 1;
      if (polls === 1) {
        assert.equal(syncKey, "sync-start");
        return {
          get_updates_buf: "sync-next",
          msgs: [
            { message_id: "duplicate", from_user_id: "alice", text: "hello" },
            { message_id: "duplicate", from_user_id: "alice", text: "hello" }
          ]
        };
      }
      controller.abort();
      return { get_updates_buf: "sync-final", msgs: [] };
    }
  } as WeixinApiClient;

  await monitorWeixin({
    client,
    signal: controller.signal,
    pollIntervalMs: 0,
    initialSyncKey: "sync-start",
    claimMessage(message) {
      if (claimed.has(message.id)) return false;
      claimed.add(message.id);
      return true;
    },
    onSyncKey(syncKey) {
      syncKeys.push(syncKey);
    },
    async onMessage(message) {
      handled.push(message.id);
    }
  });

  assert.deepEqual(handled, ["duplicate"]);
  assert.deepEqual(syncKeys, ["sync-next", "sync-final"]);
});
