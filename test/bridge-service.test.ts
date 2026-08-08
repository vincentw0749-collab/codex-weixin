import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BridgeService } from "../src/bridge/service.js";
import { buildPrompt, MISSING_FINAL_REPORT_FALLBACK } from "../src/bridge/format.js";
import { defaultConfig, MAX_INBOUND_BYTES } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { encryptAesEcb } from "../src/weixin/media.js";
import { normalizeWeixinMessage } from "../src/weixin/messages.js";

test("stops a task before the runner starts and sends no residual reply", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-stop-before-run-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  let runCalled = false;
  let stopCalled = false;
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"]
    },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run() {
        runCalled = true;
        return { raw: "", text: "must not be sent" };
      },
      async stop() {
        stopCalled = true;
      }
    } as never
  });

  const task = service.handleMessage({
    id: "task",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "long task",
    raw: {}
  });
  await service.handleMessage({
    id: "stop",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/stop",
    raw: {}
  });
  await task;

  assert.equal(stopCalled, true);
  assert.equal(runCalled, false);
  assert.deepEqual(replies, ["Current task stopped."]);
});

test("waits for a pending runtime switch before starting a new Codex turn", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-runtime-gate-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  let releaseRuntime!: () => void;
  let runCalled = false;
  const runtimeReady = new Promise<void>((resolve) => {
    releaseRuntime = resolve;
  });
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"]
    },
    stateStore,
    waitForRuntimeReady: () => runtimeReady,
    weixin: {
      async sendTyping() {},
      async sendText() {
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run() {
        runCalled = true;
        return { raw: "", text: "completed", threadId: "thread-runtime-gate" };
      },
      async stop() {}
    } as never
  });

  const pending = service.handleMessage({
    id: "runtime-gate-message",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "start after the switch",
    raw: {}
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runCalled, false);

  releaseRuntime();
  await pending;
  assert.equal(runCalled, true);
});

test("keeps buffered prompt submission behind a pending runtime switch", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-buffer-runtime-gate-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  let releaseRuntime!: () => void;
  const runtimeReady = new Promise<void>((resolve) => {
    releaseRuntime = resolve;
  });
  let oldRunnerRuns = 0;
  let newRunnerRuns = 0;
  const config = {
    ...defaultConfig(tmpDir),
    allowedSenderIds: ["alice@im.wechat"]
  };
  const service = new BridgeService({
    config,
    stateStore,
    waitForRuntimeReady: () => runtimeReady,
    weixin: {
      async sendTyping() {},
      async sendText() {
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run() {
        oldRunnerRuns += 1;
        return { raw: "", text: "old runner response" };
      },
      async stop() {}
    } as never
  });

  await service.handleMessage({
    id: "buffer-start",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/prompt start",
    raw: {}
  });
  await service.handleMessage({
    id: "buffer-item",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "run after API switch",
    raw: {}
  });

  const done = service.handleMessage({
    id: "buffer-done",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/prompt done",
    raw: {}
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(oldRunnerRuns, 0);

  service.replaceRuntime({
    async run() {
      newRunnerRuns += 1;
      return { raw: "", text: "new runner response" };
    },
    async stop() {}
  } as never, config);
  releaseRuntime();
  await done;

  assert.equal(oldRunnerRuns, 0);
  assert.equal(newRunnerRuns, 1);
});

test("interrupts an active runner and suppresses its cancellation error", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-stop-active-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  let releaseRun!: () => void;
  let signalRunStarted!: () => void;
  const runStarted = new Promise<void>((resolve) => {
    signalRunStarted = resolve;
  });
  const runGate = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"]
    },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run() {
        signalRunStarted();
        await runGate;
        throw new Error("Codex turn was interrupted");
      },
      async stop() {
        releaseRun();
      }
    } as never
  });

  const task = service.handleMessage({
    id: "task",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "long task",
    raw: {}
  });
  await runStarted;
  await service.handleMessage({
    id: "stop",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/stop",
    raw: {}
  });
  await task;

  assert.deepEqual(replies, ["Current task stopped."]);
});

test("sends a terminal notice when an API switch interrupts an active task", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-api-interrupt-notice-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  let releaseRun!: () => void;
  let signalRunStarted!: () => void;
  const runStarted = new Promise<void>((resolve) => {
    signalRunStarted = resolve;
  });
  const runGate = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run() {
        signalRunStarted();
        await runGate;
        throw new Error("Codex turn was interrupted");
      },
      async stop() {
        releaseRun();
      }
    } as never
  });

  const task = service.handleMessage({
    id: "task",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "long task",
    raw: {}
  });
  await runStarted;

  const stopped = await service.cancelActiveTurns("当前任务已因确认的 API 切换而结束。");
  await task;

  assert.equal(stopped, 1);
  assert.deepEqual(replies, ["当前任务已因确认的 API 切换而结束。"]);
});

test("sends API switch terminal notice before a stuck runner stop", { timeout: 1_000 }, async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-api-stuck-stop-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  let releaseRun!: () => void;
  let signalRunStarted!: () => void;
  let repliesWhenStopStarted: string[] | undefined;
  const runStarted = new Promise<void>((resolve) => {
    signalRunStarted = resolve;
  });
  const runGate = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const neverStops = new Promise<void>(() => {});
  const notice = "当前任务已因确认的 API 切换而结束。";
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run() {
        signalRunStarted();
        await runGate;
        return { raw: "", text: "must not be sent" };
      },
      async stop() {
        repliesWhenStopStarted = [...replies];
        return neverStops;
      }
    } as never
  });

  const task = service.handleMessage({
    id: "task",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "long task",
    raw: {}
  });
  await runStarted;

  let stopped: number | undefined;
  let cancellationError: unknown;
  try {
    stopped = await Promise.race([
      service.cancelActiveTurns(notice),
      new Promise<number>((_resolve, reject) => {
        setTimeout(() => reject(new Error("cancelActiveTurns waited for runner.stop")), 50);
      })
    ]);
  } catch (error) {
    cancellationError = error;
  }
  releaseRun();
  await task;

  assert.ifError(cancellationError);
  assert.equal(stopped, 1);
  assert.deepEqual(replies, [notice]);
  assert.deepEqual(repliesWhenStopStarted, [notice]);
  assert.equal(service.getActiveTaskCount(), 0);
});

