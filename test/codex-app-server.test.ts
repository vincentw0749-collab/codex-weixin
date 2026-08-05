import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isUnclassifiedMessageHandlingError } from "../src/bridge/errors.js";
import { AppServerCodexRunner } from "../src/codex/app-server-runner.js";
import { HybridCodexRunner } from "../src/codex/runner.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("uses the Codex V2 initialize, thread, and turn lifecycle", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const deltas: string[] = [];
  const progress: string[] = [];
  const first = await runner.run({
    prompt: "first",
    cwd: "/tmp/project",
    model: "test-model",
    effort: "high",
    onDelta: async (delta) => {
      deltas.push(delta);
    },
    onProgress: async (message) => {
      progress.push(message);
    }
  });
  assert.equal(first.threadId, "thread-new");
  assert.equal(first.text, "reply:first");
  assert.deepEqual(deltas, ["reply:", "first"]);
  assert.deepEqual(progress, ["working:first"]);
  assert.match(first.raw, /item\/completed/);
  assert.match(first.raw, /turn\/completed/);
  assert.deepEqual(await runner.getRuntimeInfo("/tmp/project", "thread-new"), {
    model: "test-model",
    effort: "high"
  });

  const resumed = await runner.run({
    prompt: "second",
    cwd: "/tmp/project",
    threadId: "thread-existing"
  });
  assert.equal(resumed.threadId, "thread-existing");
  assert.equal(resumed.text, "reply:second");
  assert.deepEqual(await runner.getRuntimeInfo("/tmp/project", "thread-existing"), {
    model: "resumed-model",
    effort: "medium"
  });

  assert.deepEqual(await runner.listSessions(), {
    data: [{ id: "thread-new" }],
    nextCursor: null,
    backwardsCursor: null
  });

  assert.deepEqual(await runner.getHistory("thread-existing"), [
    {
      id: "history-user-1",
      role: "user",
      text: "hello history",
      createdAt: "2023-11-14T22:13:20.000Z"
    },
    {
      id: "history-commentary-1",
      role: "assistant",
      text: "working",
      kind: "progress",
      createdAt: "2023-11-14T22:13:22.000Z"
    },
    {
      id: "history-assistant-1",
      role: "assistant",
      text: "history reply",
      createdAt: "2023-11-14T22:13:22.000Z"
    }
  ]);

  assert.deepEqual(await runner.getRuntimeInfo("/tmp/another-project"), {
    model: "configured-model",
    effort: "high",
    provider: "FixtureProvider"
  });
  assert.deepEqual(await runner.listModels(), [{
    model: "configured-model",
    displayName: "Configured Model",
    description: "Model used by the test fixture.",
    isDefault: true,
    defaultEffort: "medium",
    supportedEfforts: [
      { effort: "medium", description: "Balanced" },
      { effort: "high", description: "Deeper reasoning" }
    ]
  }]);
});

test("interrupts the active V2 turn with both threadId and turnId", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const run = runner.run({ prompt: "hold", cwd: "/tmp/project", threadId: "thread-stop" });
  const outcome = run.then(
    (value) => ({ value, error: undefined }),
    (error: Error) => ({ value: undefined, error })
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    await runner.stop("thread-stop");
  }
  const result = await outcome;
  assert.match(result.error?.message ?? "", /interrupted/i);
});

test("bounds an unresponsive turn interrupt", { timeout: 1_000 }, async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    interruptTimeoutMs: 20
  } as never);
  t.after(() => runner.close());

  let signalThreadStarted!: () => void;
  const threadStarted = new Promise<void>((resolve) => {
    signalThreadStarted = resolve;
  });
  const run = runner.run({
    prompt: "unresponsive-interrupt",
    cwd: "/tmp/project",
    threadId: "thread-stop-unresponsive",
    onThreadStarted: signalThreadStarted
  });
  await threadStarted;
  await new Promise((resolve) => setTimeout(resolve, 20));

  let interruptError: unknown;
  try {
    await runner.stop("thread-stop-unresponsive");
  } catch (error) {
    interruptError = error;
  }
  runner.close();
  await assert.rejects(run, /runner closed|turn\/interrupt timed out/i);

  assert.match(String(interruptError), /turn\/interrupt timed out/i);
});

test("automatically grants command, file, and requested permissions for the session", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000
  });
  t.after(() => runner.close());

  const result = await runner.run({ prompt: "approval", cwd: "/tmp/project" });

  assert.equal(result.text, "reply:approval");
});

test("does not apply the request timeout to a running turn", async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 200
  });
  t.after(() => runner.close());

  const result = await runner.run({ prompt: "slow", cwd: "/tmp/project" });

  assert.equal(result.text, "reply:slow");
});

