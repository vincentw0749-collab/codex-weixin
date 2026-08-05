import path from "node:path";

import { AccessController } from "./access.js";
import { parseActionBlocks, type SendAction } from "./actions.js";
import { isUnclassifiedMessageHandlingError } from "./errors.js";
import {
  buildPrompt,
  buildPromptPreview,
  chunkText,
  hasVisibleFinalReport,
  MISSING_FINAL_REPORT_PROMPT,
  parsePrompt
} from "./format.js";
import { PromptBuffer } from "./prompt-buffer.js";
import type { CodexModelOption, CodexRuntimeInfo } from "../codex/app-server-runner.js";
import { HybridCodexRunner } from "../codex/runner.js";
import {
  ApiProfileError,
  type ApiProfileDisplaySummary,
  normalizeCreateApiProfileInput,
  type ApiProfileSummary,
  type CreateApiProfileInput
} from "../state/api-profiles.js";
import { isWorkspaceAllowed, type CodexWeixinConfig } from "../state/config.js";
import { RuntimeStateStore, type ManagedSession } from "../state/runtime-state.js";
import { WeixinApiClient, isStaleContextError, type FetchLike } from "../weixin/api.js";
import { downloadInboundAttachments, InboundMediaTooLargeError, sendLocalMediaFile } from "../weixin/media.js";
import type { NormalizedWeixinMessage } from "../weixin/messages.js";
import type { PromptBufferItem } from "./prompt-buffer.js";

export type ApiProfileCommandService = {
  list: () => ApiProfileSummary[];
  listForDisplay: () => Promise<ApiProfileDisplaySummary[]>;
  getActive: () => ApiProfileSummary | undefined;
  getActiveTaskCount?: () => number;
  validateDefaults?: (id: string, model: string, effort: string) => void;
  setDefaults: (
    id: string,
    model: string,
    effort: string,
    options?: { interruptActiveTasks?: boolean }
  ) => Promise<ApiProfileSummary>;
  createVerified: (input: CreateApiProfileInput) => Promise<{
    profile: ApiProfileSummary;
    ok: true;
    latencyMs: number;
  }>;
  test: (id: string) => Promise<{ ok: true; latencyMs: number }>;
  activate: (id: string, options?: { interruptActiveTasks?: boolean }) => Promise<ApiProfileSummary>;
};

export type BridgeServiceOptions = {
  config: CodexWeixinConfig;
  stateStore: RuntimeStateStore;
  weixin: WeixinApiClient;
  runner?: HybridCodexRunner;
  listCodexModels?: () => Promise<CodexModelOption[]>;
  inboundDir?: string;
  mediaFetch?: FetchLike;
  onTurnStatus?: (status: { senderId: string; sessionId: string; active: boolean }) => void;
  waitForRuntimeReady?: () => Promise<void> | undefined;
  apiProfiles?: ApiProfileCommandService;
  deferTask?: (task: () => Promise<void>) => void;
  retryDelay?: (retryAttempt: number) => Promise<void> | void;
};

type ActiveTurnControl = {
  cancelled: boolean;
};

type PendingApiProfileAdd = {
  name: string;
  baseUrl: string;
  model: string;
  effort: string;
  expiresAt: number;
};

type PendingApiProfileOperation =
  | {
      kind: "activate";
      profileId: string;
      expiresAt: number;
    }
  | {
      kind: "set-defaults";
      profileId: string;
      model: string;
      effort: string;
      expiresAt: number;
    };

type PendingApiProfileOperationInput =
  | {
      kind: "activate";
      profileId: string;
    }
  | {
      kind: "set-defaults";
      profileId: string;
      model: string;
      effort: string;
    };

const API_KEY_WAIT_MS = 2 * 60_000;
const API_SWITCH_CONFIRM_WAIT_MS = 2 * 60_000;
const RUNNER_STOP_TIMEOUT_MS = 5_000;

export class BridgeService {
  private access: AccessController;
  private readonly buffers: PromptBuffer;
  private runner: HybridCodexRunner;
  private readonly activeTurns = new Map<string, ActiveTurnControl>();
  private readonly pendingApiProfileAdds = new Map<string, PendingApiProfileAdd>();
  private readonly pendingApiProfileOperations = new Map<string, PendingApiProfileOperation>();

  constructor(private readonly options: BridgeServiceOptions) {
    this.access = new AccessController({
      allowedSenderIds: options.config.allowedSenderIds,
      pairedSenderIds: options.stateStore.listPairedSenderIds()
    });
    this.buffers = new PromptBuffer({
      maxItems: options.config.maxBufferItems,
      ttlMs: options.config.promptBufferTtlMs
    });
    this.runner = options.runner ?? new HybridCodexRunner({
      backend: options.config.codexBackend,
      codexBin: options.config.codexBin,
      execSandbox: options.config.codexExecSandbox
    });
  }

  async handleMessage(message: NormalizedWeixinMessage): Promise<void> {
    if (message.contextToken) {
      this.options.stateStore.rememberContextToken(message.senderId, message.contextToken);
    }

    const access = this.access.requireAccess(message.senderId);
    if (!access.allowed) {
      await this.reply(message.senderId, access.message);
      return;
    }
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
    this.options.stateStore.ensureActiveSession(message.senderId, this.options.config.defaultCwd);

    const command = parseCommand(message.text);
    const pendingApiAdd = this.pendingApiProfileAdds.get(message.senderId);
    if (pendingApiAdd && Date.now() >= pendingApiAdd.expiresAt) {
      this.pendingApiProfileAdds.delete(message.senderId);
      if (!command) {
        await this.reply(message.senderId, "API Key 等待已超时，密钥未保存。请重新发送 /api add。");
        return;
      }
    } else if (pendingApiAdd) {
      if (command?.name === "api" && command.arg.trim().toLowerCase() === "cancel") {
        this.pendingApiProfileAdds.delete(message.senderId);
        await this.reply(message.senderId, "已取消添加 API，未保存任何密钥。");
        return;
      }
      if (command) {
        await this.reply(message.senderId, "正在等待 API Key。请单独发送密钥，或发送 /api cancel 取消。");
        return;
      }
      await this.handlePendingApiKey(message, pendingApiAdd);
      return;
    }

    const pendingApiOperation = this.pendingApiProfileOperations.get(message.senderId);
    if (pendingApiOperation && Date.now() >= pendingApiOperation.expiresAt) {
      this.pendingApiProfileOperations.delete(message.senderId);
    } else if (pendingApiOperation && !command) {
      if (isDirectApiSwitchConfirmation(message.text)) {
        await this.confirmPendingApiProfileOperation(message.senderId);
        return;
      }
      if (isDirectApiSwitchCancellation(message.text)) {
        this.pendingApiProfileOperations.delete(message.senderId);
        await this.reply(message.senderId, "已取消 API 切换，当前任务继续执行。");
        return;
      }
    }

    if (command) {
      await this.handleCommand(message, command);
      return;
    }

    if (this.buffers.isActive(message.senderId)) {
      const items = await this.promptItemsFromMessageWithNotice(message);
      if (!items) return;
      for (const item of items) {
        this.buffers.append(message.senderId, item);
      }
      await this.reply(message.senderId, "Buffered. Send /prompt done when ready.");
      return;
    }

    const runtimeReady = this.options.waitForRuntimeReady?.();
    if (runtimeReady) {
      await runtimeReady;
    }
    const control = this.beginTurn(message.senderId);
    try {
      const items = await this.promptItemsFromMessageWithNotice(message);
      if (!items || control.cancelled) return;
      await this.runCodexTurn(message, "", items, control);
    } finally {
      this.finishTurn(message.senderId, control);
    }
  }

