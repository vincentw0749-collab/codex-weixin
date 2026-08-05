import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ApiProfileManager } from "../src/server/api-profile-manager.js";
import type { SecretProtector } from "../src/security/dpapi.js";
import { defaultConfig, type CodexWeixinConfig } from "../src/state/config.js";
import { ApiProfileStore } from "../src/state/api-profiles.js";
import { resolveStatePaths } from "../src/state/paths.js";

class FakeProtector implements SecretProtector {
  async protect(secret: string): Promise<string> { return `encrypted:${secret}`; }
  async unprotect(ciphertext: string): Promise<string> { return ciphertext.slice("encrypted:".length); }
}

async function fixture(t: test.TestContext, overrides: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-profile-manager-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const store = new ApiProfileStore(paths, new FakeProtector());
  const first = await store.create({
    name: "Primary",
    baseUrl: "https://one.example/v1",
    apiKey: "secret-one",
    model: "model-one"
  });
  const second = await store.create({
    name: "Backup",
    baseUrl: "https://two.example/v1",
    apiKey: "secret-two",
    model: "model-two",
    effort: "max"
  });
  await store.activate(first.id);
  let config: CodexWeixinConfig = { ...defaultConfig(root), model: first.model, effort: "medium" };
  const events: string[] = [];
  const manager = new ApiProfileManager({
    store,
    fetch: async () => new Response(JSON.stringify({ id: "resp_1", output: [] }), { status: 200 }),
    writeProviderConfig: (profile) => events.push(`write:${profile.name}`),
    loadConfig: () => ({ ...config }),
    saveConfig: (next) => { config = { ...next }; events.push(`save:${next.model}:${next.effort}`); },
    restartRuntime: async (prepare) => {
      await prepare?.();
      events.push("restart");
    },
    readRuntime: async () => {
      events.push(`verify:${config.model}:${config.effort}`);
      return { model: config.model, effort: config.effort, provider: "codex_local_access" };
    },
    resetSessionRuntimeOverrides: () => events.push("reset-overrides"),
    ...overrides
  });
  return { store, first, second, manager, events, getConfig: () => config };
}

test("tests a saved profile using a bounded Responses request", async (t) => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const { manager, second } = await fixture(t, {
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({ id: "resp_1", output: [] }), { status: 200 });
    }
  });

  const result = await manager.test(second.id);

  assert.equal(requestUrl, "https://two.example/v1/responses");
  assert.equal(requestInit?.method, "POST");
  assert.equal((requestInit?.headers as Record<string, string>).Authorization, "Bearer secret-two");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    model: "model-two",
    input: "Reply with OK.",
    max_output_tokens: 16,
    stream: false
  });
  assert.equal(result.ok, true);
  assert.equal(requestInit?.signal instanceof AbortSignal, true);
});

test("lists only the final four API key characters for display", async (t) => {
  const { manager } = await fixture(t);

  const profiles = await manager.listForDisplay();

  assert.deepEqual(profiles.map(({ name, apiKeyLastFour }) => ({ name, apiKeyLastFour })), [
    { name: "Primary", apiKeyLastFour: "-one" },
    { name: "Backup", apiKeyLastFour: "-two" }
  ]);
  assert.doesNotMatch(JSON.stringify(profiles), /secret-one|secret-two/);
});

test("verifies a new profile before storing it", async (t) => {
  let authorization = "";
  const { manager, store } = await fixture(t, {
    fetch: async (_input: string | URL | Request, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ id: "resp_verified", output: [] }), { status: 200 });
    }
  });

  const before = store.list().length;
  const result = await manager.createVerified({
    name: "Verified",
    baseUrl: "https://verified.example/v1/",
    apiKey: "secret-verified",
    model: "model-verified"
  });

  assert.equal(authorization, "Bearer secret-verified");
  assert.equal(store.list().length, before + 1);
  assert.equal(result.profile.baseUrl, "https://verified.example/v1");
  assert.equal(result.profile.active, false);
});

test("does not store a new profile when verification fails", async (t) => {
  const { manager, store } = await fixture(t, {
    fetch: async () => new Response("do not expose this", { status: 401 })
  });
  const before = store.list().length;

  await assert.rejects(manager.createVerified({
    name: "Rejected",
    baseUrl: "https://rejected.example/v1",
    apiKey: "secret-rejected",
    model: "model-rejected"
  }), (error: Error) => /authentication/i.test(error.message) && !error.message.includes("secret-rejected"));

  assert.equal(store.list().length, before);
});

