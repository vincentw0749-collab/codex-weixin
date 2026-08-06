import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createStartupService } from "../src/server/startup.js";

test("Windows startup service creates the preferred shortcut and removes only managed shortcuts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-startup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, "AppData", "Roaming");
  const startupDir = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const launcherPath = path.join(root, "codex-weixin-launcher.ps1");
  fs.writeFileSync(launcherPath, "# launcher\n");
  const created: Array<{ shortcutPath: string; targetPath: string; arguments: string; workingDirectory: string }> = [];
  const service = createStartupService({
    platform: "win32",
    env: { APPDATA: appData, SystemRoot: "C:\\Windows" },
    launcherPath,
    createShortcut: async (shortcut) => {
      created.push(shortcut);
      fs.mkdirSync(path.dirname(shortcut.shortcutPath), { recursive: true });
      fs.writeFileSync(shortcut.shortcutPath, "shortcut");
    }
  });
  const preferredPath = path.join(startupDir, "Codex 微信 ClawBot.lnk");
  const legacyPath = path.join(startupDir, "微信 Codex 管理台.lnk");

  assert.deepEqual(service.getStartupStatus(), {
    supported: true,
    enabled: false,
    shortcutPath: preferredPath
  });

  await service.setStartupEnabled(true);
  assert.deepEqual(created, [{
    shortcutPath: preferredPath,
    targetPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    arguments: `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${launcherPath}" -NoOpen`,
    workingDirectory: root
  }]);
  assert.deepEqual(service.getStartupStatus(), {
    supported: true,
    enabled: true,
    shortcutPath: preferredPath
  });

  fs.writeFileSync(legacyPath, "legacy shortcut");
  const unrelatedPath = path.join(startupDir, "Unrelated app.lnk");
  fs.writeFileSync(unrelatedPath, "unrelated shortcut");
  await service.setStartupEnabled(false);
  assert.equal(fs.existsSync(preferredPath), false);
  assert.equal(fs.existsSync(legacyPath), false);
  assert.equal(fs.existsSync(unrelatedPath), true);
});

test("Windows startup service recognizes an existing legacy shortcut and migrates it on enable", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-startup-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, "AppData", "Roaming");
  const startupDir = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const launcherPath = path.join(root, "codex-weixin-launcher.ps1");
  fs.writeFileSync(launcherPath, "# launcher\n");
  fs.mkdirSync(startupDir, { recursive: true });
  const legacyPath = path.join(startupDir, "微信 Codex 管理台.lnk");
  fs.writeFileSync(legacyPath, "legacy shortcut");
  const service = createStartupService({
    platform: "win32",
    env: { APPDATA: appData },
    launcherPath,
    createShortcut: async (shortcut) => fs.writeFileSync(shortcut.shortcutPath, "new shortcut")
  });
  const preferredPath = path.join(startupDir, "Codex 微信 ClawBot.lnk");

  assert.deepEqual(service.getStartupStatus(), {
    supported: true,
    enabled: true,
    shortcutPath: legacyPath
  });

  await service.setStartupEnabled(true);
  assert.equal(fs.existsSync(preferredPath), true);
  assert.equal(fs.existsSync(legacyPath), false);
});

test("startup service reports unsupported outside Windows without creating a shortcut", async () => {
  let createCalls = 0;
  const service = createStartupService({
    platform: "linux",
    createShortcut: async () => { createCalls += 1; }
  });

  assert.deepEqual(service.getStartupStatus(), { supported: false, enabled: false });
  assert.deepEqual(await service.setStartupEnabled(true), { supported: false, enabled: false });
  assert.equal(createCalls, 0);
});
