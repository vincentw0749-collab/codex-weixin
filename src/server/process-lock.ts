import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ensureDir } from "../state/json-store.js";

type LockRecord = {
  pid: number;
  startedAt: string;
};

export type ServiceProcessLock = {
  path: string;
  release: () => void;
};

export type ServiceProcessLockOptions = {
  pid?: number;
  now?: () => Date;
  isProcessRunning?: (pid: number) => boolean;
  processStartedAt?: (pid: number) => number | undefined;
};

const PROCESS_START_TIME_TOLERANCE_MS = 60_000;

export function acquireServiceProcessLock(
  stateRoot: string,
  options: ServiceProcessLockOptions = {}
): ServiceProcessLock {
  ensureDir(stateRoot);
  const lockPath = path.join(stateRoot, "service.lock");
  const ownerPid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, "wx");
      const record: LockRecord = {
        pid: ownerPid,
        startedAt: now().toISOString()
      };
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      fs.closeSync(descriptor);
      let released = false;
      return {
        path: lockPath,
        release() {
          if (released) return;
          released = true;
          const current = readLockRecord(lockPath);
          if (current?.pid === ownerPid) {
            fs.rmSync(lockPath, { force: true });
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const existing = readLockRecord(lockPath);
      if (!existing) {
        throw new Error(`codex-weixin lock is unreadable: ${lockPath}`);
      }
      if (isLockOwnerRunning(existing, options)) {
        throw new Error(`codex-weixin is already running for ${stateRoot} (PID ${existing.pid})`);
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`Unable to acquire codex-weixin lock: ${lockPath}`);
}

function readLockRecord(lockPath: string): LockRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
    return Number.isInteger(value.pid)
      && (value.pid ?? 0) > 0
      && typeof value.startedAt === "string"
      && Number.isFinite(Date.parse(value.startedAt))
      ? value as LockRecord
      : undefined;
  } catch {
    return undefined;
  }
}

function isLockOwnerRunning(record: LockRecord, options: ServiceProcessLockOptions): boolean {
  const isRunning = options.isProcessRunning ?? isProcessRunning;
  if (!isRunning(record.pid)) return false;
  const processStartedAt = (options.processStartedAt ?? readProcessStartedAt)(record.pid);
  if (processStartedAt === undefined) return true;
  const recordedStartAt = Date.parse(record.startedAt);
  return Math.abs(processStartedAt - recordedStartAt) <= PROCESS_START_TIME_TOLERANCE_MS;
}

function readProcessStartedAt(pid: number): number | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    const output = execFileSync(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
      ],
      { encoding: "utf8", windowsHide: true, timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    const startedAt = Date.parse(output);
    return Number.isFinite(startedAt) ? startedAt : undefined;
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
