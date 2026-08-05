import fs from "node:fs";
import path from "node:path";

import type { ApiProfileSeed, ApiProfileSummary } from "../state/api-profiles.js";
import { ensureDir } from "../state/json-store.js";
import type { StatePaths } from "../state/paths.js";

export type ProviderConfigOptions = {
  instructionsFile?: string;
  reasoningEffort?: string;
  trustedWorkspace?: string;
  mcpServers?: Record<string, McpServerConfig>;
};

type McpServerCommonConfig = {
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  defaultToolsApprovalMode?: "auto" | "prompt" | "writes" | "approve";
  required?: boolean;
};

export type StdioMcpServerConfig = McpServerCommonConfig & {
  command: string;
  args?: string[];
  cwd?: string;
};

export type HttpMcpServerConfig = McpServerCommonConfig & {
  url: string;
};

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

export function readProviderConfigOptions(configPath: string): ProviderConfigOptions {
  const source = readOptionalFile(configPath);
  const project = source.match(/^\s*\[projects\.(["'])(.*?)\1\]\s*$/m)?.[2];
  return {
    ...(readTomlString(source, "model_instructions_file")
      ? { instructionsFile: readTomlString(source, "model_instructions_file") }
      : {}),
    ...(readTomlString(source, "model_reasoning_effort")
      ? { reasoningEffort: readTomlString(source, "model_reasoning_effort") }
      : {}),
    ...(project ? { trustedWorkspace: project } : {})
  };
}

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
    "js_repl = false",
    "plugins = false",
    "remote_plugin = false",
    "apps = false"
  );
  if (options.trustedWorkspace) {
    lines.push(
      "",
      `[projects.${tomlString(options.trustedWorkspace.toLowerCase())}]`,
      'trust_level = "trusted"'
    );
  }
  for (const [name, server] of Object.entries(options.mcpServers ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    lines.push("", `[mcp_servers.${tomlString(name)}]`);
    if ("url" in server) {
      lines.push(`url = ${tomlString(server.url)}`);
    } else {
      lines.push(`command = ${tomlString(server.command)}`);
      if (server.args?.length) lines.push(`args = ${tomlStringArray(server.args)}`);
      if (server.cwd) lines.push(`cwd = ${tomlString(server.cwd)}`);
    }
    if (server.startupTimeoutSec !== undefined) lines.push(`startup_timeout_sec = ${server.startupTimeoutSec}`);
    if (server.toolTimeoutSec !== undefined) lines.push(`tool_timeout_sec = ${server.toolTimeoutSec}`);
    if (server.defaultToolsApprovalMode) {
      lines.push(`default_tools_approval_mode = ${tomlString(server.defaultToolsApprovalMode)}`);
    }
    if (server.required !== undefined) lines.push(`required = ${server.required}`);
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

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}
