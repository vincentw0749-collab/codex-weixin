import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildBrowserMcpArgs } from "../src/server/browser-mcp.js";
import { resolveStatePaths } from "../src/state/paths.js";

test("builds a headless shared browser with persistent state", () => {
  const root = path.resolve("C:/Users/Test/.codex-weixin");
  const packageRoot = path.resolve("D:/codex-weixin");
  const args = buildBrowserMcpArgs(resolveStatePaths(root), packageRoot, 45678);

  assert.equal(args[0], path.join(packageRoot, "node_modules", "@playwright", "mcp", "cli.js"));
  assert.deepEqual(args.slice(1, 7), [
    "--port", "45678",
    "--host", "127.0.0.1",
    "--headless", "--shared-browser-context"
  ]);
  assert.ok(args.includes("--user-data-dir"));
  assert.ok(args.includes(path.join(root, "browser-profile")));
  assert.ok(args.includes(path.join(root, "browser-output")));
  assert.ok(!args.includes("--isolated"));
});