  private async handleCommand(message: NormalizedWeixinMessage, command: { name: string; arg: string }): Promise<void> {
    switch (command.name) {
      case "help":
      case "h":
        await this.reply(message.senderId, helpText());
        return;
      case "status":
      case "where":
        await this.reply(message.senderId, await this.statusText(message.senderId));
        return;
      case "bind":
        await this.bindWorkspace(message.senderId, command.arg);
        return;
      case "new":
        this.options.stateStore.createSession(message.senderId, this.options.stateStore.getWorkspace(message.senderId) ?? this.options.config.defaultCwd);
        await this.reply(message.senderId, "Created a new Codex session for the next message.");
        return;
      case "resume":
        await this.handleResumeCommand(message.senderId, command.arg);
        return;
      case "model":
        await this.handleModelCommand(message.senderId, command.arg);
        return;
      case "effort":
        await this.handleEffortCommand(message.senderId, command.arg);
        return;
      case "stream":
        await this.handleStreamCommand(message.senderId, command.arg);
        return;
      case "prompt":
        await this.handlePromptCommand(message.senderId, command.arg);
        return;
      case "api":
        await this.handleApiCommand(message.senderId, command.arg);
        return;
      case "stop": {
        if (!this.cancelTurn(message.senderId)) {
          await this.reply(message.senderId, "No active task.");
          return;
        }
        this.requestRunnerStop(this.options.stateStore.getThread(message.senderId));
        await this.reply(message.senderId, "Current task stopped.");
        return;
      }
      default:
        await this.reply(message.senderId, `无法识别指令 /${command.name || "(空)"}。发送 /help 查看全部指令和用法。`);
    }
  }

  private async handleApiCommand(senderId: string, arg: string): Promise<void> {
    const apiProfiles = this.options.apiProfiles;
    if (!apiProfiles) {
      await this.reply(senderId, "API 配置功能当前不可用，请重启 codex-weixin 后重试。");
      return;
    }

    const input = arg.trim();
    if (!input || input.toLowerCase() === "list" || input.toLowerCase() === "help") {
      await this.replyApiProfileList(senderId);
      return;
    }

    const [verb, ...rest] = input.split(/\s+/);
    if (!["confirm", "force", "cancel"].includes(verb.toLowerCase())) {
      this.pendingApiProfileOperations.delete(senderId);
    }
    switch (verb.toLowerCase()) {
      case "add":
        await this.beginApiProfileAdd(senderId, rest);
        return;
      case "cancel":
        if (this.pendingApiProfileOperations.delete(senderId)) {
          await this.reply(senderId, "已取消 API 切换，当前任务继续执行。");
          return;
        }
        await this.reply(senderId, "当前没有等待输入密钥的 API 添加任务。");
        return;
      case "confirm":
      case "force":
        await this.confirmPendingApiProfileOperation(senderId);
        return;
      case "use":
      case "switch":
        await this.beginApiProfileActivation(senderId, rest.join(" ").trim());
        return;
      case "test":
        await this.testApiProfile(senderId, rest.join(" ").trim());
        return;
      case "set":
        await this.setApiProfileDefaults(senderId, rest);
        return;
      default:
        await this.beginApiProfileActivation(senderId, input);
    }
  }

  private async replyApiProfileList(senderId: string): Promise<void> {
    const apiProfiles = this.options.apiProfiles;
    if (!apiProfiles) return;
    const profiles = await apiProfiles.listForDisplay();
    if (!profiles.length) {
      await this.reply(senderId, "尚未保存 API。使用 /api add <名称> <Base URL> <模型ID> 添加。");
      return;
    }
    const lines = ["API 配置：", ""];
    for (const [index, profile] of profiles.entries()) {
      lines.push(
        `${index + 1}. ${profile.active ? "【当前使用】" : "【已保存】"}`,
        `名称：${singleLine(profile.name)}`,
        `URL：${profile.baseUrl}`,
        `API 密钥后四位：${profile.apiKeyLastFour ?? "无法读取"}`,
        ""
      );
    }
    lines.push(
      "切换：/api 2、/api use 2 或 /api use <名称>",
      "强制切换确认：检测到执行中任务时，发送 /api confirm",
      "测试：/api test 2",
      "添加：/api add <名称> <Base URL> [模型ID]",
      "取消密钥输入：/api cancel"
    );
    for (const chunk of chunkText(lines.join("\n"))) {
      await this.reply(senderId, chunk);
    }
  }

