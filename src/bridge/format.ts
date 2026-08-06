import type { PromptBufferItem } from "./prompt-buffer.js";

const BRIDGE_ACTION_INSTRUCTIONS = [
  "WeChat bridge rule: when you need to send a local image, video, or file to the user, do not use Markdown local file links.",
  "When a WeChat attachment line includes a local path, inspect the saved local attachment with available tools before answering.",
  "Treat an explicit user command as authorization for non-destructive local actions and execute it without asking for duplicate permission.",
  "For browser work, use the configured Playwright MCP in background/headless mode; never launch or control a foreground browser.",
  "If a QR code or verification requires the user, capture it to a local image, send it with the action block below, and wait only for that narrow user action.",
  "Every task turn must end with a user-facing final report. State whether it is completed, needs user action, or is blocked; summarize the concrete work completed; and state the exact next user action only when one is needed.",
  "Never finish with an empty reply, a progress-only message, or only a codex-weixin-actions block. A final report is mandatory before the turn is considered complete.",
  "Use a fenced codex-weixin-actions JSON block instead, for example:",
  "```codex-weixin-actions",
  "{\"send\":[{\"type\":\"image\",\"path\":\"C:/absolute/path/image.png\"},{\"type\":\"video\",\"path\":\"C:/absolute/path/video.mp4\"}]}",
  "```"
].join("\n");
const LEGACY_BRIDGE_ACTION_INSTRUCTIONS = BRIDGE_ACTION_INSTRUCTIONS
  .replaceAll("codex-weixin-actions", "codex-weixin-server-actions");

export const MISSING_FINAL_REPORT_PROMPT = [
  "上一轮已经结束，但没有给用户提供任何可读的最终汇报。",
  "不要重新执行或重复任何可能已经完成的操作；先核验当前会话和已执行状态。",
  "现在只发送一条完整的最终汇报：说明状态（已完成、需要用户操作或受阻）、实际完成的事项，以及必要时用户下一步该做什么。",
  "这条汇报不能为空，不能只是过程消息，也不能只包含文件或图片发送动作。"
].join("\n");

export const MAX_FINAL_REPORT_RECOVERY_ATTEMPTS = 3;

export const MISSING_FINAL_REPORT_FALLBACK = [
  "【本轮处理结果】",
  "状态：无法确认",
  `已处理：Codex 连续 ${MAX_FINAL_REPORT_RECOVERY_ATTEMPTS} 次未返回可读的最终汇报，已停止继续请求并释放会话。`,
  "下一步：请重新发送任务；若此前可能已执行操作，请先要求它检查已有结果。"
].join("\n");

export function hasVisibleFinalReport(text: string): boolean {
  return text.trim().length > 0;
}

export function buildPrompt(
  text: string,
  attachments: PromptBufferItem[] = [],
  attachmentSource: "WeChat" | "Web" = "WeChat"
): string {
  const lines: string[] = [BRIDGE_ACTION_INSTRUCTIONS];
  if (text.trim()) {
    lines.push(text.trim());
  }
  for (const attachment of attachments) {
    if (attachment.kind === "text") {
      lines.push(attachment.text);
    } else {
      lines.push(`[${attachmentSource} ${attachment.kind}: ${attachment.label} saved to ${attachment.path}]\nInspect the saved local attachment before answering.`);
    }
  }
  return lines.join("\n\n").trim();
}

export type PromptAttachment = {
  source: "WeChat" | "Web";
  kind: "file" | "image" | "video" | "audio";
  label: string;
  path: string;
};

type PromptPreviewItem =
  | Pick<Extract<PromptBufferItem, { kind: "text" }>, "kind" | "text">
  | Pick<Extract<PromptBufferItem, { kind: "file" | "image" | "video" | "audio" }>, "kind" | "label">;

export function buildPromptPreview(text: string, attachments: PromptPreviewItem[] = [], limit = 120): string | undefined {
  const labels: Record<Exclude<PromptPreviewItem["kind"], "text">, string> = {
    file: "文件",
    image: "图片",
    video: "视频",
    audio: "音频"
  };
  const parts = [text, ...attachments.map((attachment) => attachment.kind === "text"
    ? attachment.text
    : `${labels[attachment.kind]}：${attachment.label}`
  )];
  const preview = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!preview) return undefined;
  return preview.length > limit ? `${preview.slice(0, Math.max(1, limit - 1))}…` : preview;
}

export function parsePrompt(text: string): { text: string; attachments: PromptAttachment[] } {
  let normalized = text.trim();
  for (const instructions of [BRIDGE_ACTION_INSTRUCTIONS, LEGACY_BRIDGE_ACTION_INSTRUCTIONS]) {
    if (normalized.startsWith(instructions)) {
      normalized = normalized.slice(instructions.length).trim();
      break;
    }
  }
  const attachments: PromptAttachment[] = [];
  const visibleText = normalized.replace(
    /^\[(WeChat|Web) (file|image|video|audio): (.+) saved to (.+)]\nInspect the saved local attachment before answering\.$/gm,
    (_match, source: PromptAttachment["source"], kind: PromptAttachment["kind"], label: string, filePath: string) => {
      attachments.push({ source, kind, label, path: filePath });
      return "";
    }
  ).replace(/\n{3,}/g, "\n\n").trim();
  return { text: visibleText, attachments };
}

export function stripBridgeInstructions(text: string): string {
  return parsePrompt(text).text;
}

export function chunkText(text: string, limit = 1800): string[] {
  const normalized = text || "(empty reply)";
  if (normalized.length <= limit) {
    return [normalized];
  }
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    let end = Math.min(cursor + limit, normalized.length);
    const newline = normalized.lastIndexOf("\n", end);
    if (newline > cursor + Math.floor(limit * 0.5)) {
      end = newline;
    }
    chunks.push(normalized.slice(cursor, end).trim());
    cursor = end;
  }
  return chunks.filter(Boolean);
}
