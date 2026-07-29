import os from "node:os";
import path from "node:path";

import {
  readLegacyApiProfileSeed,
  readProviderConfigOptions,
  writeProviderConfig
} from "../codex/provider-config.js";
import { WindowsDpapiProtector, type SecretProtector } from "../security/dpapi.js";
import { ApiProfileStore } from "../state/api-profiles.js";
import { loadConfig, saveConfig } from "../state/config.js";
import type { StatePaths } from "../state/paths.js";
import type { AccountManager } from "./account-manager.js";
import { ApiProfileManager } from "./api-profile-manager.js";

export async function initializeApiProfiles(options: {
  paths: StatePaths;
  accountManager: AccountManager;
  wrapperPath: string;
  protector?: SecretProtector;
  globalCodexHome?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}): Promise<ApiProfileManager> {
  const globalCodexHome = options.globalCodexHome ?? path.join(os.homedir(), ".codex");
  const dedicatedConfigPath = path.join(options.paths.codexHomeDir, "config.toml");
  const existingProviderOptions = readProviderConfigOptions(dedicatedConfigPath);
  const store = new ApiProfileStore(options.paths, options.protector ?? new WindowsDpapiProtector());
  await store.ensureMigrated(readLegacyApiProfileSeed({
    dedicatedConfigPath,
    globalConfigPath: path.join(globalCodexHome, "config.toml"),
    env: options.env ?? process.env
  }));

  const providerOptions = () => {
    const config = loadConfig(options.paths);
    return {
      ...existingProviderOptions,
      reasoningEffort: config.effort ?? existingProviderOptions.reasoningEffort ?? "medium",
      trustedWorkspace: config.defaultCwd
    };
  };
  const active = store.getActive();
  if (active) {
    writeProviderConfig(options.paths, active, providerOptions());
    const config = loadConfig(options.paths);
    saveConfig(options.paths, {
      ...config,
      codexBin: path.resolve(options.wrapperPath),
      model: active.model
    });
  }

  return new ApiProfileManager({
    store,
    fetch: options.fetch,
    writeProviderConfig: (profile) => writeProviderConfig(options.paths, profile, providerOptions()),
    loadConfig: () => loadConfig(options.paths),
    saveConfig: (config) => saveConfig(options.paths, config),
    restartRuntime: () => options.accountManager.restartRunning(),
    readRuntime: async () => {
      const model = store.getActive()?.model;
      if (!model) throw new Error("No active API profile is configured");
      return options.accountManager.verifyCodexRuntime(model);
    }
  });
}
