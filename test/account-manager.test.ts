import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPrompt } from "../src/bridge/format.js";
import { AccountManager } from "../src/server/account-manager.js";
import { defaultConfig } from "../src/state/config.js";
import { accountStatePaths, resolveStatePaths } from "../src/state/paths.js";
import { RuntimeStateStore } from "../src/state/runtime-state.js";
import { listRetainedAccounts, loadAccount, saveAccount } from "../src/weixin/accounts.js";

function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-manager-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  for (const accountId of ["account-one", "account-two"]) {
    saveAccount(paths, {
      accountId,
      userId: `user-${accountId}`,
      token: `token-${accountId}`,
      baseUrl: "https://example.test",
      cdnBaseUrl: "https://cdn.example.test",
      savedAt: new Date().toISOString(),
      enabled: true
    });
  }
  const starts: string[] = [];
  const lifecycle: string[] = [];
  const runs: Array<Record<string, unknown>> = [];
  const bridgeActiveTurnCounts = new Map<string, number>();
  const cancellationNotices: string[] = [];
  let bridgeCancellationHandler: ((accountId: string, notice?: string) => Promise<void>) | undefined;
  let runnerStopCalls = 0;
  let runnerCloseCalls = 0;
  let runtimeInfo: { model?: string; effort?: string; provider?: string } = {
    model: "runtime-model",
    effort: "medium"
  };
  let runHandler: ((input: Record<string, unknown>) => Promise<{ raw: string; text: string; threadId?: string }>) | undefined;
  const history = [
    { id: "user-1", role: "user" as const, text: buildPrompt("历史问题") },
    { id: "assistant-1", role: "assistant" as const, text: "历史回答" }
  ];
  const runner = {
    async run(input: Record<string, unknown>) {
      runs.push(input);
      if (runHandler) return runHandler(input);
      return { raw: "", text: "Web reply", threadId: input.threadId ?? "thread-web" };
    },
    async getHistory() {
      return structuredClone(history);
    },
    async getRuntimeInfo() {
      return runtimeInfo;
    },
    async listModels() {
      return [{
        model: "runtime-model",
        displayName: "Runtime Model",
        description: "Runtime model description",
        isDefault: true,
        defaultEffort: "medium",
        supportedEfforts: [{ effort: "medium", description: "Balanced" }]
      }];
    },
    async stop() { runnerStopCalls += 1; },
    close() { runnerCloseCalls += 1; }
  };
  const manager = new AccountManager({
    paths,
    configProvider: () => defaultConfig(root),
    clientFactory: (account) => ({ accountId: account.accountId }) as never,
    bridgeFactory: (input) => ({
      handleMessage: async () => {},
      cancelActiveTurns: async (notice?: string) => {
        const accountId = (input.weixin as never as { accountId: string }).accountId;
        lifecycle.push(`cancel:${accountId}`);
        if (notice) cancellationNotices.push(notice);
        await bridgeCancellationHandler?.(accountId, notice);
      },
      getActiveTaskCount() {
        const accountId = (input.weixin as never as { accountId: string }).accountId;
        return bridgeActiveTurnCounts.get(accountId) ?? 0;
      },
      replaceRuntime() {},
      allowSender(senderId: string) {
        input.stateStore.setPairedSenderIds([...input.stateStore.listPairedSenderIds(), senderId]);
      },
      removeSender(senderId: string) {
        input.stateStore.setPairedSenderIds(input.stateStore.listPairedSenderIds().filter((id) => id !== senderId));
      }
    }) as never,
    monitor: async ({ client, signal }) => {
      const accountId = (client as never as { accountId: string }).accountId;
      starts.push(accountId);
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => {
        lifecycle.push(`abort:${accountId}`);
        resolve();
    }, { once: true }));
    },
    runnerFactory: () => runner as never,
    terminalReportRetryDelay: async () => {}
  });
  return {
    manager,
    paths,
    starts,
    lifecycle,
    cancellationNotices,
    root,
    runs,
    history,
    getRunnerStopCalls() {
      return runnerStopCalls;
    },
    getRunnerCloseCalls() {
      return runnerCloseCalls;
    },
    setRunHandler(handler: typeof runHandler) {
      runHandler = handler;
    },
    setBridgeActiveTurnCount(accountId: string, count: number) {
      bridgeActiveTurnCounts.set(accountId, count);
    },
    setBridgeCancellationHandler(handler: typeof bridgeCancellationHandler) {
      bridgeCancellationHandler = handler;
    },
    setRuntimeInfo(value: typeof runtimeInfo) {
      runtimeInfo = value;
    }
  };
}

