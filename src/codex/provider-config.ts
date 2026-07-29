import fs from "node:fs";
import path from "node:path";

import type { ApiProfileSeed, ApiProfileSummary } from "../state/api-profiles.js";
import { ensureDir } from "../state/json-store.js";
import type { StatePaths } from "../state/paths.js";

export type ProviderConfigOptions = {
  instructionsFile?: string;
  reasoningEffort?: string;
  trustedWorkspace?: string;
};

export function renderProviderConfig(
  profile: Pick<ApiProfileSummary, "name" | "baseUrl" | "model">,
  options: ProviderConfigOptions = {}
): string {
  const lines = [
    `model = ${tomlString(profile.model)}`,
    `model_reasoning_effort = ${tomlString(options.reasoningEffort ?? "medium")}`,
    "disable_response_storage = true",
    'approval_policy = "never"',
    'approvals_reviewer = "user"',
    'sandbox_mode = "danger-full-access"'
  ];
  if (options.instructionsFile) {
    lines.push(`model_instructions_file = ${tomlString(options.instructionsFile)}`);
  }
  lines.push(
    'service_tier = "fast"',
    'model_provider = "codex_local_access"',
    "",
    "[model_providers.codex_local_access]",
    `name = ${tomlString(profile.name)}`,
    `base_url = ${tomlString(profile.baseUrl)}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    'env_key = "CODEX_WEIXIN_PROVIDER_KEY"',
    "supports_websockets = false",
    "",
    "[features]",
    "js_repl = false"
  );
  if (options.trustedWorkspace) {
    lines.push(
      "",
      `[projects.${tomlString(options.trustedWorkspace.toLowerCase())}]`,
      'trust_level = "trusted"'
    );
  }
  return `${lines.join("\n")}\n`;
}

export function writeProviderConfig(
  paths: StatePaths,
  profile: Pick<ApiProfileSummary, "name" | "baseUrl" | "model">,
  options: ProviderConfigOptions = {}
): void {
  ensureDir(paths.codexHomeDir);
  const target = path.join(paths.codexHomeDir, "config.toml");
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, renderProviderConfig(profile, options), "utf8");
  fs.renameSync(temp, target);
}

export function readLegacyApiProfileSeed(options: {
  dedicatedConfigPath: string;
  globalConfigPath: string;
  env?: NodeJS.ProcessEnv;
}): ApiProfileSeed | undefined {
  const dedicated = readOptionalFile(options.dedicatedConfigPath);
  const global = readOptionalFile(options.globalConfigPath);
  const model = readTomlString(dedicated, "model") ?? readTomlString(global, "model");
  const baseUrl = readTomlString(dedicated, "base_url") ?? readTomlString(global, "base_url");
  const providerName = readTomlString(dedicated, "name") ?? "Current API";
  const envKey = readTomlString(dedicated, "env_key") ?? readTomlString(global, "env_key");
  const apiKey = (envKey ? options.env?.[envKey] : undefined)
    ?? readTomlString(dedicated, "experimental_bearer_token")
    ?? readTomlString(global, "experimental_bearer_token");
  if (!model || !baseUrl || !apiKey) return undefined;
  return { name: providerName, baseUrl, apiKey, model };
}

function readOptionalFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function readTomlString(source: string, key: string): string | undefined {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*(["'])(.*?)\\1\\s*$`, "m"));
  if (!match) return undefined;
  if (match[1] === "'") return match[2];
  try {
    return JSON.parse(`"${match[2]}"`) as string;
  } catch {
    return undefined;
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
