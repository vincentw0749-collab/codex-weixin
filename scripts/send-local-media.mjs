import fs from "node:fs";
import path from "node:path";

import { WeixinApiClient } from "../dist/weixin/api.js";
import { sendLocalMediaFile } from "../dist/weixin/media.js";

const [, , accountPath, statePath, senderId, filePath, requestedKind] = process.argv;

if (!accountPath || !statePath || !senderId || !filePath) {
  throw new Error("Usage: send-local-media <account.json> <state.json> <sender-id> <file-path> [kind]");
}

const account = JSON.parse(fs.readFileSync(accountPath, "utf8"));
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const contextToken = state.contextTokens?.[senderId];

if (!account.baseUrl || !account.token) {
  throw new Error("WeChat account configuration is incomplete");
}
if (!contextToken) {
  throw new Error("No current WeChat context token exists for this sender");
}
if (!fs.statSync(filePath).isFile()) {
  throw new Error("Local media path is not a file");
}

const allowedKinds = new Set(["image", "file", "video"]);
const kind = allowedKinds.has(requestedKind) ? requestedKind : undefined;
const client = new WeixinApiClient({ baseUrl: account.baseUrl, token: account.token });
const result = await sendLocalMediaFile({
  client,
  toUserId: senderId,
  contextToken,
  filePath: path.resolve(filePath),
  kind
});

console.log(`SENT ${result.kind} ${result.messageId}`);
