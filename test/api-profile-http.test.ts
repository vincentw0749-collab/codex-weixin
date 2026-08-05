import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AccountManager } from "../src/server/account-manager.js";
import { ApiProfileManager } from "../src/server/api-profile-manager.js";
import { startLocalHttpServer } from "../src/server/http-server.js";
import type { SecretProtector } from "../src/security/dpapi.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/state/config.js";
import { ApiProfileStore } from "../src/state/api-profiles.js";
import { resolveStatePaths } from "../src/state/paths.js";

class FakeProtector implements SecretProtector {
  async protect(secret: string): Promise<string> { return `encrypted:${secret}`; }
  async unprotect(ciphertext: string): Promise<string> { return ciphertext.slice("encrypted:".length); }
}

test("API profile routes are authenticated, redacted, and refresh activation state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-profile-http-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  saveConfig(paths, { ...defaultConfig(root), model: "model-one" });
  const store = new ApiProfileStore(paths, new FakeProtector());
  const first = await store.create({ name: "Primary", baseUrl: "https://one.example/v1", apiKey: "secret-one", model: "model-one" });
  await store.activate(first.id);
  const profileManager = new ApiProfileManager({
    store,
    fetch: async () => new Response(JSON.stringify({ id: "resp_test", output: [] }), { status: 200 }),
    writeProviderConfig: () => undefined,
    loadConfig: () => loadConfig(paths),
    saveConfig: (config) => saveConfig(paths, config),
    restartRuntime: async (prepare) => { await prepare?.(); },
    readRuntime: async () => ({ model: loadConfig(paths).model, provider: "codex_local_access" })
  });
  const server = await startLocalHttpServer({
    paths,
    accountManager: new AccountManager({ paths }),
    apiProfileManager: profileManager,
    codexCheck: async () => ({ ready: true }),
    codexRuntimeCheck: async () => ({ model: loadConfig(paths).model }),
    codexModelsCheck: async () => [],
    port: 0
  });
  t.after(() => server.close());
  const headers = {
    "Content-Type": "application/json",
    "X-Codex-Weixin-Token": server.requestToken,
    Origin: server.url
  };

  const bootstrap = await (await fetch(`${server.url}/api/bootstrap`)).json() as Record<string, unknown>;
  assert.equal((bootstrap.apiProfiles as Array<{ id: string }>)[0].id, first.id);
  assert.equal(bootstrap.activeApiProfileId, first.id);
  assert.doesNotMatch(JSON.stringify(bootstrap), /secret-one|encrypted:/);
  const page = await (await fetch(server.url)).text();
  for (const id of [
    "apiProfilesList",
    "addApiProfileButton",
    "apiProfileDialog",
    "apiProfileForm",
    "apiProfileNameInput",
    "apiProfileBaseUrlInput",
    "apiProfileKeyInput",
    "apiProfileModelInput",
    "toggleApiProfileKeyButton",
    "saveApiProfileButton",
    "saveActivateApiProfileButton"
  ]) {
    assert.match(page, new RegExp(`id="${id}"`));
  }

  const unauthorized = await fetch(`${server.url}/api/api-profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Codex-Weixin-Token": server.requestToken },
    body: JSON.stringify({ name: "Blocked", baseUrl: "https://blocked.test/v1", apiKey: "blocked-key", model: "blocked-model" })
  });
  assert.equal(unauthorized.status, 403);

  const createdResponse = await fetch(`${server.url}/api/api-profiles`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Backup", baseUrl: "https://two.example/v1/", apiKey: "secret-two", model: "model-two" })
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json() as { profile: { id: string; baseUrl: string } }).profile;
  assert.equal(created.baseUrl, "https://two.example/v1");
  assert.doesNotMatch(JSON.stringify(created), /secret-two|encrypted:/);

  const editedResponse = await fetch(`${server.url}/api/api-profiles/${created.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: "Backup edited", effort: "max", apiKey: "" })
  });
  assert.equal(editedResponse.status, 200);
  assert.equal(await store.readSecret(created.id), "secret-two");
  assert.equal(store.list().find((profile) => profile.id === created.id)?.effort, "max");

  const tested = await fetch(`${server.url}/api/api-profiles/${created.id}/test`, { method: "POST", headers });
  assert.equal(tested.status, 200);
  assert.equal((await tested.json() as { ok: boolean }).ok, true);

  const activated = await fetch(`${server.url}/api/api-profiles/${created.id}/activate`, { method: "POST", headers });
  assert.equal(activated.status, 200);
  const activatedBody = await activated.json() as {
    activeApiProfileId: string;
    config: { model: string; effort: string };
    codexRuntime: { model: string; effort?: string };
  };
  assert.equal(activatedBody.activeApiProfileId, created.id);
  assert.equal(activatedBody.config.model, "model-two");
  assert.equal(activatedBody.config.effort, "max");
  assert.equal(activatedBody.codexRuntime.model, "model-two");
  assert.doesNotMatch(JSON.stringify(activatedBody), /secret-two|encrypted:/);

  const activeDelete = await fetch(`${server.url}/api/api-profiles/${created.id}`, { method: "DELETE", headers });
  assert.equal(activeDelete.status, 409);
  const deleted = await fetch(`${server.url}/api/api-profiles/${first.id}`, { method: "DELETE", headers });
  assert.equal(deleted.status, 200);
  assert.equal(profileManager.list().length, 1);

  const listed = await fetch(`${server.url}/api/api-profiles`);
  assert.equal(listed.status, 200);
  assert.doesNotMatch(await listed.text(), /secret-two|encrypted:/);
});