test("stops the retiring runner after an API switch notification is delayed", { timeout: 1_000 }, async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-api-retiring-runner-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const notice = "当前任务已因确认的 API 切换而结束。";
  let releaseRun: (() => void) | undefined;
  let releaseNotice: (() => void) | undefined;
  t.after(() => {
    releaseNotice?.();
    releaseRun?.();
  });
  let signalRunStarted!: () => void;
  let signalNoticeStarted!: () => void;
  let oldRunnerStops = 0;
  let newRunnerStops = 0;
  const runStarted = new Promise<void>((resolve) => {
    signalRunStarted = resolve;
  });
  const runGate = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  const noticeStarted = new Promise<void>((resolve) => {
    signalNoticeStarted = resolve;
  });
  const noticeGate = new Promise<void>((resolve) => {
    releaseNotice = resolve;
  });
  const config = { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] };
  const service = new BridgeService({
    config,
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText() {
        signalNoticeStarted();
        await noticeGate;
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run() {
        signalRunStarted();
        await runGate;
        return { raw: "", text: "must not be sent" };
      },
      async stop() {
        oldRunnerStops += 1;
      }
    } as never
  });

  const task = service.handleMessage({
    id: "task",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "long task",
    raw: {}
  });
  await runStarted;

  const cancellation = service.cancelActiveTurns(notice);
  await noticeStarted;
  service.replaceRuntime({
    async run() {
      return { raw: "", text: "unexpected" };
    },
    async stop() {
      newRunnerStops += 1;
    }
  } as never, config);
  releaseNotice?.();
  await cancellation;

  assert.equal(oldRunnerStops, 1);
  assert.equal(newRunnerStops, 0);

  releaseRun?.();
  await task;
});

test("reports WeChat Codex turn status and resolves runtime details for status", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-status-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const statuses: Array<{ senderId: string; sessionId: string; active: boolean }> = [];
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"],
      codexBackend: "auto"
    },
    stateStore,
    onTurnStatus: (status) => statuses.push(status),
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run() {
        return { raw: "", text: "完成", threadId: "thread-status" };
      },
      async getRuntimeInfo() {
        return { model: "gpt-test", effort: "high" };
      },
      async stop() {}
    } as never
  });

  await service.handleMessage({
    id: "turn",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "开始",
    raw: {}
  });
  const sessionId = stateStore.getActiveSession("alice@im.wechat")?.id;
  assert.deepEqual(statuses, [
    { senderId: "alice@im.wechat", sessionId, active: true },
    { senderId: "alice@im.wechat", sessionId, active: false }
  ]);

  await service.handleMessage({
    id: "status",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/status",
    raw: {}
  });
  assert.match(replies.at(-1) ?? "", /model: gpt-test/);
  assert.match(replies.at(-1) ?? "", /effort: high/);
});

test("lists API profiles and includes API commands in help and status", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-api-list-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const profiles = [
    {
      id: "primary",
      name: "公司api",
      baseUrl: "https://one.example/v1",
      model: "model-one",
      effort: "medium",
      hasApiKey: true,
      active: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    {
      id: "backup",
      name: "备用API",
      baseUrl: "https://two.example/v1",
      model: "model-two",
      effort: "max",
      hasApiKey: true,
      active: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  ];
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    apiProfiles: {
      list: () => profiles,
      listForDisplay: async () => profiles.map((profile, index) => ({
        ...profile,
        apiKeyLastFour: index === 0 ? "1234" : "5678"
      })),
      getActive: () => profiles[0],
      async setDefaults() { return profiles[0]; },
      async createVerified() { throw new Error("not used"); },
      async test() { return { ok: true as const, latencyMs: 1 }; },
      async activate() { return profiles[0]; }
    },
    runner: {
      async run() { return { raw: "", text: "unexpected" }; },
      async getRuntimeInfo() { return { model: "model-one", effort: "high" }; },
      async stop() {}
    } as never
  });
  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  await send("api-list", "/api");
  assert.match(replies.at(-1) ?? "", /1\. 【当前使用】\n名称：公司api\nURL：https:\/\/one\.example\/v1\nAPI 密钥后四位：1234/);
  assert.match(replies.at(-1) ?? "", /2\. 【已保存】\n名称：备用API\nURL：https:\/\/two\.example\/v1\nAPI 密钥后四位：5678/);
  assert.doesNotMatch(replies.at(-1) ?? "", /model-one|model-two/);

  await send("status", "/status");
  assert.match(replies.at(-1) ?? "", /api: 公司api/);
  assert.match(replies.at(-1) ?? "", /model: model-one/);
  assert.match(replies.at(-1) ?? "", /effort: high/);

  await send("help", "/help");
  assert.match(replies.at(-1) ?? "", /\/api add/);
  assert.match(replies.at(-1) ?? "", /\/1/);
  assert.match(replies.at(-1) ?? "", /\/2/);
  await send("unknown", "/does-not-exist");
  assert.match(replies.at(-1) ?? "", /\/help/);
});

test("captures the next message as an API key and saves only after verification", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-api-add-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const profiles = [{
    id: "primary",
    name: "Primary",
    baseUrl: "https://one.example/v1",
    model: "model-one",
    effort: "medium",
    hasApiKey: true,
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  }];
  let runnerCalls = 0;
  let capturedKey = "";
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    apiProfiles: {
      list: () => profiles,
      listForDisplay: async () => profiles.map((profile) => ({ ...profile, apiKeyLastFour: "test" })),
      getActive: () => profiles.find((profile) => profile.active),
      async setDefaults() { return profiles[0]; },
      async createVerified(input) {
        capturedKey = input.apiKey;
        const profile = {
          id: "backup",
          name: input.name,
          baseUrl: input.baseUrl,
          model: input.model,
          effort: input.effort ?? "medium",
          hasApiKey: true,
          active: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        };
        profiles.push(profile);
        return { profile, ok: true as const, latencyMs: 25 };
      },
      async test() { return { ok: true as const, latencyMs: 1 }; },
      async activate() { throw new Error("not used"); }
    },
    runner: {
      async run() {
        runnerCalls += 1;
        return { raw: "", text: "unexpected" };
      },
      async stop() {}
    } as never
  });
  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  await send("add", "/api add Backup https://two.example/v1 model-two");
  await send("key", "sk-super-secret-value");

  assert.equal(capturedKey, "sk-super-secret-value");
  assert.equal(runnerCalls, 0);
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.lastPromptPreview, undefined);
  assert.equal(profiles[0].active, true);
  assert.equal(profiles[1].active, false);
  assert.equal(replies.some((reply) => reply.includes("sk-super-secret-value")), false);
  assert.match(replies.at(-1) ?? "", /当前 API 未改变/);
});