test("sanitizes authentication, endpoint, timeout, and protocol errors", async (t) => {
  for (const [response, pattern] of [
    [new Response("secret response body", { status: 401 }), /authentication/i],
    [new Response("route details", { status: 404 }), /Responses endpoint/i],
    [new Response("not json", { status: 200 }), /invalid Responses/i]
  ] as const) {
    const { manager, first } = await fixture(t, { fetch: async () => response });
    await assert.rejects(manager.test(first.id), (error: Error) =>
      pattern.test(error.message) && !/secret response body|route details|not json/.test(error.message)
    );
  }

  const timeout = new DOMException("provider leaked detail", "TimeoutError");
  const { manager, first } = await fixture(t, { fetch: async () => { throw timeout; } });
  await assert.rejects(manager.test(first.id), (error: Error) =>
    /timed out/i.test(error.message) && !error.message.includes(timeout.message)
  );
});

test("activates only after testing and verifies the restarted runtime", async (t) => {
  const { manager, store, second, events, getConfig } = await fixture(t);

  const result = await manager.activate(second.id);

  assert.equal(result.active, true);
  assert.equal(store.getActive()?.id, second.id);
  assert.equal(getConfig().model, "model-two");
  assert.equal(getConfig().effort, "max");
  assert.deepEqual(events, [
    "save:model-two:max", "write:Backup", "restart", "verify:model-two:max", "reset-overrides"
  ]);
});

test("uses an interrupting runtime restart for a confirmed API activation", async (t) => {
  const { manager, second, events } = await fixture(t, {
    restartRuntime: async (prepare?: () => Promise<void> | void, options?: { interruptActiveTasks?: boolean }) => {
      await prepare?.();
      events.push(`restart:${options?.interruptActiveTasks ? "interrupt" : "wait"}`);
    }
  });

  await manager.activate(second.id, { interruptActiveTasks: true });

  assert.deepEqual(events, [
    "save:model-two:max", "write:Backup", "restart:interrupt", "verify:model-two:max", "reset-overrides"
  ]);
});

test("establishes the runtime switch barrier before testing a confirmed API activation", async (t) => {
  const { manager, second, events } = await fixture(t, {
    fetch: async () => {
      events.push("probe");
      return new Response(JSON.stringify({ id: "resp_1", output: [] }), { status: 200 });
    },
    restartRuntime: async (prepare?: () => Promise<void> | void) => {
      events.push("restart:begin");
      await prepare?.();
      events.push("restart:end");
    }
  });

  await manager.activate(second.id, { interruptActiveTasks: true });

  assert.deepEqual(events.slice(0, 2), ["restart:begin", "probe"]);
});

test("preserves API probe failures when activation has not changed the active profile", async (t) => {
  const { manager, store, first, second } = await fixture(t, {
    fetch: async () => new Response("", { status: 401 })
  });

  await assert.rejects(manager.activate(second.id, { interruptActiveTasks: true }), (error: Error & { code?: string }) =>
    error.code === "VALIDATION" && /authentication failed/i.test(error.message)
  );

  assert.equal(store.getActive()?.id, first.id);
});

test("rolls back profile, generated config, selected model, and runtime on activation failure", async (t) => {
  let restarts = 0;
  const { manager, store, first, second, events, getConfig } = await fixture(t, {
    restartRuntime: async (prepare) => {
      await prepare?.();
      restarts += 1;
      events.push("restart");
      if (restarts === 1) throw new Error("new runtime failed with secret-two");
    }
  });

  await assert.rejects(manager.activate(second.id), (error: Error) =>
    /previous API remains active/i.test(error.message) && !error.message.includes("secret-two")
  );

  assert.equal(store.getActive()?.id, first.id);
  assert.equal(getConfig().model, "model-one");
  assert.equal(getConfig().effort, "medium");
  assert.deepEqual(events, [
    "save:model-two:max", "write:Backup", "restart",
    "save:model-one:medium", "write:Primary", "restart"
  ]);
});