test("API profile activation requires confirmation before interrupting active tasks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-profile-http-confirm-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  saveConfig(paths, { ...defaultConfig(root), model: "model-one" });
  const store = new ApiProfileStore(paths, new FakeProtector());
  const first = await store.create({ name: "Primary", baseUrl: "https://one.example/v1", apiKey: "secret-one", model: "model-one" });
  const second = await store.create({ name: "Backup", baseUrl: "https://two.example/v1", apiKey: "secret-two", model: "model-two" });
  await store.activate(first.id);
  const accountManager = new AccountManager({ paths });
  accountManager.getActiveTaskCount = () => 2;
  const restartOptions: Array<{ interruptActiveTasks?: boolean } | undefined> = [];
  const profileManager = new ApiProfileManager({
    store,
    fetch: async () => new Response(JSON.stringify({ id: "resp_test", output: [] }), { status: 200 }),
    writeProviderConfig: () => undefined,
    loadConfig: () => loadConfig(paths),
    saveConfig: (config) => saveConfig(paths, config),
    restartRuntime: async (prepare, options) => {
      restartOptions.push(options);
      await prepare?.();
    },
    getActiveTaskCount: () => accountManager.getActiveTaskCount(),
    readRuntime: async () => ({ model: loadConfig(paths).model, provider: "codex_local_access" })
  });
  const server = await startLocalHttpServer({
    paths,
    accountManager,
    apiProfileManager: profileManager,
    codexCheck: async () => ({ ready: true }),
    codexRuntimeCheck: async () => ({ model: loadConfig(paths).model }),
    codexModelsCheck: async () => [],
    port: 0
  });
  t.after(() => server.close());
  const headers = {
    "Content-Type": "application/json",
    "X-Codex-Weixin-Token": server.requestToken,
    Origin: server.url
  };

  const requiresConfirmation = await fetch(`${server.url}/api/api-profiles/${second.id}/activate`, {
    method: "POST",
    headers
  });
  assert.equal(requiresConfirmation.status, 409);
  assert.deepEqual(await requiresConfirmation.json(), {
    error: "检测到 2 个正在执行的任务。是否直接切换？确认后将结束这些任务。",
    code: "ACTIVE_TASKS",
    activeTaskCount: 2
  });
  assert.deepEqual(restartOptions, []);
  assert.equal(store.getActive()?.id, first.id);

  const confirmed = await fetch(`${server.url}/api/api-profiles/${second.id}/activate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ interruptActiveTasks: true })
  });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(restartOptions, [{ interruptActiveTasks: true }]);
  assert.equal(store.getActive()?.id, second.id);
});
