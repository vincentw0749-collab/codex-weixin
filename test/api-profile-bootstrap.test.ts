import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initializeApiProfiles } from "../src/server/api-profile-bootstrap.js";
import type { SecretProtector } from "../src/security/dpapi.js";
import { defaultConfig, loadConfig, saveConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";

class FakeProtector implements SecretProtector {
  async protect(secret: string): Promise<string> { return Buffer.from(secret).toString("base64"); }
  async unprotect(ciphertext: string): Promise<string> { return Buffer.from(ciphertext, "base64").toString("utf8"); }
}

test("imports the working API once and selects the profile-aware wrapper", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-profile-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(path.join(root, "state"));
  const globalCodexHome = path.join(root, ".codex");
  fs.mkdirSync(paths.codexHomeDir, { recursive: true });
  fs.mkdirSync(globalCodexHome, { recursive: true });
  fs.writeFileSync(path.join(paths.codexHomeDir, "config.toml"), [
    'model = "gpt-5.6-terra"',
    'model_reasoning_effort = "medium"',
    '[model_providers.codex_local_access]',
    'name = "Working API"',
    'base_url = "https://working.example/v1"'
  ].join("\n"));
  fs.writeFileSync(path.join(globalCodexHome, "config.toml"), 'experimental_bearer_token = "existing-key"\n');
  saveConfig(paths, { ...defaultConfig(root), model: "old-model", codexBin: "old-wrapper" });
  const wrapperPath = path.join(root, "profile-wrapper.mjs");
  const accountManager = {
    async restartRunning() {},
    async verifyCodexRuntime() { return { model: "gpt-5.6-terra", provider: "codex_local_access" }; }
  };

  const first = await initializeApiProfiles({
    paths,
    accountManager: accountManager as never,
    protector: new FakeProtector(),
    globalCodexHome,
    wrapperPath,
    fetch: async () => new Response(JSON.stringify({ id: "resp", output: [] }))
  });
  const second = await initializeApiProfiles({
    paths,
    accountManager: accountManager as never,
    protector: new FakeProtector(),
    globalCodexHome,
    wrapperPath,
    fetch: async () => new Response(JSON.stringify({ id: "resp", output: [] }))
  });

  assert.equal(first.list().length, 1);
  assert.equal(second.list().length, 1);
  assert.equal(first.getActive()?.name, "Working API");
  assert.equal(loadConfig(paths).model, "gpt-5.6-terra");
  assert.equal(loadConfig(paths).codexBin, wrapperPath);
  assert.equal(await fs.promises.readFile(paths.apiProfilesPath, "utf8").then((value) => value.includes("existing-key")), false);
  assert.doesNotMatch(fs.readFileSync(path.join(paths.codexHomeDir, "config.toml"), "utf8"), /existing-key/);
});
