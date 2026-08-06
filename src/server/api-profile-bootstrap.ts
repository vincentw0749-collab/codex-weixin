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
  browserMcpUrl?: string;
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
    const packageRoot = path.resolve(path.dirname(options.wrapperPath), "..");
    return {
      ...existingProviderOptions,
      instructionsFile: path.join(packageRoot, "resources", "codex-weixin-instructions.md"),
      reasoningEffort: config.effort ?? existingProviderOptions.reasoningEffort ?? "medium",
      trustedWorkspace: config.defaultCwd,
      ...(options.browserMcpUrl ? {
        mcpServers: {
          playwright: {
            url: options.browserMcpUrl,
            startupTimeoutSec: 60,
            toolTimeoutSec: 120,
            defaultToolsApprovalMode: "approve" as const,
            required: false
          }
        }
      } : {})
    };
  };
  const active = store.getActive();
  if (active) {
    const config = loadConfig(options.paths);
    saveConfig(options.paths, {
      ...config,
      codexBin: path.resolve(options.wrapperPath),
      model: active.model,
      effort: active.effort
    });
    writeProviderConfig(options.paths, active, {
      ...providerOptions(),
      reasoningEffort: active.effort
    });
  }

  return new ApiProfileManager({
    store,
    fetch: options.fetch,
    writeProviderConfig: (profile) => writeProviderConfig(options.paths, profile, {
      ...providerOptions(),
      reasoningEffort: profile.effort
    }),
    loadConfig: () => loadConfig(options.paths),
    saveConfig: (config) => saveConfig(options.paths, config),
    restartRuntime: (prepare, runtimeOptions) => options.accountManager.restartRunning(prepare, runtimeOptions),
    resetSessionRuntimeOverrides: () => options.accountManager.clearSessionRuntimeOverrides(),
    getActiveTaskCount: () => options.accountManager.getActiveTaskCount(),
    readRuntime: async () => {
      const model = store.getActive()?.model;
      if (!model) throw new Error("No active API profile is configured");
      return options.accountManager.verifyCodexRuntime(model);
    }
  });
}