test("ends API key capture after failed verification and reports the actual probe", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-api-add-failure-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const profiles = [{
    id: "primary",
    name: "Primary",
    baseUrl: "https://one.example/v1",
    model: "model-one",
    effort: "medium",
    hasApiKey: true,
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  }];
  let verificationCalls = 0;
  let runnerCalls = 0;
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    apiProfiles: {
      list: () => profiles,
      listForDisplay: async () => profiles.map((profile) => ({ ...profile, apiKeyLastFour: "test" })),
      getActive: () => profiles[0],
      async setDefaults() { return profiles[0]; },
      async createVerified() {
        verificationCalls += 1;
        throw new Error("API service is temporarily unavailable (503)");
      },
      async test() { return { ok: true as const, latencyMs: 1 }; },
      async activate() { return profiles[0]; }
    },
    runner: {
      async run() {
        runnerCalls += 1;
        return { raw: "", text: "normal reply" };
      },
      async stop() {}
    } as never
  });
  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  await send("add", "/api add Backup https://two.example/v1 model-two");
  await send("key", "sk-super-secret-value");
  const failureReply = replies.at(-1) ?? "";
  await send("question", "为什么一直失败？");

  assert.equal(verificationCalls, 1);
  assert.equal(runnerCalls, 1);
  assert.match(failureReply, /已连接到 API 地址.*HTTP 503/);
  assert.match(failureReply, /验证地址：https:\/\/two\.example\/v1\/responses/);
  assert.match(failureReply, /验证模型：model-two/);
  assert.match(failureReply, /本次添加流程已结束/);
  assert.doesNotMatch(failureReply, /sk-super-secret-value/);
  assert.equal(replies.at(-1), "normal reply");
});

test("defers API activation until the command has returned", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-api-use-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const profiles = [
    { id: "one", name: "Primary", baseUrl: "https://one.example/v1", model: "one", effort: "medium", hasApiKey: true, active: true, createdAt: "x", updatedAt: "x" },
    { id: "two", name: "Backup", baseUrl: "https://two.example/v1", model: "two", effort: "max", hasApiKey: true, active: false, createdAt: "x", updatedAt: "x" }
  ];
  let deferred: (() => Promise<void>) | undefined;
  let activated = false;
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    deferTask: (task) => { deferred = task; },
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    apiProfiles: {
      list: () => profiles,
      listForDisplay: async () => profiles.map((profile) => ({ ...profile, apiKeyLastFour: "test" })),
      getActive: () => profiles.find((profile) => profile.active),
      async setDefaults() { return profiles[0]; },
      async createVerified() { throw new Error("not used"); },
      async test() { return { ok: true as const, latencyMs: 1 }; },
      async activate(id) {
        activated = true;
        for (const profile of profiles) profile.active = profile.id === id;
        return profiles[1];
      }
    },
    runner: { async run() { return { raw: "", text: "unexpected" }; }, async stop() {} } as never
  });

  await service.handleMessage({
    id: "use",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/api 2",
    raw: {}
  });

  assert.equal(activated, false);
  assert.ok(deferred);
  await deferred();
  assert.equal(activated, true);
  assert.match(replies.at(-1) ?? "", /API 已切换为“Backup”/);
  assert.match(replies.at(-1) ?? "", /推理强度：max/);
});

test("asks for confirmation before an API switch interrupts active tasks", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-api-force-confirm-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const profiles = [
    { id: "one", name: "Primary", baseUrl: "https://one.example/v1", model: "one", effort: "medium", hasApiKey: true, active: true, createdAt: "x", updatedAt: "x" },
    { id: "two", name: "Backup", baseUrl: "https://two.example/v1", model: "two", effort: "max", hasApiKey: true, active: false, createdAt: "x", updatedAt: "x" }
  ];
  let deferred: (() => Promise<void>) | undefined;
  const activations: Array<{ id: string; options?: unknown }> = [];
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    deferTask: (task) => { deferred = task; },
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    apiProfiles: {
      list: () => profiles,
      listForDisplay: async () => profiles.map((profile) => ({ ...profile, apiKeyLastFour: "test" })),
      getActive: () => profiles.find((profile) => profile.active),
      getActiveTaskCount: () => 2,
      async setDefaults() { return profiles[0]; },
      async createVerified() { throw new Error("not used"); },
      async test() { return { ok: true as const, latencyMs: 1 }; },
      async activate(id: string, options?: unknown) {
        activations.push({ id, options });
        for (const profile of profiles) profile.active = profile.id === id;
        return profiles[1];
      }
    } as never,
    runner: { async run() { return { raw: "", text: "unexpected" }; }, async stop() {} } as never
  });

  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  await send("use", "/api use 2");

  assert.equal(deferred, undefined);
  assert.deepEqual(activations, []);
  assert.match(replies.at(-1) ?? "", /2 个正在执行的任务/);
  assert.match(replies.at(-1) ?? "", /\/api confirm/);

  await send("confirm", "/api confirm");

  assert.ok(deferred);
  await deferred();
  assert.deepEqual(activations, [{ id: "two", options: { interruptActiveTasks: true } }]);
  assert.match(replies.at(-1) ?? "", /API 已切换为“Backup”/);
});

test("allows a pending API switch confirmation to be cancelled", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-api-force-cancel-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const profiles = [
    { id: "one", name: "Primary", baseUrl: "https://one.example/v1", model: "one", effort: "medium", hasApiKey: true, active: true, createdAt: "x", updatedAt: "x" },
    { id: "two", name: "Backup", baseUrl: "https://two.example/v1", model: "two", effort: "max", hasApiKey: true, active: false, createdAt: "x", updatedAt: "x" }
  ];
  let activateCalls = 0;
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    apiProfiles: {
      list: () => profiles,
      listForDisplay: async () => profiles.map((profile) => ({ ...profile, apiKeyLastFour: "test" })),
      getActive: () => profiles[0],
      getActiveTaskCount: () => 1,
      async setDefaults() { return profiles[0]; },
      async createVerified() { throw new Error("not used"); },
      async test() { return { ok: true as const, latencyMs: 1 }; },
      async activate() {
        activateCalls += 1;
        return profiles[1];
      }
    } as never,
    runner: { async run() { return { raw: "", text: "unexpected" }; }, async stop() {} } as never
  });

  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });
  await send("use", "/api use 2");
  await send("cancel", "/api cancel");
  await send("confirm", "/api confirm");

  assert.equal(activateCalls, 0);
  assert.match(replies.at(-2) ?? "", /已取消 API 切换/);
  assert.match(replies.at(-1) ?? "", /没有等待确认/);
});

