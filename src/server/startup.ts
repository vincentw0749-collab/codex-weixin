import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STARTUP_SUBDIRECTORY = path.join("Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const PREFERRED_SHORTCUT_NAME = "Codex 微信 ClawBot.lnk";
const LEGACY_SHORTCUT_NAME = "微信 Codex 管理台.lnk";

export type StartupStatus = {
  supported: boolean;
  enabled: boolean;
  shortcutPath?: string;
};

export type StartupShortcut = {
  shortcutPath: string;
  targetPath: string;
  arguments: string;
  workingDirectory: string;
};

export type StartupService = {
  getStartupStatus: () => StartupStatus;
  setStartupEnabled: (enabled: boolean) => Promise<StartupStatus>;
};

type StartupFileSystem = Pick<typeof fs, "existsSync" | "mkdirSync" | "unlinkSync">;

export type StartupServiceOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  startupDir?: string;
  launcherPath?: string;
  fileSystem?: StartupFileSystem;
  createShortcut?: (shortcut: StartupShortcut) => Promise<void>;
};

export class WindowsStartupService implements StartupService {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly startupDir: string;
  private readonly launcherPath: string;
  private readonly fileSystem: StartupFileSystem;
  private readonly createShortcutImpl: (shortcut: StartupShortcut) => Promise<void>;

  constructor(options: StartupServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.startupDir = options.startupDir ?? resolveStartupDirectory(this.platform, this.env);
    this.launcherPath = options.launcherPath
      ?? this.env.CODEX_WEIXIN_LAUNCHER_PATH
      ?? fileURLToPath(new URL("../../../codex-weixin-launcher.ps1", import.meta.url));
    this.fileSystem = options.fileSystem ?? fs;
    this.createShortcutImpl = options.createShortcut
      ?? ((shortcut) => createShortcutWithPowerShell(shortcut, this.env));
  }

  getStartupStatus(): StartupStatus {
    if (this.platform !== "win32") {
      return { supported: false, enabled: false };
    }
    const preferredPath = this.preferredShortcutPath();
    const legacyPath = this.legacyShortcutPath();
    const existingPath = [preferredPath, legacyPath].find((candidate) => this.fileSystem.existsSync(candidate));
    return {
      supported: true,
      enabled: Boolean(existingPath),
      shortcutPath: existingPath ?? preferredPath
    };
  }

  async setStartupEnabled(enabled: boolean): Promise<StartupStatus> {
    if (this.platform !== "win32") {
      return { supported: false, enabled: false };
    }
    if (enabled) {
      if (!this.fileSystem.existsSync(this.launcherPath)) {
        throw new Error(`Codex 微信 ClawBot launcher not found: ${this.launcherPath}`);
      }
      const shortcutPath = this.preferredShortcutPath();
      this.fileSystem.mkdirSync(this.startupDir, { recursive: true });
      await this.createShortcutImpl({
        shortcutPath,
        targetPath: resolvePowerShellPath(this.env),
        arguments: buildLauncherArguments(this.launcherPath),
        workingDirectory: path.dirname(this.launcherPath)
      });
      removeIfPresent(this.fileSystem, this.legacyShortcutPath());
      return this.getStartupStatus();
    }

    removeIfPresent(this.fileSystem, this.preferredShortcutPath());
    removeIfPresent(this.fileSystem, this.legacyShortcutPath());
    return this.getStartupStatus();
  }

  private preferredShortcutPath(): string {
    return path.join(this.startupDir, PREFERRED_SHORTCUT_NAME);
  }

  private legacyShortcutPath(): string {
    return path.join(this.startupDir, LEGACY_SHORTCUT_NAME);
  }
}

export function createStartupService(options: StartupServiceOptions = {}): StartupService {
  return new WindowsStartupService(options);
}

export function getStartupStatus(options: StartupServiceOptions = {}): StartupStatus {
  return createStartupService(options).getStartupStatus();
}

export function setStartupEnabled(enabled: boolean, options: StartupServiceOptions = {}): Promise<StartupStatus> {
  return createStartupService(options).setStartupEnabled(enabled);
}

function resolveStartupDirectory(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform !== "win32") {
    return path.join(os.homedir(), ".config", "codex-weixin", "startup");
  }
  const appData = env.APPDATA ?? path.join(env.USERPROFILE ?? os.homedir(), "AppData", "Roaming");
  return path.join(appData, STARTUP_SUBDIRECTORY);
}

function resolvePowerShellPath(env: NodeJS.ProcessEnv): string {
  return path.join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function buildLauncherArguments(launcherPath: string): string {
  return `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${launcherPath}" -NoOpen`;
}

function removeIfPresent(fileSystem: StartupFileSystem, filePath: string): void {
  if (!fileSystem.existsSync(filePath)) return;
  try {
    fileSystem.unlinkSync(filePath);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
  }
}

async function createShortcutWithPowerShell(shortcut: StartupShortcut, env: NodeJS.ProcessEnv): Promise<void> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$shell = New-Object -ComObject WScript.Shell",
    `$shortcut = $shell.CreateShortcut(${quotePowerShell(shortcut.shortcutPath)})`,
    `$shortcut.TargetPath = ${quotePowerShell(shortcut.targetPath)}`,
    `$shortcut.Arguments = ${quotePowerShell(shortcut.arguments)}`,
    `$shortcut.WorkingDirectory = ${quotePowerShell(shortcut.workingDirectory)}`,
    "$shortcut.WindowStyle = 7",
    "$shortcut.Description = 'Codex 微信 ClawBot'",
    "$shortcut.Save()"
  ].join("\n");
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  await execFileAsync(resolvePowerShellPath(env), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodedCommand
  ], { windowsHide: true });
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