test("recovers a completed turn when the app-server misses turn/completed", { timeout: 3_000 }, async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000,
    turnStallTimeoutMs: 20,
    turnProbeTimeoutMs: 100
  });
  t.after(() => runner.close());

  const result = await runner.run({ prompt: "missing-completion", cwd: "/tmp/project" });

  assert.equal(result.threadId, "thread-new");
  assert.equal(result.text, "reply:missing-completion");
});

test("keeps a turn alive when a stall probe confirms it is still running", { timeout: 1_000 }, async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000,
    turnStallTimeoutMs: 20,
    turnProbeTimeoutMs: 100
  });
  t.after(() => runner.close());

  const result = await runner.run({ prompt: "in-progress", cwd: "/tmp/project" });

  assert.equal(result.text, "reply:in-progress");
});

test("classifies an unresponsive stall probe for same-thread recovery", { timeout: 1_000 }, async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000,
    turnStallTimeoutMs: 20,
    turnProbeTimeoutMs: 20
  });
  t.after(() => runner.close());

  await assert.rejects(
    runner.run({ prompt: "unresponsive-probe", cwd: "/tmp/project" }),
    (error: unknown) => {
      assert.match(String(error), /app-server request thread\/read timed out/);
      assert.equal(isUnclassifiedMessageHandlingError(error), true);
      return true;
    }
  );
});

test("does not let a stuck progress callback block the final result", { timeout: 1_000 }, async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000,
    streamCallbackTimeoutMs: 20
  });
  t.after(() => runner.close());

  const result = await runner.run({
    prompt: "stuck-progress",
    cwd: "/tmp/project",
    onProgress: () => new Promise<void>(() => {})
  });

  assert.equal(result.text, "reply:stuck-progress");
});

test("does not queue stalled progress callbacks ahead of the final result", { timeout: 1_000 }, async (t) => {
  const runner = new AppServerCodexRunner({
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    requestTimeoutMs: 2_000,
    streamCallbackTimeoutMs: 30
  });
  t.after(() => runner.close());

  await runner.listSessions();
  const startedAt = Date.now();
  const result = await runner.run({
    prompt: "stuck-progress-queue",
    cwd: "/tmp/project",
    onProgress: () => new Promise<void>(() => {})
  });

  assert.equal(result.text, "reply:stuck-progress-queue");
  assert.ok(Date.now() - startedAt < 90, "final result waited behind queued progress callbacks");
});

test("auto backend falls back to codex exec for an existing thread", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "auto",
    codexBin: path.join(fixturesDir, "fake-codex-fallback.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());

  const result = await runner.run({
    prompt: "continue",
    cwd: fixturesDir,
    threadId: "thread-existing"
  });

  assert.equal(result.threadId, "thread-existing");
  assert.match(result.text, /used codex exec fallback/i);
  assert.match(result.text, /exec-resumed/);
});

test("does not fall back to exec after the hybrid runner is closed", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "auto",
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());

  let signalThreadStarted!: () => void;
  const threadStarted = new Promise<void>((resolve) => {
    signalThreadStarted = resolve;
  });
  const turn = runner.run({
    prompt: "hold",
    cwd: fixturesDir,
    threadId: "thread-close-fallback",
    onThreadStarted: signalThreadStarted
  });
  await threadStarted;
  await new Promise((resolve) => setTimeout(resolve, 20));

  runner.close();

  await assert.rejects(turn, /runner is closed/i);
});

test("exec backend uses app-server when true streaming is requested", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "exec",
    codexBin: path.join(fixturesDir, "fake-codex-app-server.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());
  const deltas: string[] = [];

  const result = await runner.run({
    prompt: "stream",
    cwd: fixturesDir,
    onDelta: (delta) => {
      deltas.push(delta);
    }
  });

  assert.deepEqual(deltas, ["reply:", "stream"]);
  assert.equal(result.text, "reply:stream");
});

test("streaming fallback to exec sends only the final answer", async (t) => {
  const runner = new HybridCodexRunner({
    backend: "exec",
    codexBin: path.join(fixturesDir, "fake-codex-fallback.mjs"),
    timeoutMs: 2_000
  });
  t.after(() => runner.close());
  const deltas: string[] = [];

  const result = await runner.run({
    prompt: "stream",
    cwd: fixturesDir,
    onDelta: (delta) => {
      deltas.push(delta);
    }
  });

  assert.deepEqual(deltas, []);
  assert.match(result.text, /used codex exec fallback/i);
  assert.match(result.text, /exec-new/);
});