test("starts and stops multiple accounts independently", async (t) => {
  const { manager, starts } = setup(t);
  await manager.startAll();

  assert.deepEqual(starts.sort(), ["account-one", "account-two"]);
  assert.deepEqual(manager.listAccounts().map((account) => account.status), ["running", "running"]);

  await manager.stopAccount("account-one");
  assert.equal(manager.listAccounts().find((account) => account.accountId === "account-one")?.status, "stopped");
  assert.equal(manager.listAccounts().find((account) => account.accountId === "account-two")?.status, "running");
  await manager.stopAccount("account-two");
});

test("cancels active bridge turns before stopping an account monitor", async (t) => {
  const { manager, lifecycle } = setup(t);
  await manager.startAccount("account-one", false);

  await manager.stopAccount("account-one", false);

  assert.deepEqual(lifecycle, ["cancel:account-one", "abort:account-one"]);
});

test("defers a runtime restart until an active session turn has finished", async (t) => {
  const { manager, root, starts, lifecycle, setRunHandler } = setup(t);
  await manager.startAll();
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Active turn");
  let releaseTurn!: () => void;
  const turnGate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  setRunHandler(async () => {
    await turnGate;
    return { raw: "", text: "completed", threadId: "thread-active" };
  });

  const turn = manager.continueSession("account-one", session.id, "finish before switching runtime");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.listSessions().find((item) => item.id === session.id)?.responding, true);

  let restartFinished = false;
  const restart = manager.restartRunning().then(() => {
    restartFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(restartFinished, false);
  assert.deepEqual(lifecycle, []);
  assert.equal(starts.filter((accountId) => accountId === "account-one").length, 1);
  assert.equal(starts.filter((accountId) => accountId === "account-two").length, 1);

  releaseTurn();
  await turn;
  await restart;
  assert.equal(restartFinished, true);
  assert.deepEqual(lifecycle, []);
  assert.equal(starts.filter((accountId) => accountId === "account-one").length, 1);
  assert.equal(starts.filter((accountId) => accountId === "account-two").length, 1);
});

test("interrupts bridge tasks before a confirmed runtime restart", async (t) => {
  const { manager, lifecycle } = setup(t);
  await manager.startAll();

  await manager.restartRunning(undefined, { interruptActiveTasks: true });

  assert.deepEqual(lifecycle.sort(), ["cancel:account-one", "cancel:account-two"]);
  await manager.stopAll();
});

test("waits for API-switch termination notices before closing the old runtime", async (t) => {
  const { manager, getRunnerCloseCalls, setBridgeCancellationHandler } = setup(t);
  await manager.startAll();
  let releaseNotices!: () => void;
  const noticesSent = new Promise<void>((resolve) => {
    releaseNotices = resolve;
  });
  setBridgeCancellationHandler(async () => noticesSent);

  const restart = manager.restartRunning(undefined, { interruptActiveTasks: true });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(getRunnerCloseCalls(), 0);
  releaseNotices();
  await restart;
  assert.ok(getRunnerCloseCalls() >= 1);
  await manager.stopAll();
});

test("counts bridge tasks before they reach a responding session", async (t) => {
  const { manager, setBridgeActiveTurnCount } = setup(t);
  await manager.startAll();
  setBridgeActiveTurnCount("account-one", 1);

  assert.equal(manager.getActiveTaskCount(), 1);
  await manager.stopAll();
});

test("force restart cancels a hung Web session without waiting for it to settle", async (t) => {
  const { manager, root, cancellationNotices, getRunnerCloseCalls, getRunnerStopCalls, setRunHandler } = setup(t);
  await manager.startAll();
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Hung Web turn");
  setRunHandler(async () => new Promise(() => {}));

  const turn = manager.continueSession("account-one", session.id, "wait forever");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.listSessions().find((item) => item.id === session.id)?.responding, true);
  assert.equal(manager.getActiveTaskCount(), 1);

  const restart = manager.restartRunning(undefined, { interruptActiveTasks: true });
  const restarted = await Promise.race([
    restart.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 75))
  ]);

  assert.equal(restarted, true);
  await assert.rejects(turn, /API switch/i);
  assert.ok(getRunnerStopCalls() >= 1);
  assert.ok(getRunnerCloseCalls() >= 1);
  assert.ok(cancellationNotices.includes("当前任务已因确认的 API 切换而结束。"));
  assert.equal(manager.listSessions().find((item) => item.id === session.id)?.responding, false);
  assert.equal(manager.getActiveTaskCount(), 0);
  await manager.stopAll();
});

