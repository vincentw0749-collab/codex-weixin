import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import type { StatePaths } from "../state/paths.js";

export type BrowserMcpService = {
  url: string;
  close: () => Promise<void>;
};

export function buildBrowserMcpArgs(paths: StatePaths, packageRoot: string, port: number): string[] {
  return [
    path.join(packageRoot, "node_modules", "@playwright", "mcp", "cli.js"),
    "--port", String(port),
    "--host", "127.0.0.1",
    "--headless",
    "--shared-browser-context",
    "--browser", "msedge",
    "--user-data-dir", path.join(paths.root, "browser-profile"),
    "--output-dir", path.join(paths.root, "browser-output"),
    "--caps", "vision",
    "--viewport-size", "1440x900",
    "--timeout-action", "15000",
    "--timeout-navigation", "60000",
    "--image-responses", "allow",
    "--save-session",
    "--allow-unrestricted-file-access"
  ];
}

export async function startBrowserMcp(options: {
  paths: StatePaths;
  packageRoot: string;
  startupTimeoutMs?: number;
}): Promise<BrowserMcpService> {
  const port = await findFreePort();
  const args = buildBrowserMcpArgs(options.paths, options.packageRoot, port);
  if (!fs.existsSync(args[0])) {
    throw new Error(`Playwright MCP executable was not found: ${args[0]}`);
  }
  fs.mkdirSync(path.join(options.paths.root, "browser-profile"), { recursive: true });
  fs.mkdirSync(path.join(options.paths.root, "browser-output"), { recursive: true });

  const child = spawn(process.execPath, args, {
    cwd: options.packageRoot,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
  });
  try {
    await waitForPort(child, port, options.startupTimeoutMs ?? 30_000, () => stderr);
  } catch (error) {
    if (child.exitCode === null) child.kill();
    throw error;
  }

  return {
    url: `http://localhost:${port}/mcp`,
    close: () => closeChild(child)
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForPort(
  child: ChildProcess,
  port: number,
  timeoutMs: number,
  stderr: () => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const detail = stderr().trim();
      throw new Error(`Playwright MCP exited with code ${child.exitCode}${detail ? `: ${detail}` : ""}`);
    }
    if (await canConnect(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Playwright MCP did not start within ${timeoutMs}ms`);
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function closeChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 5_000))
  ]);
}