test("confirms a pending API switch with /1 and interrupts active tasks", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-api-force-confirm-number-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const profiles = [
    { id: "one", name: "Primary", baseUrl: "https://one.example/v1", model: "one", effort: "medium", hasApiKey: true, active: true, createdAt: "x", updatedAt: "x" },
    { id: "two", name: "Backup", baseUrl: "https://two.example/v1", model: "two", effort: "max", hasApiKey: true, active: false, createdAt: "x", updatedAt: "x" }
  ];
  let deferred: (() => Promise<void>) | undefined;
  const activations: Array<{ id: string; options?: unknown }> = [];
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    deferTask: (task) => { deferred = task; },
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    apiProfiles: {
      list: () => profiles,
      listForDisplay: async () => profiles.map((profile) => ({ ...profile, apiKeyLastFour: "test" })),
      getActive: () => profiles.find((profile) => profile.active),
      getActiveTaskCount: () => 2,
      async setDefaults() { return profiles[0]; },
      async createVerified() { throw new Error("not used"); },
      async test() { return { ok: true as const, latencyMs: 1 }; },
      async activate(id: string, options?: unknown) {
        activations.push({ id, options });
        for (const profile of profiles) profile.active = profile.id === id;
        return profiles[1];
      }
    } as never,
    runner: { async run() { return { raw: "", text: "unexpected" }; }, async stop() {} } as never
  });

  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  await send("use", "/api use 2");
  assert.match(replies.at(-1) ?? "", /\/1/);
  assert.match(replies.at(-1) ?? "", /\/2/);

  await send("confirm-number", "/1");
  assert.ok(deferred);
  await deferred();
  assert.deepEqual(activations, [{ id: "two", options: { interruptActiveTasks: true } }]);
});

test("cancels a pending API switch with /2", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-api-force-cancel-number-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const profiles = [
    { id: "one", name: "Primary", baseUrl: "https://one.example/v1", model: "one", effort: "medium", hasApiKey: true, active: true, createdAt: "x", updatedAt: "x" },
    { id: "two", name: "Backup", baseUrl: "https://two.example/v1", model: "two", effort: "max", hasApiKey: true, active: false, createdAt: "x", updatedAt: "x" }
  ];
  let activateCalls = 0;
  let deferred: (() => Promise<void>) | undefined;
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    deferTask: (task) => { deferred = task; },
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    apiProfiles: {
      list: () => profiles,
      listForDisplay: async () => profiles.map((profile) => ({ ...profile, apiKeyLastFour: "test" })),
      getActive: () => profiles[0],
      getActiveTaskCount: () => 1,
      async setDefaults() { return profiles[0]; },
      async createVerified() { throw new Error("not used"); },
      async test() { return { ok: true as const, latencyMs: 1 }; },
      async activate() {
        activateCalls += 1;
        return profiles[1];
      }
    } as never,
    runner: { async run() { return { raw: "", text: "unexpected" }; }, async stop() {} } as never
  });

  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  await send("use", "/api use 2");
  await send("cancel-number", "/2");
  await send("confirm-after-cancel", "/api confirm");

  assert.equal(activateCalls, 0);
  assert.equal(deferred, undefined);
  assert.doesNotMatch(replies.at(-1) ?? "", /无法识别|help/iu);
});

test("asks for confirmation before active API defaults interrupt tasks", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-api-set-force-confirm-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const profile = { id: "one", name: "Primary", baseUrl: "https://one.example/v1", model: "one", effort: "medium", hasApiKey: true, active: true, createdAt: "x", updatedAt: "x" };
  let deferred: (() => Promise<void>) | undefined;
  const calls: Array<{ model: string; effort: string; options?: unknown }> = [];
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    deferTask: (task) => { deferred = task; },
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    apiProfiles: {
      list: () => [profile],
      listForDisplay: async () => [{ ...profile, apiKeyLastFour: "test" }],
      getActive: () => profile,
      getActiveTaskCount: () => 1,
      async setDefaults(_id: string, model: string, effort: string, options?: unknown) {
        calls.push({ model, effort, options });
        profile.model = model;
        profile.effort = effort;
        return profile;
      },
      async createVerified() { throw new Error("not used"); },
      async test() { return { ok: true as const, latencyMs: 1 }; },
      async activate() { return profile; }
    } as never,
    runner: { async run() { return { raw: "", text: "unexpected" }; }, async stop() {} } as never
  });

  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });
  await send("set", "/api set 1 model-new max");

  assert.equal(deferred, undefined);
  assert.deepEqual(calls, []);
  await send("confirm", "/api confirm");
  assert.ok(deferred);
  await deferred();
  assert.deepEqual(calls, [{ model: "model-new", effort: "max", options: { interruptActiveTasks: true } }]);
});

test("rejects invalid active API defaults before asking to interrupt tasks", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-api-set-invalid-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const profile = { id: "one", name: "Primary", baseUrl: "https://one.example/v1", model: "one", effort: "medium", hasApiKey: true, active: true, createdAt: "x", updatedAt: "x" };
  let setDefaultsCalls = 0;
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    apiProfiles: {
      list: () => [profile],
      listForDisplay: async () => [{ ...profile, apiKeyLastFour: "test" }],
      getActive: () => profile,
      getActiveTaskCount: () => 1,
      async setDefaults() {
        setDefaultsCalls += 1;
        return profile;
      },
      async createVerified() { throw new Error("not used"); },
      async test() { return { ok: true as const, latencyMs: 1 }; },
      async activate() { return profile; }
    } as never,
    runner: { async run() { return { raw: "", text: "unexpected" }; }, async stop() {} } as never
  });

  await service.handleMessage({
    id: "invalid-defaults",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/api set 1 model-new invalid-effort",
    raw: {}
  });

  assert.equal(setDefaultsCalls, 0);
  assert.match(replies.at(-1) ?? "", /API 配置或响应验证失败/);
  assert.doesNotMatch(replies.at(-1) ?? "", /\/api confirm/);
});