  private async beginApiProfileAdd(senderId: string, args: string[]): Promise<void> {
    const apiProfiles = this.options.apiProfiles;
    if (!apiProfiles) return;
    if (args.length < 2 || args.length > 4) {
      await this.reply(senderId, "用法：/api add <名称> <Base URL> [模型ID] [推理强度]\n示例：/api add 备用API https://api.example.com/v1 gpt-5.6-terra medium");
      return;
    }
    const [name, baseUrl, requestedModel, requestedEffort] = args;
    const model = requestedModel ?? apiProfiles.getActive()?.model ?? this.options.config.model;
    const effort = requestedEffort ?? apiProfiles.getActive()?.effort ?? this.options.config.effort ?? "medium";
    if (!model) {
      await this.reply(senderId, "无法确定模型ID，请在命令末尾明确填写模型ID。");
      return;
    }
    if (apiProfiles.list().some((profile) => profile.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0)) {
      await this.reply(senderId, `API 名称“${singleLine(name)}”已存在，请换一个名称。`);
      return;
    }
    let normalized: ReturnType<typeof normalizeCreateApiProfileInput>;
    try {
      normalized = normalizeCreateApiProfileInput({ name, baseUrl, model, effort, apiKey: "pending-key" });
    } catch (error) {
      await this.reply(senderId, apiProfileErrorText(error));
      return;
    }
    this.pendingApiProfileAdds.set(senderId, {
      name: normalized.name,
      baseUrl: normalized.baseUrl,
      model: normalized.model,
      effort: normalized.effort,
      expiresAt: Date.now() + API_KEY_WAIT_MS
    });
    await this.reply(senderId, [
      `准备添加 API：${singleLine(normalized.name)}`,
      `地址：${normalized.baseUrl}`,
      `模型：${normalized.model}`,
      `推理强度：${normalized.effort}`,
      "请在2分钟内单独发送 API Key。下一条纯文本只用于验证和加密保存，不会发送给 Codex。",
      "发送 /api cancel 可取消。验证成功后默认只保存，不自动切换。"
    ].join("\n"));
  }

  private async handlePendingApiKey(message: NormalizedWeixinMessage, pending: PendingApiProfileAdd): Promise<void> {
    const apiProfiles = this.options.apiProfiles;
    if (!apiProfiles) return;
    const apiKey = message.text.trim();
    if (!apiKey || (message.attachments?.length ?? 0) > 0) {
      await this.reply(message.senderId, "请只发送纯文本 API Key，或发送 /api cancel 取消。");
      return;
    }
    if (apiKey.length > 8192) {
      await this.reply(message.senderId, "API Key 长度异常，未保存。请重新输入或发送 /api cancel。");
      return;
    }
    try {
      const result = await apiProfiles.createVerified({
        name: pending.name,
        baseUrl: pending.baseUrl,
        model: pending.model,
        effort: pending.effort,
        apiKey
      });
      this.pendingApiProfileAdds.delete(message.senderId);
      const index = apiProfiles.list().findIndex((profile) => profile.id === result.profile.id) + 1;
      await this.reply(message.senderId, [
        `API“${singleLine(result.profile.name)}”验证成功并已加密保存（${result.latencyMs}ms）。`,
        "当前 API 未改变。",
        `需要切换时发送 /api use ${index || result.profile.name}。`
      ].join("\n"));
    } catch (error) {
      this.pendingApiProfileAdds.delete(message.senderId);
      await this.reply(message.senderId, [
        `API 验证失败：${apiProfileErrorText(error)}`,
        `验证地址：${pending.baseUrl}/responses`,
        `验证模型：${pending.model}`,
        "密钥未保存，本次添加流程已结束。请修正地址或模型后重新发送 /api add。"
      ].join("\n"));
    }
  }

  private async testApiProfile(senderId: string, selector: string): Promise<void> {
    const apiProfiles = this.options.apiProfiles;
    if (!apiProfiles) return;
    const profile = selectApiProfile(apiProfiles.list(), selector);
    if (!profile) {
      await this.reply(senderId, "没有找到该 API。发送 /api 查看编号和名称。");
      return;
    }
    await this.reply(senderId, `正在测试 API“${singleLine(profile.name)}”...`);
    try {
      const result = await apiProfiles.test(profile.id);
      await this.reply(senderId, `API“${singleLine(profile.name)}”可用，响应耗时 ${result.latencyMs}ms。`);
    } catch (error) {
      await this.reply(senderId, `API“${singleLine(profile.name)}”测试失败：${apiProfileErrorText(error)}`);
    }
  }

  private async setApiProfileDefaults(senderId: string, args: string[]): Promise<void> {
    const apiProfiles = this.options.apiProfiles;
    if (!apiProfiles) return;
    if (args.length !== 3) {
      await this.reply(senderId, "用法：/api set <编号或名称> <模型ID> <推理强度>\n示例：/api set 1 gpt-5.6-sol max");
      return;
    }
    const [selector, model, effort] = args;
    const profile = selectApiProfile(apiProfiles.list(), selector);
    if (!profile) {
      await this.reply(senderId, "没有找到该 API。发送 /api 查看编号和名称。");
      return;
    }
    try {
      if (apiProfiles.validateDefaults) {
        apiProfiles.validateDefaults(profile.id, model, effort);
      } else {
        normalizeCreateApiProfileInput({
          name: profile.name,
          baseUrl: profile.baseUrl,
          model,
          effort,
          apiKey: "validation-only"
        });
      }
    } catch (error) {
      await this.reply(senderId, apiProfileErrorText(error));
      return;
    }
    if (profile.active && (profile.model !== model || profile.effort !== effort)) {
      if (await this.requestApiSwitchConfirmation(senderId, {
        kind: "set-defaults",
        profileId: profile.id,
        model,
        effort
      })) {
        return;
      }
    }
    await this.scheduleApiProfileDefaults(senderId, profile, model, effort);
  }

  private async scheduleApiProfileDefaults(
    senderId: string,
    profile: ApiProfileSummary,
    model: string,
    effort: string,
    interruptActiveTasks = false
  ): Promise<void> {
    await this.reply(senderId, `正在设置 API“${singleLine(profile.name)}”的默认模型和推理强度...`);
    this.defer(async () => {
      try {
        const apiProfiles = this.options.apiProfiles;
        if (!apiProfiles) return;
        const updated = await apiProfiles.setDefaults(
          profile.id,
          model,
          effort,
          interruptActiveTasks ? { interruptActiveTasks: true } : undefined
        );
        await this.reply(senderId, [
          `API“${singleLine(updated.name)}”默认值已更新。`,
          `模型：${updated.model}`,
          `推理强度：${updated.effort}`,
          updated.active ? "当前 API 已重新应用，新旧会话均使用这组默认值。" : "下次切换到该 API 时自动应用。"
        ].join("\n"));
      } catch (error) {
        await this.reply(senderId, `API 默认值更新失败：${apiProfileErrorText(error)}`);
      }
    });
  }

  private async beginApiProfileActivation(senderId: string, selector: string): Promise<void> {
    const apiProfiles = this.options.apiProfiles;
    if (!apiProfiles) return;
    const profile = selectApiProfile(apiProfiles.list(), selector);
    if (!profile) {
      await this.reply(senderId, "没有找到该 API。发送 /api 查看编号和名称。");
      return;
    }
    if (profile.active) {
      await this.reply(senderId, `API“${singleLine(profile.name)}”已经是当前配置。`);
      return;
    }
    if (await this.requestApiSwitchConfirmation(senderId, {
      kind: "activate",
      profileId: profile.id
    })) {
      return;
    }
    await this.scheduleApiProfileActivation(senderId, profile);
  }

