import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const stateDir = process.env.CODEX_WEIXIN_STATE_DIR || join(homedir(), ".codex-weixin");
const profilesPath = join(stateDir, "api-profiles.json");
const codexHome = join(stateDir, "codex-home");
const sqliteHome = join(homedir(), ".codex");

const document = readProfileDocument(profilesPath);
const active = document.profiles.find((profile) => profile.id === document.activeProfileId);
if (!active?.encryptedApiKey) fail("No active API profile is configured");

const apiKey = decryptWithDpapi(active.encryptedApiKey);
const codexExe = findCodexExecutable();
const noProxy = [...new Set([
  ...(process.env.NO_PROXY ?? "").split(","),
  ...(process.env.no_proxy ?? "").split(","),
  "localhost",
  "127.0.0.1",
  "::1"
].map((entry) => entry.trim()).filter(Boolean))].join(",");
const child = spawn(codexExe, process.argv.slice(2), {
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: sqliteHome,
    CODEX_WEIXIN_PROVIDER_KEY: apiKey,
    NO_PROXY: noProxy,
    no_proxy: noProxy
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.once("error", () => fail("Unable to start the Codex executable"));
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

function readProfileDocument(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.profiles)) throw new Error("invalid");
    return parsed;
  } catch {
    fail("API profile storage is missing or invalid");
  }
}

function decryptWithDpapi(ciphertext) {
  const script = [
    "Add-Type -AssemblyName System.Security;",
    "$bytes=[Convert]::FromBase64String($env:CODEX_WEIXIN_DPAPI_INPUT);",
    "$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))"
  ].join("");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, CODEX_WEIXIN_DPAPI_INPUT: ciphertext },
    maxBuffer: 64 * 1024,
    timeout: 15_000,
    windowsHide: true
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  if (!value) fail("Unable to decrypt the active API key");
  return value;
}

function findCodexExecutable() {
  const binDir = join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin");
  let entries = [];
  try {
    entries = readdirSync(binDir, { withFileTypes: true });
  } catch {
    fail("Codex CLI installation directory was not found");
  }
  const candidates = [
    join(binDir, "codex.exe"),
    ...entries.filter((entry) => entry.isDirectory()).map((entry) => join(binDir, entry.name, "codex.exe"))
  ]
    .filter(existsSync)
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  if (!candidates[0]) fail("Codex CLI executable was not found");
  return candidates[0];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