test("sets persistent API model and effort defaults through a deferred command", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-api-set-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const profile = {
    id: "one",
    name: "Primary",
    baseUrl: "https://one.example/v1",
    model: "gpt-5.6-terra",
    effort: "medium",
    hasApiKey: true,
    active: true,
    createdAt: "x",
    updatedAt: "x"
  };
  let deferred: (() => Promise<void>) | undefined;
  let requestedDefaults: { model: string; effort: string } | undefined;
  const service = new BridgeService({
    config: { ...defaultConfig(tmpDir), allowedSenderIds: ["alice@im.wechat"] },
    stateStore,
    deferTask: (task) => { deferred = task; },
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    apiProfiles: {
      list: () => [profile],
      listForDisplay: async () => [{ ...profile, apiKeyLastFour: "test" }],
      getActive: () => profile,
      async setDefaults(_id, model, effort) {
        requestedDefaults = { model, effort };
        profile.model = model;
        profile.effort = effort;
        return profile;
      },
      async createVerified() { throw new Error("not used"); },
      async test() { return { ok: true as const, latencyMs: 1 }; },
      async activate() { return profile; }
    },
    runner: { async run() { return { raw: "", text: "unexpected" }; }, async stop() {} } as never
  });

  await service.handleMessage({
    id: "set",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/api set 1 gpt-5.6-sol max",
    raw: {}
  });

  assert.equal(requestedDefaults, undefined);
  assert.ok(deferred);
  await deferred();
  assert.deepEqual(requestedDefaults, { model: "gpt-5.6-sol", effort: "max" });
  assert.match(replies.at(-1) ?? "", /模型：gpt-5\.6-sol/);
  assert.match(replies.at(-1) ?? "", /推理强度：max/);
});

test("sends local markdown images as native WeChat image messages", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-bridge-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const imagePath = path.join(tmpDir, "generated_image_latest.png");
  fs.writeFileSync(imagePath, Buffer.from("png image bytes"));
  const markdownPath = imagePath.replace(/\\/g, "/");

  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const config = {
    ...defaultConfig(tmpDir),
    allowedSenderIds: ["alice@im.wechat"],
    codexBackend: "exec" as const
  };
  const textReplies: string[] = [];
  const imageMessages: Array<Record<string, unknown>> = [];
  const weixin = {
    async sendTyping() {},
    async sendText(input: { text: string }) {
      textReplies.push(input.text);
      return { messageId: "text-message" };
    },
    async getUploadUrl() {
      return { uploadParam: "upload-token" };
    },
    async sendImageMessage(input: Record<string, unknown>) {
      imageMessages.push(input);
      return { messageId: "image-message" };
    },
    async sendFileMessage() {
      throw new Error("expected image message");
    }
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", {
    status: 200,
    headers: { "x-encrypted-param": "download-param" }
  });
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const service = new BridgeService({
    config,
    stateStore,
    weixin,
    runner: {
      async run() {
        return {
          raw: "",
          text: [
            "找到了这张，来自下载目录：",
            "",
            `![generated_image_latest.png](${markdownPath})`,
            "",
            `如果图片没有直接显示，点这里打开：[generated_image_latest.png](${markdownPath})`
          ].join("\n")
        };
      },
      async stop() {}
    }
  });

  await service.handleMessage({
    id: "message-1",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "从电脑里面找一张图片发给我",
    raw: {}
  });

  assert.equal(imageMessages.length, 1);
  assert.equal(imageMessages[0].toUserId, "alice@im.wechat");
  assert.equal(imageMessages[0].contextToken, "ctx");
  assert.equal(imageMessages[0].encryptQueryParam, "download-param");
  assert.equal(textReplies.some((reply) => reply.includes("[codex-weixin] File send requested")), false);
  assert.equal(textReplies.some((reply) => reply.includes(markdownPath)), false);
  assert.equal(textReplies.join("\n").includes("如果图片没有直接显示"), false);
});

test("sends local markdown videos as native WeChat video messages", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-bridge-video-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const videoPath = path.join(tmpDir, "desktop-demo.mp4");
  fs.writeFileSync(videoPath, Buffer.from("mp4 video bytes"));
  const markdownPath = videoPath.replace(/\\/g, "/");

  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const config = {
    ...defaultConfig(tmpDir),
    allowedSenderIds: ["alice@im.wechat"],
    codexBackend: "exec" as const
  };
  const textReplies: string[] = [];
  const videoMessages: Array<Record<string, unknown>> = [];
  const weixin = {
    async sendTyping() {},
    async sendText(input: { text: string }) {
      textReplies.push(input.text);
      return { messageId: "text-message" };
    },
    async getUploadUrl() {
      return { uploadParam: "upload-token" };
    },
    async sendImageMessage() {
      throw new Error("expected video message");
    },
    async sendFileMessage() {
      throw new Error("expected video message");
    },
    async sendVideoMessage(input: Record<string, unknown>) {
      videoMessages.push(input);
      return { messageId: "video-message" };
    }
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", {
    status: 200,
    headers: { "x-encrypted-param": "download-param" }
  });
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const service = new BridgeService({
    config,
    stateStore,
    weixin,
    runner: {
      async run() {
        return {
          raw: "",
          text: `【本轮处理结果】\n状态：已完成\n已处理：已发送桌面视频。\n\nRandom desktop video: [desktop-demo.mp4](${markdownPath})`
        };
      },
      async stop() {}
    }
  });

  await service.handleMessage({
    id: "message-1",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "send me a random video from desktop",
    raw: {}
  });

  assert.equal(videoMessages.length, 1);
  assert.equal(videoMessages[0].toUserId, "alice@im.wechat");
  assert.equal(videoMessages[0].contextToken, "ctx");
  assert.equal(videoMessages[0].encryptQueryParam, "download-param");
  assert.equal(textReplies.some((reply) => reply.includes(markdownPath)), false);
});