  private async scheduleApiProfileActivation(
    senderId: string,
    profile: ApiProfileSummary,
    interruptActiveTasks = false
  ): Promise<void> {
    await this.reply(senderId, `正在测试并切换到 API“${singleLine(profile.name)}”，切换会重启 Codex 运行层...`);
    this.defer(async () => {
      try {
        const apiProfiles = this.options.apiProfiles;
        if (!apiProfiles) return;
        const active = await apiProfiles.activate(
          profile.id,
          interruptActiveTasks ? { interruptActiveTasks: true } : undefined
        );
        await this.reply(senderId, `API 已切换为“${singleLine(active.name)}”。模型：${active.model}；推理强度：${active.effort}`);
      } catch (error) {
        await this.reply(senderId, `API 切换失败：${apiProfileErrorText(error)}\n原 API 保持不变。`);
      }
    });
  }

  private async requestApiSwitchConfirmation(
    senderId: string,
    operation: PendingApiProfileOperationInput
  ): Promise<boolean> {
    const activeTaskCount = this.options.apiProfiles?.getActiveTaskCount?.() ?? 0;
    if (!activeTaskCount) return false;
    this.pendingApiProfileOperations.set(senderId, {
      ...operation,
      expiresAt: Date.now() + API_SWITCH_CONFIRM_WAIT_MS
    } as PendingApiProfileOperation);
    await this.reply(senderId, [
      `检测到 ${activeTaskCount} 个正在执行的任务。`,
      "直接切换会结束这些任务，且无法恢复。",
      "发送 /api confirm 继续；发送 /api cancel 取消切换。"
    ].join("\n"));
    return true;
  }

  private async confirmPendingApiProfileOperation(senderId: string): Promise<void> {
    const pending = this.pendingApiProfileOperations.get(senderId);
    if (!pending || Date.now() >= pending.expiresAt) {
      this.pendingApiProfileOperations.delete(senderId);
      await this.reply(senderId, "没有等待确认的 API 切换。请先发送 /api use <编号或名称>。");
      return;
    }
    this.pendingApiProfileOperations.delete(senderId);
    const apiProfiles = this.options.apiProfiles;
    const profile = apiProfiles?.list().find((candidate) => candidate.id === pending.profileId);
    if (!apiProfiles || !profile) {
      await this.reply(senderId, "待切换的 API 已不存在。请发送 /api 查看当前配置。");
      return;
    }
    if (pending.kind === "activate") {
      if (profile.active) {
        await this.reply(senderId, `API“${singleLine(profile.name)}”已经是当前配置。`);
        return;
      }
      await this.scheduleApiProfileActivation(senderId, profile, true);
      return;
    }
    await this.scheduleApiProfileDefaults(senderId, profile, pending.model, pending.effort, true);
  }

