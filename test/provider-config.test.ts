import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readLegacyApiProfileSeed,
  renderProviderConfig,
  writeProviderConfig
} from "../src/codex/provider-config.js";
import { resolveStatePaths } from "../src/state/paths.js";

const profile = {
  id: "profile-1",
  name: "Primary \"API\"",
  baseUrl: "https://api.example/v1",
  model: "gpt-5.6-terra",
  hasApiKey: true,
  active: true,
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z"
};

test("renders a deterministic isolated Responses provider without secrets", () => {
  const toml = renderProviderConfig(profile, {
    instructionsFile: String.raw`C:\Users\Test\.codex\instructions.md`,
    reasoningEffort: "xhigh",
    trustedWorkspace: String.raw`D:\VSCODE\project`
  });

  assert.match(toml, /^model = "gpt-5\.6-terra"/);
  assert.match(toml, /model_reasoning_effort = "xhigh"/);
  assert.match(toml, /model_provider = "codex_local_access"/);
  assert.match(toml, /base_url = "https:\/\/api\.example\/v1"/);
  assert.match(toml, /wire_api = "responses"/);
  assert.match(toml, /env_key = "CODEX_WEIXIN_PROVIDER_KEY"/);
  assert.match(toml, /name = "Primary \\"API\\""/);
  assert.doesNotMatch(toml, /apiKey|encryptedApiKey|sk-private/);
  assert.equal(toml, renderProviderConfig(profile, {
    instructionsFile: String.raw`C:\Users\Test\.codex\instructions.md`,
    reasoningEffort: "xhigh",
    trustedWorkspace: String.raw`D:\VSCODE\project`
  }));
});

test("writes dedicated Codex configuration atomically", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-provider-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);

  writeProviderConfig(paths, profile, { reasoningEffort: "medium" });

  const configPath = path.join(paths.codexHomeDir, "config.toml");
  assert.match(fs.readFileSync(configPath, "utf8"), /model = "gpt-5\.6-terra"/);
  assert.equal(fs.readdirSync(paths.codexHomeDir).filter((name) => name.endsWith(".tmp")).length, 0);
});

test("reads a migration seed from dedicated and global Codex config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-seed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dedicated = path.join(root, "dedicated.toml");
  const global = path.join(root, "global.toml");
  fs.writeFileSync(dedicated, [
    'model = "gpt-5.6-terra"',
    'model_provider = "codex_local_access"',
    '[model_providers.codex_local_access]',
    'name = "Existing API"',
    'base_url = "http://127.0.0.1:8317/v1"',
    'env_key = "CODEX_WEIXIN_PROVIDER_KEY"'
  ].join("\n"));
  fs.writeFileSync(global, 'experimental_bearer_token = "sk-existing"\n');

  assert.deepEqual(readLegacyApiProfileSeed({
    dedicatedConfigPath: dedicated,
    globalConfigPath: global,
    env: {}
  }), {
    name: "Existing API",
    baseUrl: "http://127.0.0.1:8317/v1",
    apiKey: "sk-existing",
    model: "gpt-5.6-terra"
  });
});

test("prefers the configured provider environment key during migration", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-seed-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dedicated = path.join(root, "config.toml");
  fs.writeFileSync(dedicated, [
    'model = "model-one"',
    '[model_providers.codex_local_access]',
    'base_url = "https://api.example/v1"',
    'env_key = "CUSTOM_PROVIDER_KEY"'
  ].join("\n"));

  assert.equal(readLegacyApiProfileSeed({
    dedicatedConfigPath: dedicated,
    globalConfigPath: path.join(root, "missing.toml"),
    env: { CUSTOM_PROVIDER_KEY: "environment-secret" }
  })?.apiKey, "environment-secret");
});