test("buffers inbound image attachments and includes local paths in prompt done", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-buffer-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const key = crypto.randomBytes(16);
  const plaintext = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("inbound image bytes")
  ]);
  const ciphertext = encryptAesEcb(plaintext, key);
  const aesKeyBase64 = Buffer.from(key.toString("hex"), "utf8").toString("base64");

  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const config = {
    ...defaultConfig(tmpDir),
    allowedSenderIds: ["alice@im.wechat"],
    codexBackend: "exec" as const
  };
  const textReplies: string[] = [];
  let prompt = "";
  const service = new BridgeService({
    config,
    stateStore,
    inboundDir: path.join(tmpDir, "inbound"),
    mediaFetch: async () => new Response(new Uint8Array(ciphertext), { status: 200 }),
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        textReplies.push(input.text);
        return { messageId: "text-message" };
      },
      async getUploadUrl() {
        throw new Error("not used");
      },
      async sendImageMessage() {
        throw new Error("not used");
      },
      async sendFileMessage() {
        throw new Error("not used");
      }
    },
    runner: {
      async run(input: { prompt: string }) {
        prompt = input.prompt;
        return { raw: "", text: "done" };
      },
      async stop() {}
    }
  });

  await service.handleMessage({
    id: "start",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/prompt start",
    raw: {}
  });

  const imageMessage = normalizeWeixinMessage({
    message_id: "img-1",
    from_user_id: "alice@im.wechat",
    context_token: "ctx",
    item_list: [{
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: "download-token",
          aes_key: aesKeyBase64
        }
      }
    }]
  });
  assert.ok(imageMessage);
  await service.handleMessage(imageMessage);

  await service.handleMessage({
    id: "text-1",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "描述这张图片",
    raw: {}
  });

  await service.handleMessage({
    id: "done",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "/prompt done",
    raw: {}
  });

  assert.match(prompt, /WeChat image: image\.png saved to /);
  assert.match(prompt, /描述这张图片/);
  const savedPath = prompt.match(/saved to ([^\]]+)/)?.[1];
  assert.ok(savedPath);
  assert.deepEqual(fs.readFileSync(savedPath), plaintext);
  assert.equal(textReplies.filter((reply) => reply === "Buffered. Send /prompt done when ready.").length, 2);
});

test("replies directly when a WeChat attachment exceeds 100 MiB", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-oversize-notice-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  let runnerCalled = false;
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"]
    },
    stateStore,
    mediaFetch: async () => new Response(null, {
      status: 200,
      headers: { "content-length": String(MAX_INBOUND_BYTES + 1) }
    }),
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run() {
        runnerCalled = true;
        return { raw: "", text: "不应执行" };
      },
      async stop() {}
    } as never
  });

  const message = normalizeWeixinMessage({
    message_id: "video-large",
    from_user_id: "alice@im.wechat",
    context_token: "ctx",
    item_list: [{
      type: 5,
      video_item: {
        media: { full_url: "https://example.test/video" },
        video_size: MAX_INBOUND_BYTES + 1
      }
    }]
  });
  assert.ok(message);
  await service.handleMessage(message);

  assert.equal(runnerCalled, false);
  assert.deepEqual(replies, ["附件超过 100 MiB 上限，请压缩或裁剪后重新发送。"]);
});

test("lists resumable sessions with unambiguous R codes and switches by code", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-resume-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const first = stateStore.createSession("alice@im.wechat", "/work/one", "更新修复");
  stateStore.setThread("alice@im.wechat", "thread-one");
  stateStore.setSessionPromptPreview(first.id, "修复 macOS 自动更新");
  const second = stateStore.createSession("alice@im.wechat", "/work/two", "季度报告");
  stateStore.setThread("alice@im.wechat", "thread-two");
  const replies: string[] = [];
  const runs: Array<{ prompt: string; threadId?: string }> = [];
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"]
    },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `text-${replies.length}` };
      }
    } as never,
    runner: {
      async getHistory(threadId: string) {
        assert.equal(threadId, "thread-two");
        return [{
          id: "history-user",
          role: "user" as const,
          text: buildPrompt("分析季度报告", [{
            kind: "file",
            label: "report.pdf",
            path: "/private/report.pdf"
          }])
        }];
      },
      async run(input: { prompt: string; threadId?: string }) {
        runs.push(input);
        return { raw: "", text: "继续完成", threadId: input.threadId };
      },
      async stop() {}
    } as never
  });
  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  const listedSessions = stateStore.listSessions()
    .filter((session) => session.senderId === "alice@im.wechat");
  const firstNumber = listedSessions.findIndex((session) => session.id === first.id) + 1;
  const secondNumber = listedSessions.findIndex((session) => session.id === second.id) + 1;

  await send("resume-list", "/resume");
  const listReply = replies.at(-1) ?? "";
  assert.match(listReply, new RegExp(`\\[R${secondNumber}\\] 【当前】季度报告`));
  assert.match(listReply, /最近内容：分析季度报告 文件：report\.pdf/);
  assert.match(listReply, new RegExp(`\\[R${firstNumber}\\] 更新修复`));
  assert.match(listReply, /修复 macOS 自动更新/);
  assert.match(listReply, /R1 是切换编号，“会话 6”等是会话名称/);
  assert.doesNotMatch(listReply, /thread-one|thread-two|private\/report/);
  assert.equal(stateStore.getSession(second.id)?.lastPromptPreview, "分析季度报告 文件：report.pdf");

  await send("resume-bare-number", "/resume 2");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.id, second.id);
  assert.match(replies.at(-1) ?? "", /R 开头的切换编号/);

  await send("resume-invalid", "/resume R99");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.id, second.id);
  assert.match(replies.at(-1) ?? "", /没有这个切换编号/);

  await send("resume-first", `/resume r${firstNumber}`);
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.id, first.id);
  assert.match(replies.at(-1) ?? "", new RegExp(`已通过 R${firstNumber} 切换到：更新修复`));
  assert.doesNotMatch(replies.at(-1) ?? "", /thread-one/);

  await send("continued-turn", "继续处理");
  assert.equal(runs.at(-1)?.threadId, "thread-one");
});