test("holds new Web turns behind a force-switch runtime gate", async (t) => {
  const { manager, root, runs } = setup(t);
  await manager.startAll();
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Queued Web turn");
  let releaseSwitch!: () => void;
  let signalSwitchEntered!: () => void;
  const switchEntered = new Promise<void>((resolve) => {
    signalSwitchEntered = resolve;
  });
  const switchGate = new Promise<void>((resolve) => {
    releaseSwitch = resolve;
  });

  const restart = manager.restartRunning(async () => {
    signalSwitchEntered();
    await switchGate;
  }, { interruptActiveTasks: true });
  await switchEntered;

  const turn = manager.continueSession("account-one", session.id, "start after the API switch");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runs.length, 0);

  releaseSwitch();
  await restart;
  await turn;
  assert.equal(runs.length, 1);
  await manager.stopAll();
});

test("releases a failed runtime gate before starting rollback work", async (t) => {
  const { manager } = setup(t);
  let rollbackPrepared = false;

  const rollback = manager.restartRunning(() => {
    throw new Error("first runtime preparation failed");
  }).catch(() => manager.restartRunning(() => {
    rollbackPrepared = true;
  }));

  await rollback;
  assert.equal(rollbackPrepared, true);
  await manager.stopAll();
});

test("refuses to delete a responding session while a runtime switch is pending", async (t) => {
  const { manager, root, setRunHandler } = setup(t);
  await manager.startAll();
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Active turn");
  let releaseTurn!: () => void;
  const turnGate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  setRunHandler(async () => {
    await turnGate;
    return { raw: "", text: "completed", threadId: "thread-active" };
  });

  const turn = manager.continueSession("account-one", session.id, "finish before switching runtime");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.throws(
    () => manager.deleteSession("account-one", session.id),
    /responding/i
  );
  let restartFinished = false;
  const restart = manager.restartRunning().then(() => {
    restartFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(restartFinished, false);

  releaseTurn();
  await turn;
  await restart;
  assert.equal(manager.listSessions().some((item) => item.id === session.id), true);
  await manager.stopAll();
});

test("applies a runtime configuration only after the active turn becomes idle", async (t) => {
  const { manager, root, setRunHandler } = setup(t);
  await manager.startAll();
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Active turn");
  let releaseTurn!: () => void;
  const turnGate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  setRunHandler(async () => {
    await turnGate;
    return { raw: "", text: "completed", threadId: "thread-active" };
  });

  const turn = manager.continueSession("account-one", session.id, "finish before applying configuration");
  await new Promise((resolve) => setTimeout(resolve, 20));
  let prepared = false;
  const restart = manager.restartRunning(() => {
    prepared = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(prepared, false);

  releaseTurn();
  await turn;
  await restart;
  assert.equal(prepared, true);
  await manager.stopAll();
});

test("refreshes a running account so new credentials take effect", async (t) => {
  const { manager, starts } = setup(t);
  await manager.startAccount("account-one", false);

  await manager.refreshAccount("account-one");

  assert.equal(starts.filter((accountId) => accountId === "account-one").length, 2);
  assert.equal(manager.listAccounts().find((account) => account.accountId === "account-one")?.status, "running");
  await manager.stopAccount("account-one", false);
});

test("isolates senders and managed sessions by account", async (t) => {
  const { manager, root } = setup(t);
  await manager.startAll();
  manager.allowSender("account-one", "alice@im.wechat");
  manager.allowSender("account-two", "bob@im.wechat");
  manager.createSession("account-one", "alice@im.wechat", root, "Alice session");
  manager.createSession("account-two", "bob@im.wechat", root, "Bob session");

  const accounts = manager.listAccounts();
  assert.deepEqual(accounts.find((account) => account.accountId === "account-one")?.pairedSenderIds, ["alice@im.wechat"]);
  assert.deepEqual(accounts.find((account) => account.accountId === "account-two")?.pairedSenderIds, ["bob@im.wechat"]);
  assert.deepEqual(manager.listSessions().map((session) => session.accountId).sort(), ["account-one", "account-two"]);
  await manager.stopAccount("account-one");
  await manager.stopAccount("account-two");
});

test("persists and clears a local account display name", (t) => {
  const { manager, paths } = setup(t);

  const renamed = manager.renameAccount("account-one", "  工作微信  ");
  assert.equal(renamed.displayName, "工作微信");
  assert.equal(loadAccount(paths, "account-one").displayName, "工作微信");

  assert.throws(
    () => manager.renameAccount("account-one", "a".repeat(41)),
    /40 characters or fewer/
  );

  const cleared = manager.renameAccount("account-one", "   ");
  assert.equal(cleared.displayName, undefined);
  assert.equal(loadAccount(paths, "account-one").displayName, undefined);
});

test("optionally retains account sessions when removing a WeChat account", async (t) => {
  const { manager, paths, root } = setup(t);
  manager.renameAccount("account-one", "张三");
  manager.allowSender("account-one", "alice@im.wechat");
  manager.createSession("account-one", "alice@im.wechat", root, "历史会话");
  const retainedStatePath = accountStatePaths(paths, "account-one").statePath;

  await manager.removeAccount("account-one", { retainHistory: true });

  assert.deepEqual(manager.listAccounts().map((account) => account.accountId), ["account-two"]);
  assert.equal(fs.existsSync(retainedStatePath), true);
  assert.deepEqual(listRetainedAccounts(paths).map((account) => ({
    accountId: account.accountId,
    userId: account.userId,
    displayName: account.displayName
  })), [{ accountId: "account-one", userId: "user-account-one", displayName: "张三" }]);

  const removedState = new RuntimeStateStore(accountStatePaths(paths, "account-two"));
  removedState.createSession("bob@im.wechat", root, "删除的会话");
  await manager.removeAccount("account-two", { retainHistory: false });
  assert.equal(fs.existsSync(path.dirname(accountStatePaths(paths, "account-two").statePath)), false);
});

test("reports the effective Codex model and reasoning effort", async (t) => {
  const { manager } = setup(t);

  assert.deepEqual(await manager.getCodexRuntimeInfo(), {
    model: "runtime-model",
    effort: "medium"
  });
});

test("reports the models and reasoning efforts advertised by Codex", async (t) => {
  const { manager } = setup(t);

  assert.deepEqual(await manager.getCodexModels(), [{
    model: "runtime-model",
    displayName: "Runtime Model",
    description: "Runtime model description",
    isDefault: true,
    defaultEffort: "medium",
    supportedEfforts: [{ effort: "medium", description: "Balanced" }]
  }]);
});

test("keeps the GPT-5.6 provider family available after selecting another model", async (t) => {
  const { manager, setRuntimeInfo } = setup(t);
  setRuntimeInfo({ model: "gpt-5.5", effort: "xhigh", provider: "IkunCoding" });

  const models = await manager.getCodexModels();
  assert.deepEqual(models.slice(0, 3).map((model) => model.model), [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna"
  ]);
  assert.deepEqual(
    models.find((model) => model.model === "gpt-5.6-sol")?.supportedEfforts.map((option) => option.effort),
    ["low", "medium", "high", "xhigh", "max", "ultra"]
  );
  assert.deepEqual(
    models.find((model) => model.model === "gpt-5.6-luna")?.supportedEfforts.map((option) => option.effort),
    ["low", "medium", "high", "xhigh", "max"]
  );
});

test("reads managed thread history and continues the same session from Web", async (t) => {
  const { manager, root, runs } = setup(t);
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Web chat");

  assert.deepEqual(await manager.getSessionMessages("account-one", session.id), []);
  const result = await manager.continueSession("account-one", session.id, "继续这个会话");

  assert.equal(result.threadId, "thread-web");
  assert.equal(result.message.text, "Web reply");
  assert.equal(runs[0].threadId, undefined);
  assert.match(String(runs[0].prompt), /继续这个会话/);
  assert.equal(manager.listSessions()[0].threadId, "thread-web");
  assert.equal(manager.listSessions()[0].lastPromptPreview, "继续这个会话");
  assert.deepEqual(await manager.getSessionMessages("account-one", session.id), [
    { id: "user-1", role: "user", text: "历史问题", attachments: [] },
    { id: "assistant-1", role: "assistant", text: "历史回答", attachments: [] }
  ]);
});

test("continues a Web session until Codex provides a visible final report", async (t) => {
  const { manager, root, runs, setRunHandler } = setup(t);
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Web report");
  const reportFile = path.join(root, "terminal-report.txt");
  fs.writeFileSync(reportFile, "report");
  const finalReport = "【本轮处理结果】\n状态：已完成\n已处理：已补发本轮执行结果。";
  setRunHandler(async (input) => {
    if (runs.length === 1) {
      return {
        raw: "",
        text: `\`\`\`codex-weixin-actions\n{\"send\":[{\"type\":\"file\",\"path\":${JSON.stringify(reportFile)}}]}\n\`\`\``,
        threadId: "thread-web-report"
      };
    }
    return { raw: "", text: finalReport, threadId: input.threadId as string };
  });

  const result = await manager.continueSession("account-one", session.id, "完成后给我结果");

  assert.equal(runs.length, 2);
  assert.equal(runs[1]?.threadId, "thread-web-report");
  assert.match(String(runs[1]?.prompt), /没有给用户提供任何可读的最终汇报/);
  assert.equal(result.message.text, finalReport);
  assert.deepEqual(result.message.attachments, [{
    index: 0,
    type: "file",
    name: "terminal-report.txt",
    size: 6,
    available: true
  }]);
});

test("uses WeChat session model overrides when continuing the same session from Web", async (t) => {
  const { manager, paths, root, runs } = setup(t);
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Shared chat");
  const store = new RuntimeStateStore(accountStatePaths(paths, "account-one"));
  store.setModelOverride("alice@im.wechat", "gpt-session");
  store.setEffortOverride("alice@im.wechat", "high");

  await manager.continueSession("account-one", session.id, "从 Web 继续");

  assert.equal(runs[0].model, "gpt-session");
  assert.equal(runs[0].effort, "high");
});

test("streams Web progress without exposing final-answer deltas", async (t) => {
  const { manager, root, setRunHandler } = setup(t);
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Streaming chat");
  manager.updateSessionRuntime("account-one", session.id, { streamReplies: true });
  const progress: string[] = [];
  setRunHandler(async (input) => {
    assert.equal(input.onDelta, undefined);
    await (input.onProgress as ((message: string) => Promise<void>) | undefined)?.("正在处理");
    return { raw: "", text: "第一段。\n\n第二段。", threadId: "thread-stream-web" };
  });

  assert.equal(manager.isSessionStreamEnabled("account-one", session.id), true);
  await manager.continueSession("account-one", session.id, "开始", [], async (message) => {
    progress.push(message);
  });
  assert.deepEqual(progress, ["正在处理"]);

  manager.updateSessionRuntime("account-one", session.id, { streamReplies: false });
  assert.equal(manager.isSessionStreamEnabled("account-one", session.id), false);
});

test("stores Web uploads per session and exposes them in user history", async (t) => {
  const { manager, root, runs, history } = setup(t);
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Upload chat");

  await manager.continueSession("account-one", session.id, "分析附件", [{
    name: "report?.txt",
    data: Buffer.from("report body")
  }]);
  assert.match(String(runs[0].prompt), /Web file: report_\.txt saved to/);
  assert.equal(manager.listSessions()[0].lastPromptPreview, "分析附件 文件：report_.txt");
  history[0].text = String(runs[0].prompt);

  const messages = await manager.getSessionMessages("account-one", session.id);
  assert.deepEqual(messages[0], {
    id: "user-1",
    role: "user",
    text: "分析附件",
    attachments: [{
      index: 0,
      type: "file",
      name: "report_.txt",
      size: 11,
      available: true
    }]
  });
  const attachment = await manager.getSessionAttachment("account-one", session.id, "user-1", 0);
  assert.equal(fs.readFileSync(attachment.path, "utf8"), "report body");
  assert.equal(attachment.path.startsWith(path.join(root, "inbound", "account-one", "web", session.id)), true);
});

test("reports a managed session as responding only while its Web turn is active", async (t) => {
  const { manager, root, setRunHandler } = setup(t);
  let finish: ((value: { raw: string; text: string; threadId: string }) => void) | undefined;
  setRunHandler(() => new Promise((resolve) => {
    finish = resolve;
  }));
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Busy chat");

  const pending = manager.continueSession("account-one", session.id, "继续");
  assert.equal(manager.listSessions().find((item) => item.id === session.id)?.responding, true);
  finish?.({ raw: "", text: "完成", threadId: "thread-busy" });
  await pending;
  assert.equal(manager.listSessions().find((item) => item.id === session.id)?.responding, false);
});

test("exposes files sent by Codex as session attachments", async (t) => {
  const { manager, root, history } = setup(t);
  const videoPath = path.join(root, "demo.mp4");
  fs.writeFileSync(videoPath, "video-bytes");
  const session = manager.createSession("account-one", "alice@im.wechat", root, "Media chat");
  await manager.continueSession("account-one", session.id, "发送视频");
  history.push({
    id: "assistant-video",
    role: "assistant",
    text: `视频已发送。\n\n\`\`\`codex-weixin-actions\n{"send":[{"type":"video","path":${JSON.stringify(videoPath)}}]}\n\`\`\``
  });

  const messages = await manager.getSessionMessages("account-one", session.id);
  assert.deepEqual(messages.at(-1), {
    id: "assistant-video",
    role: "assistant",
    text: "视频已发送。",
    attachments: [{
      index: 0,
      type: "video",
      name: "demo.mp4",
      size: 11,
      available: true
    }]
  });
  assert.equal(
    (await manager.getSessionAttachment("account-one", session.id, "assistant-video", 0)).path,
    videoPath
  );
  await assert.rejects(
    manager.getSessionAttachment("account-one", session.id, "assistant-video", 1),
    /not found/
  );
});