test("updates and applies defaults for the active API profile", async (t) => {
  const { manager, store, first, events, getConfig } = await fixture(t);

  const updated = await manager.setDefaults(first.id, "gpt-5.6-sol", "max");

  assert.equal(updated.model, "gpt-5.6-sol");
  assert.equal(updated.effort, "max");
  assert.equal(store.getActive()?.model, "gpt-5.6-sol");
  assert.equal(store.getActive()?.effort, "max");
  assert.equal(getConfig().model, "gpt-5.6-sol");
  assert.equal(getConfig().effort, "max");
  assert.deepEqual(events, [
    "save:gpt-5.6-sol:max", "write:Primary", "restart", "verify:gpt-5.6-sol:max", "reset-overrides"
  ]);
});

test("validates active API defaults before an interrupting runtime restart", async (t) => {
  let restartCalls = 0;
  const { manager, store, first, getConfig } = await fixture(t, {
    restartRuntime: async (prepare?: () => Promise<void> | void) => {
      restartCalls += 1;
      await prepare?.();
    }
  });

  await assert.rejects(
    manager.setDefaults(first.id, "gpt-5.6-terra", "not-an-effort", { interruptActiveTasks: true }),
    /Reasoning effort must be one of/i
  );

  assert.equal(restartCalls, 0);
  assert.equal(store.getActive()?.model, "model-one");
  assert.equal(store.getActive()?.effort, "medium");
  assert.equal(getConfig().model, "model-one");
  assert.equal(getConfig().effort, "medium");
});

test("stores defaults for an inactive API without restarting", async (t) => {
  const { manager, second, events } = await fixture(t);

  const updated = await manager.setDefaults(second.id, "gpt-5.6-luna", "high");

  assert.equal(updated.model, "gpt-5.6-luna");
  assert.equal(updated.effort, "high");
  assert.deepEqual(events, []);
});

test("serializes active defaults and activation until each runtime barrier applies its transaction", async (t) => {
  let enterFirstBarrier!: () => void;
  let releaseFirstBarrier!: () => void;
  const firstBarrierEntered = new Promise<void>((resolve) => { enterFirstBarrier = resolve; });
  const releaseBarrier = new Promise<void>((resolve) => { releaseFirstBarrier = resolve; });
  let restartCount = 0;
  const { manager, store, first, second, events, getConfig } = await fixture(t, {
    restartRuntime: async (prepare?: () => Promise<void> | void) => {
      restartCount += 1;
      if (restartCount === 1) {
        events.push("barrier:defaults");
        enterFirstBarrier();
        await releaseBarrier;
      }
      await prepare?.();
      events.push(`restart:${restartCount}`);
    }
  });

  const defaults = manager.setDefaults(first.id, "gpt-5.6-sol", "max");
  await firstBarrierEntered;
  const activation = manager.activate(second.id);

  assert.equal(store.getActive()?.id, first.id);
  assert.equal(store.getActive()?.model, "model-one");
  assert.equal(getConfig().model, "model-one");

  releaseFirstBarrier();
  await Promise.all([defaults, activation]);

  assert.equal(store.getActive()?.id, second.id);
  assert.equal(getConfig().model, second.model);
  assert.deepEqual(events, [
    "barrier:defaults", "save:gpt-5.6-sol:max", "write:Primary", "restart:1",
    "verify:gpt-5.6-sol:max", "reset-overrides",
    "save:model-two:max", "write:Backup", "restart:2", "verify:model-two:max", "reset-overrides"
  ]);
});

test("applies active profile updates as one runtime transaction", async (t) => {
  const { manager, store, first, events, getConfig } = await fixture(t);

  const updated = await manager.update(first.id, {
    name: "Primary updated",
    baseUrl: "https://updated.example/v1",
    model: "gpt-5.6-terra",
    effort: "high"
  });

  assert.equal(updated.active, true);
  assert.equal(store.getActive()?.model, "gpt-5.6-terra");
  assert.equal(getConfig().model, "gpt-5.6-terra");
  assert.equal(getConfig().effort, "high");
  assert.deepEqual(events, [
    "save:gpt-5.6-terra:high", "write:Primary updated", "restart", "verify:gpt-5.6-terra:high", "reset-overrides"
  ]);
});