test("lists and switches model and reasoning effort for the active WeChat session", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-model-command-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const paths = resolveStatePaths(path.join(tmpDir, "state"));
  const stateStore = new RuntimeStateStore(paths);
  const replies: string[] = [];
  const runs: Array<{ model?: string; effort?: string }> = [];
  const models = [{
    model: "gpt-default",
    displayName: "GPT Default",
    description: "Default model",
    isDefault: true,
    defaultEffort: "medium",
    supportedEfforts: [
      { effort: "low", description: "Low" },
      { effort: "medium", description: "Medium" }
    ]
  }, {
    model: "gpt-fast",
    displayName: "GPT Fast",
    description: "Fast model",
    isDefault: false,
    defaultEffort: "low",
    supportedEfforts: [
      { effort: "low", description: "Low" },
      { effort: "high", description: "High" }
    ]
  }];
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"],
      model: "gpt-default",
      effort: "medium"
    },
    stateStore,
    listCodexModels: async () => models,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run(input: { model?: string; effort?: string }) {
        runs.push(input);
        return { raw: "", text: "done", threadId: "thread-model" };
      },
      async getRuntimeInfo() {
        return { model: "runtime-model", effort: "low" };
      },
      async stop() {}
    } as never
  });
  const send = async (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  await send("model-list", "/model");
  assert.match(replies.at(-1) ?? "", /2\. GPT Fast（gpt-fast）/);
  await send("model-switch", "/model 2");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.model, "gpt-fast");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.effort, "low");

  await send("effort-list", "/effort");
  assert.match(replies.at(-1) ?? "", /2\. 高（high）/);
  assert.doesNotMatch(replies.at(-1) ?? "", /medium/);
  await send("effort-switch", "/effort 2");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.effort, "high");
  await send("invalid-effort", "/effort ultra");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.effort, "high");

  await send("turn", "使用当前设置");
  assert.equal(runs.at(-1)?.model, "gpt-fast");
  assert.equal(runs.at(-1)?.effort, "high");
  await send("status", "/status");
  assert.match(replies.at(-1) ?? "", /model: gpt-fast/);
  assert.match(replies.at(-1) ?? "", /effort: high/);

  const overriddenSession = stateStore.getActiveSession("alice@im.wechat")?.id;
  await send("new", "/new");
  await send("new-turn", "新会话使用默认值");
  assert.equal(runs.at(-1)?.model, "gpt-default");
  assert.equal(runs.at(-1)?.effort, "medium");

  assert.ok(overriddenSession);
  stateStore.activateSession(overriddenSession);
  await send("model-default", "/model default");
  await send("effort-default", "/effort default");
  await send("default-turn", "恢复默认值");
  assert.equal(runs.at(-1)?.model, "gpt-default");
  assert.equal(runs.at(-1)?.effort, "medium");
  assert.equal(new RuntimeStateStore(paths).getSession(overriddenSession)?.model, undefined);
  assert.equal(new RuntimeStateStore(paths).getSession(overriddenSession)?.effort, undefined);
});

test("streams process progress but sends the final WeChat answer as one message", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-stream-command-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"],
      streamReplies: false
    },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text-message" };
      }
    } as never,
    runner: {
      async run(input: {
        onDelta?: (delta: string) => Promise<void>;
        onProgress?: (message: string) => Promise<void>;
      }) {
        assert.equal(input.onDelta, undefined);
        await input.onProgress?.("正在查询资料。");
        return {
          raw: "",
          threadId: "thread-stream",
          text: [
            "第一段。",
            "",
            "第二段。",
            "",
            "```codex-weixin-actions",
            '{"send":[]}',
            "```"
          ].join("\n")
        };
      },
      async getRuntimeInfo() {
        return {};
      },
      async stop() {}
    } as never
  });
  const send = (id: string, text: string) => service.handleMessage({
    id,
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text,
    raw: {}
  });

  await send("status-default", "/stream");
  assert.match(replies.at(-1) ?? "", /关闭.*继承全局/);
  await send("enable", "/stream on");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.streamReplies, true);
  await send("turn", "开始流式回复");
  assert.equal(replies.filter((reply) => reply === "【进度】正在查询资料。").length, 1);
  assert.equal(replies.filter((reply) => reply === "第一段。\n\n第二段。").length, 1);
  assert.equal(replies.filter((reply) => reply === "第一段。").length, 0);
  assert.equal(replies.some((reply) => reply.includes("codex-weixin-actions")), false);

  await send("inherit", "/stream default");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.streamReplies, undefined);
  await send("disable", "/stream off");
  assert.equal(stateStore.getActiveSession("alice@im.wechat")?.streamReplies, false);
});

test("preserves the tail of a long final answer with bounded WeChat chunks", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-long-reply-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const finalText = `${"长回答".repeat(700)}\n\n来源：arXiv 官方作者检索。`;
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"],
      streamReplies: true
    },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `text-${replies.length}` };
      }
    } as never,
    runner: {
      async run(input: { onProgress?: (message: string) => Promise<void> }) {
        await input.onProgress?.("正在检索论文。");
        return { raw: "", threadId: "thread-long", text: finalText };
      },
      async getRuntimeInfo() {
        return {};
      },
      async stop() {}
    } as never
  });

  await service.handleMessage({
    id: "long",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "查询论文",
    raw: {}
  });

  assert.equal(replies[0], "【进度】正在检索论文。");
  const finalChunks = replies.slice(1);
  assert.equal(finalChunks.length, 2);
  assert.equal(finalChunks.every((chunk) => chunk.length <= 1_800), true);
  assert.equal(finalChunks.join(""), finalText);
  assert.match(finalChunks.at(-1) ?? "", /来源：arXiv 官方作者检索。$/);
});

test("continues a WeChat turn until Codex provides a visible final report", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-terminal-report-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const reportFile = path.join(tmpDir, "terminal-report.txt");
  fs.writeFileSync(reportFile, "report");
  const replies: string[] = [];
  const fileMessages: Array<Record<string, unknown>> = [];
  const runs: Array<{ prompt: string; threadId?: string }> = [];
  const finalReport = "【本轮处理结果】\n状态：已完成\n已处理：已补发本轮执行结果。";
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", {
    status: 200,
    headers: { "x-encrypted-param": "download-param" }
  });
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"]
    },
    stateStore,
    retryDelay: async () => {},
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `text-${replies.length}` };
      },
      async getUploadUrl() {
        return { uploadParam: "upload-token" };
      },
      async sendFileMessage(input: Record<string, unknown>) {
        fileMessages.push(input);
        return { messageId: "file-message" };
      },
      async sendImageMessage() {
        throw new Error("expected file message");
      },
      async sendVideoMessage() {
        throw new Error("expected file message");
      }
    } as never,
    runner: {
      async run(input: { prompt: string; threadId?: string }) {
        runs.push(input);
        if (runs.length === 1) {
          return {
            raw: "",
            text: `\`\`\`codex-weixin-actions\n{\"send\":[{\"type\":\"file\",\"path\":${JSON.stringify(reportFile)}}]}\n\`\`\``,
            threadId: "thread-terminal-report"
          };
        }
        return { raw: "", text: finalReport, threadId: input.threadId };
      },
      async stop() {}
    } as never
  });

  await service.handleMessage({
    id: "terminal-report",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "完成后告诉我结果",
    raw: {}
  });

  assert.equal(runs.length, 2);
  assert.equal(runs[1]?.threadId, "thread-terminal-report");
  assert.match(runs[1]?.prompt ?? "", /没有给用户提供任何可读的最终汇报/);
  assert.equal(fileMessages.length, 1);
  assert.equal(fileMessages[0]?.toUserId, "alice@im.wechat");
  assert.deepEqual(replies, [finalReport]);
});

