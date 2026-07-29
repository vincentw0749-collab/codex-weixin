import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ApiProfileStore } from "../src/state/api-profiles.js";
import { resolveStatePaths } from "../src/state/paths.js";
import type { SecretProtector } from "../src/security/dpapi.js";

class FakeProtector implements SecretProtector {
  async protect(secret: string): Promise<string> {
    return `cipher:${Buffer.from(secret).toString("base64")}`;
  }

  async unprotect(ciphertext: string): Promise<string> {
    if (!ciphertext.startsWith("cipher:")) throw new Error("invalid ciphertext");
    return Buffer.from(ciphertext.slice(7), "base64").toString("utf8");
  }
}

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-profiles-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  return { paths, store: new ApiProfileStore(paths, new FakeProtector()) };
}

test("creates normalized profiles and redacts all secret material", async (t) => {
  const { paths, store } = fixture(t);
  const created = await store.create({
    name: "  Primary  ",
    baseUrl: "https://api.example/v1///",
    apiKey: "sk-private",
    model: "  gpt-5.6-terra "
  });

  assert.equal(created.name, "Primary");
  assert.equal(created.baseUrl, "https://api.example/v1");
  assert.equal(created.model, "gpt-5.6-terra");
  assert.equal(created.hasApiKey, true);
  assert.equal(created.active, true);
  assert.equal(await store.readSecret(created.id), "sk-private");
  assert.doesNotMatch(JSON.stringify(store.list()), /sk-private|cipher:/);
  const persisted = fs.readFileSync(paths.apiProfilesPath, "utf8");
  assert.doesNotMatch(persisted, /sk-private/);
  assert.match(persisted, /cipher:/);
});

test("validates names, URLs, models, keys, and case-insensitive uniqueness", async (t) => {
  const { store } = fixture(t);
  await store.create({ name: "Primary", baseUrl: "http://127.0.0.1:8317/v1", apiKey: "key", model: "model" });

  await assert.rejects(
    store.create({ name: " primary ", baseUrl: "https://other.test/v1", apiKey: "key", model: "model" }),
    /name already exists/i
  );
  await assert.rejects(
    store.create({ name: "Bad URL", baseUrl: "ftp://example.test/v1", apiKey: "key", model: "model" }),
    /http/i
  );
  await assert.rejects(
    store.create({ name: "Credentials", baseUrl: "https://user:pass@example.test/v1", apiKey: "key", model: "model" }),
    /credentials/i
  );
  await assert.rejects(
    store.create({ name: "No key", baseUrl: "https://example.test/v1", apiKey: "", model: "model" }),
    /API key/i
  );
  await assert.rejects(
    store.create({ name: "No model", baseUrl: "https://example.test/v1", apiKey: "key", model: "  " }),
    /model/i
  );
});

test("edits metadata while a blank key preserves the encrypted key", async (t) => {
  const { paths, store } = fixture(t);
  const created = await store.create({ name: "Primary", baseUrl: "https://api.example/v1", apiKey: "first-key", model: "old-model" });
  const before = JSON.parse(fs.readFileSync(paths.apiProfilesPath, "utf8")).profiles[0].encryptedApiKey;

  const updated = await store.update(created.id, { name: "Updated", model: "new-model", apiKey: "" });
  const after = JSON.parse(fs.readFileSync(paths.apiProfilesPath, "utf8")).profiles[0].encryptedApiKey;

  assert.equal(updated.name, "Updated");
  assert.equal(updated.model, "new-model");
  assert.equal(before, after);
  assert.equal(await store.readSecret(created.id), "first-key");
});

test("activates profiles and guards active or final profile deletion", async (t) => {
  const { store } = fixture(t);
  const first = await store.create({ name: "Primary", baseUrl: "https://one.test/v1", apiKey: "one", model: "one-model" });
  const second = await store.create({ name: "Backup", baseUrl: "https://two.test/v1", apiKey: "two", model: "two-model" });

  await assert.rejects(store.delete(first.id), /active profile/i);
  await store.activate(second.id);
  await store.delete(first.id);
  assert.equal(store.list().length, 1);
  await assert.rejects(store.delete(second.id), /last profile/i);
});

test("serializes concurrent mutations and persists valid JSON", async (t) => {
  const { paths, store } = fixture(t);
  await Promise.all(Array.from({ length: 8 }, (_, index) => store.create({
    name: `Profile ${index}`,
    baseUrl: `https://api${index}.example/v1`,
    apiKey: `key-${index}`,
    model: `model-${index}`
  })));

  assert.equal(store.list().length, 8);
  assert.equal(JSON.parse(fs.readFileSync(paths.apiProfilesPath, "utf8")).profiles.length, 8);
});

test("migrates one seed exactly once", async (t) => {
  const { paths, store } = fixture(t);
  const seed = { name: "Current API", baseUrl: "http://127.0.0.1:8317/v1", apiKey: "existing", model: "gpt-5.6-terra" };

  await store.ensureMigrated(seed);
  await store.ensureMigrated({ ...seed, name: "Ignored" });

  assert.equal(store.list().length, 1);
  assert.equal(store.getActive()?.name, "Current API");
  assert.equal(await store.readSecret(store.getActive()!.id), "existing");
  assert.equal(JSON.parse(fs.readFileSync(paths.apiProfilesPath, "utf8")).version, 1);
});

test("refuses corrupt profile storage without replacing it", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-profiles-corrupt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  fs.writeFileSync(paths.apiProfilesPath, "{broken", "utf8");

  assert.throws(() => new ApiProfileStore(paths, new FakeProtector()), /storage is invalid/i);
  assert.equal(fs.readFileSync(paths.apiProfilesPath, "utf8"), "{broken");
});