  private defer(task: () => Promise<void>): void {
    if (this.options.deferTask) {
      this.options.deferTask(task);
      return;
    }
    const timer = setTimeout(() => {
      void task().catch((error) => {
        console.error(`[codex-weixin] deferred command failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 50);
    timer.unref();
  }

  private async bindWorkspace(senderId: string, rawPath: string): Promise<void> {
    if (!rawPath.trim()) {
      await this.reply(senderId, "Usage: /bind <absolute-workspace-path>");
      return;
    }
    const workspace = path.resolve(rawPath.trim());
    if (!isWorkspaceAllowed(workspace, this.options.config.allowedWorkspaces)) {
      await this.reply(senderId, `Workspace is not allowed: ${workspace}`);
      return;
    }
    this.options.stateStore.setWorkspace(senderId, workspace);
    await this.reply(senderId, `Bound to workspace:\n${workspace}`);
  }

  private async handleResumeCommand(senderId: string, arg: string): Promise<void> {
    const sessions = this.options.stateStore.listSessions().filter((session) => session.senderId === senderId);
    const input = arg.trim();
    if (!input) {
      const activeId = this.options.stateStore.getActiveSession(senderId)?.id;
      const previews = await Promise.all(sessions.map((session) => this.sessionPromptPreview(session)));
      const lines = ["历史会话（最近更新优先）："];
      for (const [index, session] of sessions.entries()) {
        lines.push(
          `[R${index + 1}] ${session.id === activeId ? "【当前】" : ""}${session.title}`,
          `   最近内容：${previews[index]}（${formatSessionTime(session.updatedAt)}）`
        );
      }
      lines.push("", "发送 /resume R1 这类切换编号继续会话；R1 是切换编号，“会话 6”等是会话名称。");
      for (const chunk of chunkText(lines.join("\n"))) {
        await this.reply(senderId, chunk);
      }
      return;
    }
    if (/^\d+$/.test(input)) {
      await this.reply(senderId, "请使用列表中 R 开头的切换编号，例如 /resume R1；不要使用会话名称里的数字。");
      return;
    }
    const match = /^r([1-9]\d*)$/i.exec(input);
    if (!match) {
      await this.reply(senderId, "用法：/resume 或 /resume R<编号>，例如 /resume R1。");
      return;
    }
    const selected = sessions[Number(match[1]) - 1];
    if (!selected) {
      await this.reply(senderId, "没有这个切换编号。发送 /resume 查看可用的 R 编号。");
      return;
    }
    const preview = await this.sessionPromptPreview(selected);
    this.options.stateStore.activateSession(selected.id);
    await this.reply(senderId, [
      `已通过 ${input.toUpperCase()} 切换到：${selected.title}`,
      `最近内容：${preview}`,
      selected.threadId ? "下一条消息将继续该历史会话。" : "该会话尚无历史内容，下一条消息将创建新上下文。"
    ].join("\n"));
  }

  private async sessionPromptPreview(session: ManagedSession): Promise<string> {
    if (session.lastPromptPreview) return session.lastPromptPreview;
    if (!session.threadId) return "尚未开始对话";
    try {
      const history = await this.runner.getHistory(session.threadId);
      const lastUserMessage = [...history].reverse().find((message) => message.role === "user");
      if (!lastUserMessage) return "暂无内容摘要";
      const parsed = parsePrompt(lastUserMessage.text);
      const preview = buildPromptPreview(parsed.text, parsed.attachments);
      if (!preview) return "暂无内容摘要";
      this.options.stateStore.setSessionPromptPreview(session.id, preview);
      return preview;
    } catch (error) {
      console.warn(`Unable to read Codex history for session ${session.id}: ${error instanceof Error ? error.message : String(error)}`);
      return "历史摘要暂不可用";
    }
  }

  private async handlePromptCommand(senderId: string, arg: string): Promise<void> {
    const sub = arg.trim().toLowerCase();
    if (sub === "start") {
      const result = this.buffers.start(senderId);
      await this.reply(senderId, result.status === "started" ? "Prompt buffer started." : "Prompt buffer is already active.");
      return;
    }
    if (sub === "done") {
      const flushed = this.buffers.done(senderId);
      if (flushed.status === "empty") {
        await this.reply(senderId, "Prompt buffer is empty.");
        return;
      }
      const runtimeReady = this.options.waitForRuntimeReady?.();
      if (runtimeReady) {
        await runtimeReady;
      }
      await this.runCodexTurn({ id: "buffer", senderId, text: "", attachments: [], raw: {} }, "", flushed.items);
      return;
    }
    await this.reply(senderId, "Usage: /prompt start or /prompt done");
  }

  private async handleModelCommand(senderId: string, arg: string): Promise<void> {
    const models = await this.listCodexModels();
    const input = arg.trim();
    if (!input) {
      const runtime = await this.effectiveRuntime(senderId);
      const session = this.options.stateStore.getActiveSession(senderId);
      const lines = [
        `当前模型：${runtime.model ?? "Codex 默认"}${session?.model ? "（本会话）" : "（继承 Web/Codex 设置）"}`
      ];
      if (models.length) {
        lines.push("", "可用模型：", ...models.map((model, index) => `${index + 1}. ${model.displayName}（${model.model}）`));
        lines.push("", "发送 /model <序号或模型 ID> 切换；/model default 恢复继承设置。");
      } else {
        lines.push("", "暂时无法读取模型列表。仍可发送 /model <完整模型 ID> 切换。", "/model default 恢复继承设置。");
      }
      await this.reply(senderId, lines.join("\n"));
      return;
    }
    if (input.toLowerCase() === "default") {
      this.options.stateStore.setModelOverride(senderId);
      const runtime = await this.effectiveRuntime(senderId);
      await this.reply(senderId, `已恢复继承 Web/Codex 模型设置。\n当前模型：${runtime.model ?? "Codex 默认"}`);
      return;
    }

    const selected = selectModel(models, input);
    if (!selected && (models.length || !isPlausibleModelId(input))) {
      await this.reply(senderId, "模型不存在。发送 /model 查看可用模型，或使用 /model default 恢复继承设置。");
      return;
    }
    const currentRuntime = await this.effectiveRuntime(senderId);
    const model = selected?.model ?? input;
    this.options.stateStore.setModelOverride(senderId, model);
    let adjustedEffort: string | undefined;
    if (currentRuntime.effort && selected?.supportedEfforts.length && !selected.supportedEfforts.some((option) => option.effort === currentRuntime.effort)) {
      adjustedEffort = selected.supportedEfforts.some((option) => option.effort === selected.defaultEffort)
        ? selected.defaultEffort
        : selected.supportedEfforts[0]?.effort;
      this.options.stateStore.setEffortOverride(senderId, adjustedEffort);
    }
    await this.reply(senderId, [
      `本会话模型已切换为：${selected?.displayName ?? model}（${model}）`,
      ...(adjustedEffort ? [`原来的推理强度不受该模型支持，已自动调整为：${formatEffort(adjustedEffort)}`] : []),
      "下一条消息开始生效。"
    ].join("\n"));
  }

  private async handleEffortCommand(senderId: string, arg: string): Promise<void> {
    const models = await this.listCodexModels();
    const runtime = await this.effectiveRuntime(senderId);
    const model = models.find((option) => option.model === runtime.model);
    const efforts = availableEfforts(model, models);
    const input = arg.trim();
    if (!input) {
      const session = this.options.stateStore.getActiveSession(senderId);
      await this.reply(senderId, [
        `当前推理强度：${formatEffort(runtime.effort)}${session?.effort ? "（本会话）" : "（继承 Web/Codex 设置）"}`,
        `当前模型：${runtime.model ?? "Codex 默认"}`,
        "",
        "可用推理强度：",
        ...efforts.map((effort, index) => `${index + 1}. ${formatEffort(effort)}`),
        "",
        "发送 /effort <序号或英文值> 切换；/effort default 恢复继承设置。"
      ].join("\n"));
      return;
    }
    if (input.toLowerCase() === "default") {
      this.options.stateStore.setEffortOverride(senderId);
      const nextRuntime = await this.effectiveRuntime(senderId);
      await this.reply(senderId, `已恢复继承 Web/Codex 推理强度设置。\n当前推理强度：${formatEffort(nextRuntime.effort)}`);
      return;
    }
    const effort = selectEffort(efforts, input);
    if (!effort) {
      await this.reply(senderId, "该模型不支持这个推理强度。发送 /effort 查看可用选项。");
      return;
    }
    this.options.stateStore.setEffortOverride(senderId, effort);
    await this.reply(senderId, `本会话推理强度已切换为：${formatEffort(effort)}\n下一条消息开始生效。`);
  }

  private async handleStreamCommand(senderId: string, arg: string): Promise<void> {
    const input = arg.trim().toLowerCase();
    const session = this.options.stateStore.getActiveSession(senderId);
    const inherited = this.options.config.streamReplies;
    if (!input) {
      const effective = session?.streamReplies ?? inherited;
      const source = typeof session?.streamReplies === "boolean" ? "本会话设置" : "继承全局";
      await this.reply(senderId, `当前过程进度：${effective ? "开启" : "关闭"}（${source}）\n发送 /stream on、/stream off 或 /stream default 切换。`);
      return;
    }
    if (input === "default") {
      this.options.stateStore.setStreamRepliesOverride(senderId);
      await this.reply(senderId, `已恢复继承全局设置。当前过程进度：${inherited ? "开启" : "关闭"}。`);
      return;
    }
    if (input !== "on" && input !== "off") {
      await this.reply(senderId, "用法：/stream on、/stream off 或 /stream default");
      return;
    }
    const enabled = input === "on";
    this.options.stateStore.setStreamRepliesOverride(senderId, enabled);
    await this.reply(senderId, `本会话过程进度已${enabled ? "开启" : "关闭"}。`);
  }

  private async promptItemsFromMessage(message: NormalizedWeixinMessage): Promise<PromptBufferItem[]> {
    const items: PromptBufferItem[] = [];
    if (message.text.trim()) {
      items.push({ kind: "text", text: message.text });
    }
    const attachments = message.attachments ?? [];
    if (!attachments.length) {
      return items;
    }
    try {
      const downloaded = await downloadInboundAttachments({
        rootDir: this.options.inboundDir ?? path.join(this.options.config.defaultCwd, ".codex-weixin-inbound"),
        senderId: message.senderId,
        messageId: message.id,
        attachments,
        maxBytes: this.options.config.maxInboundBytes,
        fetch: this.options.mediaFetch
      });
      for (const attachment of downloaded) {
        items.push({
          kind: attachment.kind,
          path: attachment.path,
          label: attachment.label
        });
      }
    } catch (error) {
      if (error instanceof InboundMediaTooLargeError) throw error;
      items.push({
        kind: "text",
        text: `[WeChat attachment download failed: ${error instanceof Error ? error.message : String(error)}]`
      });
    }
    return items;
  }

  private async promptItemsFromMessageWithNotice(message: NormalizedWeixinMessage): Promise<PromptBufferItem[] | undefined> {
    try {
      return await this.promptItemsFromMessage(message);
    } catch (error) {
      if (!(error instanceof InboundMediaTooLargeError)) throw error;
      const maxMiB = Math.floor(error.maxBytes / (1024 * 1024));
      await this.reply(message.senderId, `附件超过 ${maxMiB} MiB 上限，请压缩或裁剪后重新发送。`);
      return undefined;
    }
  }

  private async runCodexTurn(
    message: NormalizedWeixinMessage,
    text: string,
    attachments: PromptBufferItem[] = [],
    existingControl?: ActiveTurnControl
  ): Promise<void> {
    const control = existingControl ?? this.beginTurn(message.senderId);
    const ownsControl = !existingControl;
    const session = this.options.stateStore.ensureActiveSession(message.senderId, this.options.config.defaultCwd);
    const promptPreview = buildPromptPreview(text, attachments);
    if (promptPreview) {
      this.options.stateStore.setSessionPromptPreview(session.id, promptPreview);
    }
    const workspace = this.options.stateStore.getWorkspace(message.senderId) ?? this.options.config.defaultCwd;
    const threadId = this.options.stateStore.getThread(message.senderId) || undefined;
    const progressEnabled = session.streamReplies ?? this.options.config.streamReplies;
    const sentProgress = new Set<string>();
    this.options.onTurnStatus?.({ senderId: message.senderId, sessionId: session.id, active: true });
    try {
      if (control.cancelled) return;
      await this.withTyping(message.senderId, async () => {
        if (control.cancelled) return;
        console.log(`[codex-weixin] starting Codex turn for ${message.senderId} in ${workspace}`);
        const turnResult = await this.runUntilVisibleFinalReport({
          senderId: message.senderId,
          prompt: buildPrompt(text, attachments),
          workspace,
          threadId,
          model: session.model ?? this.options.config.model,
          effort: session.effort ?? this.options.config.effort,
          onProgress: progressEnabled ? async (progress: string) => {
            const progressText = progress.trim();
            if (!progressText || sentProgress.has(progressText)) return;
            sentProgress.add(progressText);
            await this.reply(message.senderId, `【进度】${progressText}`);
          } : undefined,
          isCancelled: () => control.cancelled
        });
        if (control.cancelled) return;
        const result = turnResult.result;
        console.log(`[codex-weixin] Codex turn completed for ${message.senderId}; text=${result.text.length} chars`);
        if (result.threadId) {
          this.options.stateStore.setThread(message.senderId, result.threadId);
        }
        const parsed = parseActionBlocks(result.text);
        const remaining = chunkText(parsed.visibleText);
        if (remaining.length) {
          for (const chunk of remaining) {
            if (control.cancelled) return;
            await this.reply(message.senderId, chunk);
          }
        }
        const actionsByPath = new Map<string, SendAction>();
        for (const action of [...turnResult.pendingSendActions, ...parsed.actions.send]) {
          actionsByPath.set(action.path.toLowerCase(), action);
        }
        for (const action of actionsByPath.values()) {
          if (control.cancelled) return;
          await this.sendLocalMedia(message.senderId, action);
        }
      });
    } catch (error) {
      if (!control.cancelled) throw error;
      console.log(`[codex-weixin] cancelled Codex turn for ${message.senderId}`);
    } finally {
      this.options.onTurnStatus?.({ senderId: message.senderId, sessionId: session.id, active: false });
      if (ownsControl) this.finishTurn(message.senderId, control);
    }
  }

  private async runWithUnclassifiedRetries(input: {
    senderId: string;
    prompt: string;
    workspace: string;
    threadId?: string;
    model?: string;
    effort?: string;
    onProgress?: (progress: string) => Promise<void>;
    isCancelled: () => boolean;
  }): Promise<{ raw: string; text: string; threadId?: string }> {
    let retryAttempt = 0;
    let threadId = input.threadId;

    while (true) {
      const prompt = retryAttempt > 0 && threadId
        ? buildPrompt([
          "上一轮任务因内部未分类错误中断。请从当前会话继续完成上一轮任务。",
          "先核验已完成状态，避免重复已经完成的外部操作；只完成尚未完成的部分，并直接给出最终结果。"
        ].join("\n"))
        : input.prompt;
      try {
        return await this.runner.run({
          prompt,
          cwd: input.workspace,
          threadId,
          model: input.model,
          effort: input.effort,
          onThreadStarted: (startedThreadId) => {
            threadId = startedThreadId;
            this.options.stateStore.setThread(input.senderId, startedThreadId);
          },
          onProgress: input.onProgress
        });
      } catch (error) {
        if (input.isCancelled() || !isUnclassifiedMessageHandlingError(error)) {
          throw error;
        }
        retryAttempt += 1;
        threadId = this.options.stateStore.getThread(input.senderId) ?? threadId;
        console.warn(`[codex-weixin] recoverable turn failure for ${input.senderId}; retrying attempt ${retryAttempt}`);
        await this.waitBeforeUnclassifiedRetry(retryAttempt, error);
        if (input.isCancelled()) {
          throw error;
        }
      }
    }
  }

  private async runUntilVisibleFinalReport(input: {
    senderId: string;
    prompt: string;
    workspace: string;
    threadId?: string;
    model?: string;
    effort?: string;
    onProgress?: (progress: string) => Promise<void>;
    isCancelled: () => boolean;
  }): Promise<{
    result: { raw: string; text: string; threadId?: string };
    pendingSendActions: SendAction[];
  }> {
    let result = await this.runWithUnclassifiedRetries(input);
    let reportRetryAttempt = 0;
    const pendingSendActions = new Map<string, SendAction>();

    while (true) {
      const parsed = parseActionBlocks(result.text);
      if (hasVisibleFinalReport(parsed.visibleText)) {
        return { result, pendingSendActions: [...pendingSendActions.values()] };
      }
      for (const action of parsed.actions.send) {
        pendingSendActions.set(action.path.toLowerCase(), action);
      }
      if (input.isCancelled()) {
        return { result, pendingSendActions: [...pendingSendActions.values()] };
      }
      reportRetryAttempt += 1;
      const threadId = result.threadId ?? this.options.stateStore.getThread(input.senderId) ?? input.threadId;
      if (result.threadId) {
        this.options.stateStore.setThread(input.senderId, result.threadId);
      }
      console.warn(`[codex-weixin] turn for ${input.senderId} ended without a visible final report; requesting report attempt ${reportRetryAttempt}`);
      await this.waitBeforeUnclassifiedRetry(reportRetryAttempt, new Error("missing visible final report"));
      if (input.isCancelled()) {
        return { result, pendingSendActions: [...pendingSendActions.values()] };
      }
      result = await this.runWithUnclassifiedRetries({
        ...input,
        prompt: buildPrompt(MISSING_FINAL_REPORT_PROMPT),
        threadId,
        onProgress: undefined
      });
    }
  }

  private async waitBeforeUnclassifiedRetry(retryAttempt: number, error: unknown): Promise<void> {
    if (this.options.retryDelay) {
      await this.options.retryDelay(retryAttempt);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const providerUnderPressure = /\b429\b|rate limit|quota|at capacity|capacity exceeded|temporarily overloaded|overloaded/i.test(message);
    const delayMs = providerUnderPressure
      ? Math.min(retryAttempt * 5_000, 60_000)
      : Math.min(retryAttempt * 1_000, 10_000);
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  private beginTurn(senderId: string): ActiveTurnControl {
    const control = { cancelled: false };
    this.activeTurns.set(senderId, control);
    return control;
  }

  private finishTurn(senderId: string, control: ActiveTurnControl): void {
    if (this.activeTurns.get(senderId) === control) {
      this.activeTurns.delete(senderId);
    }
  }

  private cancelTurn(senderId: string): boolean {
    const control = this.activeTurns.get(senderId);
    if (!control) return false;
    control.cancelled = true;
    this.activeTurns.delete(senderId);
    return true;
  }

  private requestRunnerStop(threadId?: string, runner = this.runner): void {
    let stop: Promise<void>;
    try {
      stop = runner.stop(threadId);
    } catch (error) {
      console.warn(`[codex-weixin] unable to interrupt Codex turn: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    void this.observeRunnerStop(stop);
  }

  private async observeRunnerStop(stop: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        stop,
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`runner stop timed out after ${RUNNER_STOP_TIMEOUT_MS}ms`)), RUNNER_STOP_TIMEOUT_MS);
          timer.unref();
        })
      ]);
    } catch (error) {
      console.warn(`[codex-weixin] Codex turn interrupt did not complete: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async sendLocalMedia(senderId: string, action: { type: "image" | "file" | "video"; path: string }): Promise<void> {
    try {
      await sendLocalMediaFile({
        client: this.options.weixin,
        toUserId: senderId,
        contextToken: this.options.stateStore.getContextToken(senderId),
        filePath: action.path,
        kind: action.type
      });
    } catch (error) {
      await this.reply(senderId, `[codex-weixin] Failed to send ${action.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async withTyping(senderId: string, run: () => Promise<void>): Promise<void> {
    const sendTyping = async (typing: boolean) => {
      try {
        await this.options.weixin.sendTyping({
          toUserId: senderId,
          contextToken: this.options.stateStore.getContextToken(senderId),
          typing
        });
      } catch (error) {
        console.warn(`WeChat typing indicator failed for ${senderId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    await sendTyping(true);
    const timer = setInterval(() => {
      void sendTyping(true);
    }, 5_000);
    try {
      await run();
    } finally {
      clearInterval(timer);
      await sendTyping(false);
    }
  }

  private async statusText(senderId: string): Promise<string> {
    const session = this.options.stateStore.getActiveSession(senderId);
    const workspace = session?.workspace ?? this.options.config.defaultCwd;
    const runtime = await this.effectiveRuntime(senderId);
    const activeApi = this.options.apiProfiles?.getActive();
    return [
      "codex-weixin status",
      `api: ${activeApi ? `${singleLine(activeApi.name)} (${activeApi.baseUrl})` : "(not configured)"}`,
      `sender: ${senderId}`,
      `session: ${session?.title ?? "(new)"}`,
      `workspace: ${workspace}`,
      `thread: ${session?.threadId || "(new)"}`,
      `backend: ${this.options.config.codexBackend}`,
      `exec sandbox: ${this.options.config.codexExecSandbox ?? "(Codex default)"}`,
      `model: ${runtime.model ?? "(Codex default)"}`,
      `effort: ${runtime.effort ?? "(Codex default)"}`,
      `stream replies: ${(session?.streamReplies ?? this.options.config.streamReplies) ? "on" : "off"}${typeof session?.streamReplies === "boolean" ? " (session)" : " (global)"}`
    ].join("\n");
  }

  private async listCodexModels(): Promise<CodexModelOption[]> {
    try {
      return await (this.options.listCodexModels?.() ?? this.runner.listModels());
    } catch (error) {
      console.warn(`Codex model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private async effectiveRuntime(senderId: string): Promise<CodexRuntimeInfo> {
    const session = this.options.stateStore.getActiveSession(senderId);
    const workspace = session?.workspace ?? this.options.config.defaultCwd;
    let runtime: CodexRuntimeInfo = {};
    try {
      runtime = await this.runner.getRuntimeInfo(workspace, session?.threadId);
    } catch (error) {
      console.warn(`Codex runtime info unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      model: session?.model ?? this.options.config.model ?? runtime.model,
      effort: session?.effort ?? this.options.config.effort ?? runtime.effort,
      provider: runtime.provider
    };
  }

  private async reply(senderId: string, text: string): Promise<void> {
    const contextToken = this.options.stateStore.getContextToken(senderId);
    try {
      console.log(`[codex-weixin] sending reply to ${senderId}; text=${text.length} chars`);
      await this.options.weixin.sendText({ toUserId: senderId, text, contextToken });
      console.log(`[codex-weixin] sent reply to ${senderId}`);
    } catch (error) {
      if (isStaleContextError(error)) {
        console.warn(`WeChat context token is stale for ${senderId}; ask user to send a fresh message.`);
        return;
      }
      throw error;
    }
  }

  getActiveTaskCount(): number {
    return this.activeTurns.size;
  }

  async cancelActiveTurns(notice?: string): Promise<number> {
    const runner = this.runner;
    const senderIds = [...this.activeTurns.keys()].filter((senderId) => this.cancelTurn(senderId));
    if (notice) {
      await Promise.allSettled(senderIds.map((senderId) => this.reply(senderId, notice)));
    }
    for (const senderId of senderIds) {
      this.requestRunnerStop(this.options.stateStore.getThread(senderId), runner);
    }
    return senderIds.length;
  }

  replaceRuntime(runner: HybridCodexRunner, config: CodexWeixinConfig): void {
    this.runner = runner;
    this.options.config = config;
    this.access = new AccessController({
      allowedSenderIds: config.allowedSenderIds,
      pairedSenderIds: this.options.stateStore.listPairedSenderIds()
    });
  }

  allowSender(senderId: string): void {
    this.access.allow(senderId);
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
  }

  removeSender(senderId: string): void {
    this.access.remove(senderId);
    this.options.stateStore.setPairedSenderIds(this.access.listPairedSenderIds());
  }

  listAllowedSenders(): string[] {
    return this.access.listPairedSenderIds();
  }
}

function parseCommand(text: string): { name: string; arg: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const [name, ...rest] = trimmed.slice(1).split(/\s+/);
  return { name: name.toLowerCase(), arg: rest.join(" ") };
}

function helpText(): string {
  return [
    "codex-weixin 指令：",
    "/help - 查看全部指令和用法",
    "/status - 查看当前 API、模型、推理强度和会话状态",
    "/api - 查看已保存 API 和当前使用项",
    "/api <编号或名称> - 测试并切换 API",
    "/api confirm - 确认结束执行中任务并切换 API",
    "/api test <编号或名称> - 只测试 API，不切换",
    "/api set <编号或名称> <模型ID> <推理强度> - 设置 API 默认值",
    "/api add <名称> <Base URL> [模型ID] - 安全添加 API",
    "/api cancel - 取消等待输入 API Key 或待确认的 API 切换",
    "/bind <绝对路径> - 绑定工作目录",
    "/new - 创建新的 Codex 会话",
    "/resume [R编号] - 查看或切换历史会话",
    "/model [编号|模型ID|default] - 查看或切换当前会话模型",
    "/effort [编号|等级|default] - 查看或切换推理强度",
    "/stream [on|off|default] - 查看或切换流式进度",
    "/prompt start - 开始缓存多条消息",
    "/prompt done - 提交已缓存消息",
    "/stop - 立即中止当前 Codex 任务"
  ].join("\n");
}

function selectApiProfile(profiles: ApiProfileSummary[], selector: string): ApiProfileSummary | undefined {
  const input = selector.trim();
  const numberMatch = /^#?([1-9]\d*)$/.exec(input);
  if (numberMatch) {
    return profiles[Number(numberMatch[1]) - 1];
  }
  return profiles.find((profile) => profile.name.localeCompare(input, undefined, { sensitivity: "accent" }) === 0);
}

function isDirectApiSwitchConfirmation(input: string): boolean {
  return /^(直接切换|确认切换|确认)$/u.test(input.trim());
}

function isDirectApiSwitchCancellation(input: string): boolean {
  return /^(取消|不切换)$/u.test(input.trim());
}

function apiProfileErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/authentication/i.test(message)) return "API Key 认证失败，请检查密钥。";
  if (/rate limit|quota|429/i.test(message)) return "已连接到 API 地址，但服务端返回 HTTP 429（请求过多或额度受限）。";
  const serverStatus = /\b(5\d{2})\b/.exec(message)?.[1];
  if (serverStatus || /temporarily unavailable/i.test(message)) {
    return `已连接到 API 地址，但 /responses 返回 HTTP ${serverStatus ?? "5xx"}；通常是中转上游故障或当前模型不可用。`;
  }
  if (/timed out/i.test(message)) return "连接 API 超时。";
  if (/unable to connect/i.test(message)) return "无法连接 API 地址。";
  if (/Responses endpoint/i.test(message)) return "未找到 /responses 接口，请确认 Base URL 通常以 /v1 结尾。";
  if (/invalid Responses/i.test(message)) return "API 返回格式不兼容 Responses 接口。";
  const requestStatus = /status\s+(\d{3})/i.exec(message)?.[1];
  if (requestStatus) return `已连接到 API 地址，但 /responses 返回 HTTP ${requestStatus}；请检查模型ID和接口兼容性。`;
  if (/already exists/i.test(message)) return "同名 API 已存在。";
  if (/previous API remains active/i.test(message)) return "新 API 未能成功启动，已保留原 API。";
  if (error instanceof ApiProfileError) {
    if (error.code === "VALIDATION") return "API 配置或响应验证失败。";
    if (error.code === "CONFLICT") return "API 配置存在冲突。";
    if (error.code === "STORAGE") return "API 加密配置存储失败。";
    if (error.code === "NOT_FOUND") return "API 配置不存在。";
  }
  return "API 操作失败，详细原因已写入本机服务日志。";
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const fallbackEfforts = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function selectModel(models: CodexModelOption[], input: string): CodexModelOption | undefined {
  if (/^\d+$/.test(input)) {
    return models[Number(input) - 1];
  }
  const normalized = input.toLowerCase();
  return models.find((model) => model.model.toLowerCase() === normalized);
}

function isPlausibleModelId(input: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(input);
}

function availableEfforts(model: CodexModelOption | undefined, models: CodexModelOption[]): string[] {
  const advertised = model?.supportedEfforts.length
    ? model.supportedEfforts.map((option) => option.effort)
    : models.flatMap((option) => option.supportedEfforts.map((effort) => effort.effort));
  return advertised.length ? [...new Set(advertised)] : fallbackEfforts;
}

function selectEffort(efforts: string[], input: string): string | undefined {
  if (/^\d+$/.test(input)) {
    return efforts[Number(input) - 1];
  }
  const normalized = input.toLowerCase();
  return efforts.find((effort) => effort.toLowerCase() === normalized);
}

function formatEffort(effort?: string): string {
  if (!effort) return "Codex 默认";
  const labels: Record<string, string> = {
    minimal: "最小",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最大",
    ultra: "极高"
  };
  return labels[effort] ? `${labels[effort]}（${effort}）` : effort;
}
