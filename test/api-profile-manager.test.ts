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
    model: "model-two"
  });
  let config: CodexWeixinConfig = { ...defaultConfig(root), model: first.model, effort: "medium" };
  const events: string[] = [];
  const manager = new ApiProfileManager({
    store,
    fetch: async () => new Response(JSON.stringify({ id: "resp_1", output: [] }), { status: 200 }),
    writeProviderConfig: (profile) => events.push(`write:${profile.name}`),
    loadConfig: () => ({ ...config }),
    saveConfig: (next) => { config = { ...next }; events.push(`save:${next.model}`); },
    restartRuntime: async () => { events.push("restart"); },
    readRuntime: async () => { events.push(`verify:${config.model}`); return { model: config.model, provider: "codex_local_access" }; },
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
  assert.deepEqual(events, ["write:Backup", "save:model-two", "restart", "verify:model-two"]);
});

test("rolls back profile, generated config, selected model, and runtime on activation failure", async (t) => {
  let restarts = 0;
  const { manager, store, first, second, events, getConfig } = await fixture(t, {
    restartRuntime: async () => {
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
  assert.deepEqual(events, [
    "write:Backup", "save:model-two", "restart",
    "write:Primary", "save:model-one", "restart"
  ]);
});