test("ends a WeChat turn after bounded missing-final-report recovery attempts", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-missing-terminal-report-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const typingStates: boolean[] = [];
  let runs = 0;
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"]
    },
    stateStore,
    retryDelay: async () => {},
    weixin: {
      async sendTyping(input: { typing: boolean }) {
        typingStates.push(input.typing);
      },
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `text-${replies.length}` };
      }
    } as never,
    runner: {
      async run() {
        runs += 1;
        return { raw: "", text: "", threadId: "thread-missing-terminal-report" };
      },
      async stop() {}
    } as never
  });

  await service.handleMessage({
    id: "missing-terminal-report",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "完成后告诉我结果",
    raw: {}
  });

  assert.equal(runs, 4);
  assert.deepEqual(replies, [MISSING_FINAL_REPORT_FALLBACK]);
  assert.deepEqual(typingStates, [true, false]);
});

test("automatically resumes a recoverable failed turn up to ten times", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-unclassified-retry-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const attempts: Array<{ prompt: string; threadId?: string }> = [];
  let calls = 0;
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"]
    },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `text-${replies.length}` };
      }
    } as never,
    retryDelay: async () => {},
    runner: {
      async run(input: {
        prompt: string;
        threadId?: string;
        onThreadStarted?: (threadId: string) => void;
      }) {
        attempts.push({ prompt: input.prompt, threadId: input.threadId });
        calls += 1;
        if (calls === 1) {
          input.onThreadStarted?.("thread-resumed");
          throw new Error("stream disconnected before completion: stream closed before response.completed");
        }
        if (calls === 2) {
          throw new Error("stream disconnected before completion: stream closed before response.completed");
        }
        return { raw: "", text: "恢复完成", threadId: input.threadId };
      },
      async stop() {}
    } as never
  });

  await service.handleMessage({
    id: "retry-turn",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "继续完成任务",
    raw: {}
  });

  assert.equal(calls, 3);
  assert.equal(attempts[1]?.threadId, "thread-resumed");
  assert.match(attempts[1]?.prompt ?? "", /从当前会话继续完成上一轮任务/);
  assert.equal(stateStore.getThread("alice@im.wechat"), "thread-resumed");
  assert.deepEqual(replies, ["恢复完成"]);
});

test("keeps recovering a transient turn through twenty retries", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-unclassified-retry-unbounded-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  let calls = 0;
  const replies: string[] = [];
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"]
    },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text" };
      }
    } as never,
    retryDelay: async () => {},
    runner: {
      async run() {
        calls += 1;
        if (calls <= 20) {
          throw new Error("stream disconnected before completion: stream closed before response.completed");
        }
        return { raw: "", text: "恢复完成" };
      },
      async stop() {}
    } as never
  });

  await service.handleMessage({
    id: "retry-unbounded",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "继续完成任务",
    raw: {}
  });

  assert.equal(calls, 21);
  assert.deepEqual(replies, ["恢复完成"]);
});

test("ends a persistently disconnected turn after twenty retries", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-retry-limit-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  let calls = 0;
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"]
    },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText() {
        return { messageId: "text" };
      }
    } as never,
    retryDelay: async () => {
      if (calls > 20) {
        throw new Error("retry test guard");
      }
    },
    runner: {
      async run() {
        calls += 1;
        throw new Error("stream disconnected before completion: stream closed before response.completed");
      },
      async stop() {}
    } as never
  });

  await assert.rejects(
    service.handleMessage({
      id: "retry-limit",
      senderId: "alice@im.wechat",
      contextToken: "ctx",
      text: "finish this task",
      raw: {}
    }),
    /stream disconnected before completion/
  );

  assert.equal(calls, 21);
});

test("retries a transient 502 from the active API on the same thread", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-provider-502-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  let calls = 0;
  const attempts: Array<{ prompt: string; threadId?: string }> = [];
  const replies: string[] = [];
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"]
    },
    stateStore,
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: "text" };
      }
    } as never,
    retryDelay: async () => {},
    runner: {
      async run(input: { prompt: string; threadId?: string; onThreadStarted?: (threadId: string) => void }) {
        calls += 1;
        attempts.push({ prompt: input.prompt, threadId: input.threadId });
        if (calls === 1) {
          input.onThreadStarted?.("thread-kki");
          throw new Error("unexpected status 502 Bad Gateway: https://api.example/v1/responses");
        }
        return { raw: "", text: "KKI 重试后完成", threadId: input.threadId ?? "thread-kki" };
      },
      async stop() {}
    } as never
  });

  await service.handleMessage({
    id: "provider-502",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "reply with one",
    raw: {}
  });

  assert.equal(calls, 2);
  assert.equal(attempts[1]?.threadId, "thread-kki");
  assert.match(attempts[1]?.prompt ?? "", /从当前会话继续完成上一轮任务/);
  assert.deepEqual(replies, ["KKI 重试后完成"]);
});

test("continues a turn after the app-server stream closes before response.completed", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-stream-recovery-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateStore = new RuntimeStateStore(resolveStatePaths(path.join(tmpDir, "state")));
  const replies: string[] = [];
  const attempts: Array<{ prompt: string; threadId?: string }> = [];
  let calls = 0;
  const service = new BridgeService({
    config: {
      ...defaultConfig(tmpDir),
      allowedSenderIds: ["alice@im.wechat"]
    },
    stateStore,
    retryDelay: async () => {},
    weixin: {
      async sendTyping() {},
      async sendText(input: { text: string }) {
        replies.push(input.text);
        return { messageId: `text-${replies.length}` };
      }
    } as never,
    runner: {
      async run(input: { prompt: string; threadId?: string; onThreadStarted?: (threadId: string) => void }) {
        attempts.push({ prompt: input.prompt, threadId: input.threadId });
        calls += 1;
        input.onThreadStarted?.("thread-stream-recovery");
        if (calls === 1) {
          throw new Error("stream disconnected before completion: stream closed before response.completed");
        }
        return { raw: "", text: "断流后已继续完成", threadId: input.threadId };
      },
      async stop() {}
    } as never
  });

  await service.handleMessage({
    id: "stream-recovery",
    senderId: "alice@im.wechat",
    contextToken: "ctx",
    text: "继续完成这个任务",
    raw: {}
  });

  assert.equal(calls, 2);
  assert.equal(attempts[1]?.threadId, "thread-stream-recovery");
  assert.deepEqual(replies, ["断流后已继续完成"]);
});
