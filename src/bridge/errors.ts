export type MessageHandlingErrorContext = {
  apiProfileName?: string;
};

const UNCLASSIFIED_ERROR_MESSAGE = "[codex-weixin] 本轮处理遇到未分类错误，详细原因已写入本机服务输出。发送 /help 查看可用指令。";

export function userFacingMessageHandlingError(
  error: unknown,
  context: MessageHandlingErrorContext = {}
): string {
  const message = error instanceof Error ? error.message : String(error);
  const api = context.apiProfileName ? `“${context.apiProfileName.replace(/\s+/g, " ").trim()}”` : "当前 API";
  if (/CreateProcessAsUserW failed:\s*1312|codexExecSandbox/i.test(message)) {
    return [
      "[codex-weixin] Windows Codex sandbox 启动失败。",
      "可在 ~/.codex-weixin/config.json 中设置 \"codexExecSandbox\": \"danger-full-access\" 后重启。",
      "该设置会让 Codex 获得本机完整访问权限，请仅在理解并接受安全风险时启用。"
    ].join("\n");
  }
  if (/concurrency limit|too many concurrent|并发/i.test(message)) {
    return `[codex-weixin] ${api}已达到并发限制。请稍后重试，或发送 /api 切换其他 API。`;
  }
  if (/\b429\b|too many requests|rate limit|quota|exceeded retry limit, last status:\s*429/i.test(message)) {
    return `[codex-weixin] ${api}请求过多或额度受限（429）。请稍后重试，或发送 /api 切换备用 API。`;
  }
  if (/\b401\b|\b403\b|authentication failed|invalid[_ -]?api[_ -]?key|unauthorized|forbidden/i.test(message)) {
    return `[codex-weixin] ${api}认证失败。请发送 /api 切换可用配置，或使用 /api add 重新添加。`;
  }
  if (/\b502\b|\b503\b|\b504\b|bad gateway|service unavailable|upstream service temporarily unavailable/i.test(message)) {
    return `[codex-weixin] ${api}上游服务暂时不可用。请稍后重试，或发送 /api 切换备用 API。`;
  }
  if (/selected model is at capacity|model (?:is )?(?:at )?capacity|capacity exceeded|temporarily overloaded|model.*overloaded/i.test(message)) {
    return `[codex-weixin] ${api}当前模型容量已满或暂时繁忙。请稍后重试，或发送 /api 切换模型/API。`;
  }
  if (/timed out|timeout/i.test(message)) {
    return `[codex-weixin] ${api}响应超时。本轮未完成，请重试或发送 /api 切换备用 API。`;
  }
  if (/fetch failed|econnreset|econnrefused|enotfound|network|socket hang up|stream disconnected/i.test(message)) {
    return `[codex-weixin] 无法稳定连接${api}。请检查网络后重试，或发送 /api 切换备用 API。`;
  }
  return UNCLASSIFIED_ERROR_MESSAGE;
}

export function isUnclassifiedMessageHandlingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /stream disconnected before completion|stream closed before response\.completed|app-server turn stream became unresponsive|app-server request thread\/read timed out|\b429\b|rate limit|quota|\b502\b|\b503\b|\b504\b|bad gateway|service unavailable|selected model is at capacity|model (?:is )?(?:at )?capacity|capacity exceeded|temporarily overloaded|model.*overloaded|fetch failed|econnreset|econnrefused|enotfound|socket hang up/i.test(message)
  ) {
    return true;
  }
  return userFacingMessageHandlingError(error) === UNCLASSIFIED_ERROR_MESSAGE;
}
