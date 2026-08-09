import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseActionBlocks, type SendAction } from "../bridge/actions.js";
import {
  buildPrompt,
  buildPromptPreview,
  hasVisibleFinalReport,
  MAX_FINAL_REPORT_RECOVERY_ATTEMPTS,
  MISSING_FINAL_REPORT_FALLBACK,
  MISSING_FINAL_REPORT_PROMPT,
  parsePrompt
} from "../bridge/format.js";
import type { PromptBufferItem } from "../bridge/prompt-buffer.js";
import { BridgeService, type ApiProfileCommandService } from "../bridge/service.js";
import { userFacingMessageHandlingError } from "../bridge/errors.js";
import type { CodexHistoryMessage, CodexModelOption, CodexRuntimeInfo } from "../codex/app-server-runner.js";
import { HybridCodexRunner } from "../codex/runner.js";
import { isWorkspaceAllowed, loadConfig, type CodexWeixinConfig } from "../state/config.js";
import { accountStatePaths, type StatePaths } from "../state/paths.js";
import { RuntimeStateStore, type ManagedSession, type SessionRuntimeOverrides } from "../state/runtime-state.js";
import {
  deleteAccount,
  forgetRetainedAccount,
  listAccounts,
  loadAccount,
  publicAccount,
  retainAccountHistory,
  setAccountDisplayName,
  setAccountEnabled,
  type PublicWeixinAccount,
  type WeixinAccount
} from "../weixin/accounts.js";
import { WeixinApiClient, isStaleContextError } from "../weixin/api.js";
import { monitorWeixin, type MonitorOptions } from "../weixin/monitor.js";
import { inferMediaKind, sanitizeFileName } from "../weixin/media.js";

export type AccountRunStatus = "stopped" | "starting" | "running" | "error";

export type AccountSummary = PublicWeixinAccount & {
  status: AccountRunStatus;
  error?: string;
  pairedSenderIds: string[];
  lastActiveSenderId?: string;
  sessionCount: number;
};

export type AccountSession = ManagedSession & {
  accountId: string;
  active: boolean;
  responding: boolean;
};

export type SessionChatResult = {
  threadId: string;
  message: SessionHistoryMessage;
};

export type SessionUpload = {
  name: string;
  data: Buffer;
};

export type SessionMessageAttachment = {
  index: number;
  type: "image" | "file" | "video";
  name: string;
  size?: number;
  available: boolean;
};

export type SessionHistoryMessage = CodexHistoryMessage & {
  attachments: SessionMessageAttachment[];
};

export type SessionAttachmentFile = SessionMessageAttachment & {
  path: string;
};

type InternalSessionHistoryMessage = CodexHistoryMessage & {
  attachments: SessionAttachmentFile[];
};

type RuntimeEntry = {
  status: AccountRunStatus;
  controller?: AbortController;
  task?: Promise<void>;
  service?: BridgeService;
  store?: RuntimeStateStore;
  error?: string;
};

type ActiveWebTurn = {
  runner: HybridCodexRunner;
  threadId?: string;
  cancelled: boolean;
  cancellation: Promise<never>;
  rejectCancellation: (error: Error) => void;
};

export type AccountManagerOptions = {
  paths: StatePaths;
  configProvider?: () => CodexWeixinConfig;
  clientFactory?: (account: WeixinAccount) => WeixinApiClient;
  bridgeFactory?: (input: ConstructorParameters<typeof BridgeService>[0]) => BridgeService;
  monitor?: (options: MonitorOptions) => Promise<void>;
  runnerFactory?: (config: CodexWeixinConfig) => HybridCodexRunner;
  terminalReportRetryDelay?: (retryAttempt: number) => Promise<void> | void;
};

type RuntimePreparation = () => Promise<void> | void;

export type RuntimeRestartOptions = {
  interruptActiveTasks?: boolean;
};

export class AccountManager {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly respondingSessions = new Map<string, number>();
  private readonly activeWebTurns = new Map<string, Set<ActiveWebTurn>>();
  private readonly configProvider: () => CodexWeixinConfig;
  private readonly clientFactory: (account: WeixinAccount) => WeixinApiClient;
  private readonly bridgeFactory: (input: ConstructorParameters<typeof BridgeService>[0]) => BridgeService;
  private readonly monitor: (options: MonitorOptions) => Promise<void>;
  private readonly runnerFactory: (config: CodexWeixinConfig) => HybridCodexRunner;
  private readonly terminalReportRetryDelay: (retryAttempt: number) => Promise<void> | void;
  private runner?: HybridCodexRunner;
  private apiProfiles?: ApiProfileCommandService;
  private runtimeRestartPromise?: Promise<void>;
  private readonly idleTurnWaiters = new Set<() => void>();
  private shuttingDown = false;

  constructor(private readonly options: AccountManagerOptions) {
    this.configProvider = options.configProvider ?? (() => loadConfig(options.paths));
    this.clientFactory = options.clientFactory ?? ((account) => new WeixinApiClient({
      baseUrl: account.baseUrl,
      token: account.token
    }));
    this.bridgeFactory = options.bridgeFactory ?? ((input) => new BridgeService(input));
    this.monitor = options.monitor ?? monitorWeixin;
    this.runnerFactory = options.runnerFactory ?? ((config) => new HybridCodexRunner({
      backend: config.codexBackend,
      codexBin: config.codexBin,
      execSandbox: config.codexExecSandbox
    }));
    this.terminalReportRetryDelay = options.terminalReportRetryDelay ?? (async (retryAttempt) => {
      const delayMs = Math.min(retryAttempt * 1_000, 10_000);
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    });
  }

  async startAll(): Promise<void> {
    this.shuttingDown = false;
    await Promise.all(listAccounts(this.options.paths)
      .filter((account) => account.enabled)
      .map((account) => this.startAccount(account.accountId, false)));
  }

  setApiProfileCommandService(apiProfiles: ApiProfileCommandService): void {
    this.apiProfiles = apiProfiles;
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(listAccounts(this.options.paths)
      .filter((account) => this.entries.get(account.accountId)?.status === "running")
      .map((account) => this.stopAccount(account.accountId, false)));
    this.closeRunner();
  }

  async restartRunning(
    prepare?: RuntimePreparation,
    options: RuntimeRestartOptions = {}
  ): Promise<void> {
    if (this.runtimeRestartPromise) {
      if (prepare) {
        return this.runtimeRestartPromise.then(() => this.restartRunning(prepare, options));
      }
      return this.runtimeRestartPromise;
    }
    let resolveGate!: () => void;
    let rejectGate!: (error: unknown) => void;
    const gate = new Promise<void>((resolve, reject) => {
      resolveGate = resolve;
      rejectGate = reject;
    });
    this.runtimeRestartPromise = gate;
    void this.restartRuntimeWhenIdle(prepare, options)
      .then(() => {
        if (this.runtimeRestartPromise === gate) {
          this.runtimeRestartPromise = undefined;
        }
        resolveGate();
      }, (error: unknown) => {
        if (this.runtimeRestartPromise === gate) {
          this.runtimeRestartPromise = undefined;
        }
        rejectGate(error);
      });
    return gate;
  }

  clearSessionRuntimeOverrides(): void {
    for (const entry of this.entries.values()) {
      entry.store?.clearModelAndEffortOverrides();
      entry.store?.clearAllThreadIds();
    }
  }

  getActiveTaskCount(): number {
    const weChatTurns = [...this.entries.values()]
      .reduce((count, entry) => count + (entry.service?.getActiveTaskCount() ?? 0), 0);
    const webTurns = [...this.activeWebTurns.values()]
      .reduce((count, turns) => count + turns.size, 0);
    return weChatTurns + webTurns;
  }

  async refreshAccount(accountId: string): Promise<AccountSummary> {
    const account = loadAccount(this.options.paths, accountId);
    const existing = this.entries.get(account.accountId);
    if (existing?.status === "running" || existing?.status === "starting") {
      await this.stopAccount(account.accountId, false);
    }
    return this.startAccount(account.accountId, false);
  }

  async startAccount(accountId: string, persist = true): Promise<AccountSummary> {
    const account = persist ? setAccountEnabled(this.options.paths, accountId, true) : loadAccount(this.options.paths, accountId);
    const existing = this.entries.get(account.accountId);
    if (existing?.status === "running" || existing?.status === "starting") {
      return this.summary(account);
    }

    const controller = new AbortController();
    const statePaths = accountStatePaths(this.options.paths, account.accountId);
    const store = new RuntimeStateStore(statePaths);
    const client = this.clientFactory(account);
    const config = this.configProvider();
    const service = this.bridgeFactory({
      config,
      stateStore: store,
      weixin: client,
      inboundDir: statePaths.inboundDir,
      runner: this.runnerFor(config),
      listCodexModels: () => this.getCodexModels(),
      apiProfiles: this.apiProfiles,
      onTurnStatus: ({ sessionId, active }) => this.setSessionResponding(account.accountId, sessionId, active),
      waitForRuntimeReady: () => this.waitForRuntimeReady()
    });
    const entry: RuntimeEntry = { status: "starting", controller, service, store };
    this.entries.set(account.accountId, entry);

    entry.status = "running";
    entry.task = this.monitor({
      client,
      signal: controller.signal,
      initialSyncKey: store.getSyncKey(),
      onSyncKey: (syncKey) => store.setSyncKey(syncKey),
      claimMessage: (message) => store.claimProcessedMessage(message.id),
      onMessage: (message) => service.handleMessage(message),
      onMessageError: async (error, message) => {
        try {
          await client.sendText({
            toUserId: message.senderId,
            text: userFacingMessageHandlingError(error, {
              apiProfileName: this.apiProfiles?.getActive()?.name
            }),
            contextToken: store.getContextToken(message.senderId)
          });
        } catch (sendError) {
          if (!isStaleContextError(sendError)) throw sendError;
          console.warn(`WeChat context token is stale for ${message.senderId}; ask user to send a fresh message.`);
        }
      }
    }).then(() => {
      entry.status = "stopped";
    }).catch((error: unknown) => {
      if (controller.signal.aborted) {
        entry.status = "stopped";
        return;
      }
      entry.status = "error";
      entry.error = error instanceof Error ? error.message : String(error);
    });
    return this.summary(account);
  }

  async stopAccount(accountId: string, persist = true): Promise<AccountSummary> {
    const account = persist ? setAccountEnabled(this.options.paths, accountId, false) : loadAccount(this.options.paths, accountId);
    const entry = this.entries.get(account.accountId);
    if (entry) {
      await entry.service?.cancelActiveTurns();
      entry.controller?.abort();
      await entry.task;
      entry.status = "stopped";
    }
    return this.summary(account);
  }

  async removeAccount(accountId: string, options: { retainHistory?: boolean } = {}): Promise<void> {
    const account = loadAccount(this.options.paths, accountId);
    await this.stopAccount(accountId, false);
    if (options.retainHistory) {
      retainAccountHistory(this.options.paths, account);
    } else if (account.userId) {
      forgetRetainedAccount(this.options.paths, { accountId: account.accountId, userId: account.userId });
    }
    deleteAccount(this.options.paths, accountId);
    if (!options.retainHistory) {
      fs.rmSync(path.dirname(accountStatePaths(this.options.paths, account.accountId).statePath), {
        recursive: true,
        force: true
      });
    }
    this.entries.delete(account.accountId);
  }

  renameAccount(accountId: string, displayName: string): AccountSummary {
    const normalized = displayName.trim();
    if (normalized.length > 40) {
      throw new Error("Account display name must be 40 characters or fewer");
    }
    return this.summary(setAccountDisplayName(this.options.paths, accountId, normalized));
  }

  listAccounts(): AccountSummary[] {
    return listAccounts(this.options.paths).map((account) => this.summary(account));
  }

  listSessions(): AccountSession[] {
    return listAccounts(this.options.paths).flatMap((account) => {
      const store = this.storeFor(account.accountId);
      const activeIds = new Set(Object.values(store.snapshot.activeSessionIds));
      return store.listSessions().map((session) => ({
        ...session,
        accountId: account.accountId,
        active: activeIds.has(session.id),
        responding: this.isSessionResponding(account.accountId, session.id)
      }));
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getCodexRuntimeInfo(): Promise<CodexRuntimeInfo> {
    const config = this.configProvider();
    const configured: CodexRuntimeInfo = {
      ...(config.model ? { model: config.model } : {}),
      ...(config.effort ? { effort: config.effort } : {})
    };
    try {
      const runtime = await this.runnerFor(config).getRuntimeInfo(config.defaultCwd);
      return {
        model: configured.model ?? runtime.model,
        effort: configured.effort ?? runtime.effort,
        ...(runtime.provider ? { provider: runtime.provider } : {})
      };
    } catch (error) {
      console.warn(`Codex runtime info unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return configured;
    }
  }

  async verifyCodexRuntime(expectedModel: string): Promise<CodexRuntimeInfo> {
    const config = this.configProvider();
    const runtime = await this.runnerFor(config).getRuntimeInfo(config.defaultCwd);
    if (runtime.model !== expectedModel) {
      throw new Error("Codex runtime model does not match the active API profile");
    }
    return runtime;
  }

  async getCodexModels(): Promise<CodexModelOption[]> {
    let models: CodexModelOption[] = [];
    try {
      models = await this.runnerFor().listModels();
    } catch (error) {
      console.warn(`Codex model list unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const runtime = await this.getCodexRuntimeInfo();
    return addProviderModelFamily(models, runtime.provider);
  }

  createSession(accountId: string, senderId: string, workspace?: string, title?: string): AccountSession {
    const config = this.configProvider();
    const targetWorkspace = workspace ?? config.defaultCwd;
    if (!isWorkspaceAllowed(targetWorkspace, config.allowedWorkspaces)) {
      throw new Error(`Workspace is not allowed: ${targetWorkspace}`);
    }
    const session = this.storeFor(accountId).createSession(senderId, targetWorkspace, title);
    return this.sessionSummary(accountId, session, true);
  }

  renameSession(accountId: string, sessionId: string, title: string): AccountSession {
    const session = this.storeFor(accountId).renameSession(sessionId, title);
    return this.sessionSummary(accountId, session, this.isActive(accountId, session.id));
  }

  updateSessionRuntime(accountId: string, sessionId: string, overrides: SessionRuntimeOverrides): AccountSession {
    const session = this.storeFor(accountId).updateSessionRuntime(sessionId, overrides);
    return this.sessionSummary(accountId, session, this.isActive(accountId, session.id));
  }

  isSessionStreamEnabled(accountId: string, sessionId: string): boolean {
    const session = requireSession(this.storeFor(accountId), sessionId);
    return session.streamReplies ?? this.configProvider().streamReplies;
  }

  activateSession(accountId: string, sessionId: string): AccountSession {
    const session = this.storeFor(accountId).activateSession(sessionId);
    return this.sessionSummary(accountId, session, true);
  }

  resetSession(accountId: string, sessionId: string): AccountSession {
    const session = this.storeFor(accountId).resetSession(sessionId);
    return this.sessionSummary(accountId, session, this.isActive(accountId, session.id));
  }

  deleteSession(accountId: string, sessionId: string): void {
    if (this.isSessionResponding(accountId, sessionId)) {
      throw new Error("Cannot delete a responding session");
    }
    this.storeFor(accountId).deleteSession(sessionId);
  }

  async getSessionMessages(accountId: string, sessionId: string): Promise<SessionHistoryMessage[]> {
    const messages = await this.readSessionMessages(accountId, sessionId);
    return messages.map((message) => ({
      ...message,
      attachments: message.attachments.map(({ path: _path, ...attachment }) => attachment)
    }));
  }

  async getSessionAttachment(
    accountId: string,
    sessionId: string,
    messageId: string,
    attachmentIndex: number
  ): Promise<SessionAttachmentFile> {
    const messages = await this.readSessionMessages(accountId, sessionId);
    const attachment = messages.find((message) => message.id === messageId)
      ?.attachments.find((candidate) => candidate.index === attachmentIndex);
    if (!attachment?.available) {
      throw new Error("Session attachment not found");
    }
    return attachment;
  }

  private async readSessionMessages(accountId: string, sessionId: string): Promise<InternalSessionHistoryMessage[]> {
    const store = this.storeFor(accountId);
    const session = requireSession(store, sessionId);
    if (!session.threadId) {
      return [];
    }
    const history = await this.runnerFor().getHistory(session.threadId);
    return history.flatMap((message) => {
      if (message.role === "user") {
        const parsed = parsePrompt(message.text);
        const inboundRoot = accountStatePaths(this.options.paths, accountId).inboundDir;
        const attachments = parsed.attachments
          .filter((attachment) => isPathWithin(inboundRoot, attachment.path))
          .map((attachment, index) => sessionAttachment({
            type: attachment.kind === "audio" ? "file" : attachment.kind,
            path: attachment.path
          }, index));
        return parsed.text || attachments.length ? [{ ...message, text: parsed.text, attachments }] : [];
      }
      const parsed = parseAssistantMessage(message.text);
      const attachments = parsed.actions.send.map((action, index) => sessionAttachment(action, index));
      const text = parsed.visibleText.trim();
      return text || attachments.length ? [{ ...message, text, attachments }] : [];
    });
  }

  async continueSession(
    accountId: string,
    sessionId: string,
    text: string,
    uploads: SessionUpload[] = [],
    onProgress?: (message: string) => Promise<void> | void
  ): Promise<SessionChatResult> {
    const prompt = text.trim();
    if (!prompt && !uploads.length) {
      throw new Error("Message text or attachment is required");
    }
    const runtimeReady = this.waitForRuntimeReady();
    if (runtimeReady) {
      await runtimeReady;
    }
    const store = this.storeFor(accountId);
    const session = requireSession(store, sessionId);
    const config = this.configProvider();
    const attachments = this.saveSessionUploads(accountId, session.id, uploads);
    const promptPreview = buildPromptPreview(prompt, attachments);
    if (promptPreview) {
      store.setSessionPromptPreview(session.id, promptPreview);
    }
    const runner = this.runnerFor(config);
    const control = this.beginWebTurn(accountId, session.id, runner);
    try {
      let result = await this.runWebTurn(control, () => runner.run({
        prompt: buildPrompt(prompt, attachments, "Web"),
        cwd: session.workspace,
        threadId: session.threadId,
        model: session.model ?? config.model,
        effort: session.effort ?? config.effort,
        onThreadStarted: (threadId) => {
          if (control.cancelled) return;
          control.threadId = threadId;
          store.setSessionThread(session.id, threadId);
        },
        ...((session.streamReplies ?? config.streamReplies) && onProgress
          ? { onProgress }
          : {})
      }));
      let reportRetryAttempt = 0;
      const pendingSendActions = new Map<string, SendAction>();
      while (true) {
        const parsed = parseAssistantMessage(result.text);
        if (hasVisibleFinalReport(parsed.visibleText)) break;
        for (const action of parsed.actions.send) {
          pendingSendActions.set(action.path.toLowerCase(), action);
        }
        if (reportRetryAttempt >= MAX_FINAL_REPORT_RECOVERY_ATTEMPTS) {
          console.error(
            `[codex-weixin] Web turn ${session.id} did not provide a visible final report after `
            + `${MAX_FINAL_REPORT_RECOVERY_ATTEMPTS} recovery attempts; ending the turn`
          );
          result = { ...result, text: MISSING_FINAL_REPORT_FALLBACK };
          break;
        }
        reportRetryAttempt += 1;
        const threadId = result.threadId ?? control.threadId ?? session.threadId;
        if (!threadId) {
          throw new Error("Codex returned no visible final report and no thread id for recovery");
        }
        store.setSessionThread(session.id, threadId);
        control.threadId = threadId;
        await this.runWebTurn(control, async () => this.terminalReportRetryDelay(reportRetryAttempt));
        result = await this.runWebTurn(control, () => runner.run({
          prompt: buildPrompt(MISSING_FINAL_REPORT_PROMPT, [], "Web"),
          cwd: session.workspace,
          threadId,
          model: session.model ?? config.model,
          effort: session.effort ?? config.effort,
          onThreadStarted: (startedThreadId) => {
            if (control.cancelled) return;
            control.threadId = startedThreadId;
            store.setSessionThread(session.id, startedThreadId);
          }
        }));
      }
      const threadId = result.threadId ?? control.threadId ?? session.threadId;
      if (!threadId) {
        throw new Error("Codex did not return a thread id");
      }
      store.setSessionThread(session.id, threadId);
      const parsed = parseAssistantMessage(result.text);
      const sendActions = new Map<string, SendAction>();
      for (const action of [...pendingSendActions.values(), ...parsed.actions.send]) {
        sendActions.set(action.path.toLowerCase(), action);
      }
      return {
        threadId,
        message: {
          id: crypto.randomUUID(),
          role: "assistant",
          text: parsed.visibleText.trim(),
          createdAt: new Date().toISOString(),
          attachments: [...sendActions.values()].map((action, index) => {
            const { path: _path, ...attachment } = sessionAttachment(action, index);
            return attachment;
          })
        }
      };
    } finally {
      this.finishWebTurn(accountId, session.id, control);
    }
  }

  private beginWebTurn(accountId: string, sessionId: string, runner: HybridCodexRunner): ActiveWebTurn {
    let rejectCancellation!: (error: Error) => void;
    const control: ActiveWebTurn = {
      runner,
      cancelled: false,
      cancellation: new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
      }),
      rejectCancellation
    };
    const key = sessionRuntimeKey(accountId, sessionId);
    const turns = this.activeWebTurns.get(key) ?? new Set<ActiveWebTurn>();
    turns.add(control);
    this.activeWebTurns.set(key, turns);
    this.setSessionResponding(accountId, sessionId, true);
    return control;
  }

  private finishWebTurn(accountId: string, sessionId: string, control: ActiveWebTurn): void {
    const key = sessionRuntimeKey(accountId, sessionId);
    const turns = this.activeWebTurns.get(key);
    if (!turns?.delete(control)) return;
    if (!turns.size) {
      this.activeWebTurns.delete(key);
    }
    this.setSessionResponding(accountId, sessionId, false);
  }

  private runWebTurn<T>(control: ActiveWebTurn, operation: () => Promise<T>): Promise<T> {
    if (control.cancelled) {
      return Promise.reject(apiSwitchCancellationError());
    }
    return Promise.race([operation(), control.cancellation]);
  }

  private saveSessionUploads(accountId: string, sessionId: string, uploads: SessionUpload[]): PromptBufferItem[] {
    if (!uploads.length) return [];
    const sessionDir = path.join(
      accountStatePaths(this.options.paths, accountId).inboundDir,
      "web",
      safePathSegment(sessionId),
      crypto.randomUUID()
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    try {
      return uploads.map((upload) => {
        const label = sanitizeFileName(upload.name);
        const targetPath = uniqueFilePath(sessionDir, label);
        fs.writeFileSync(targetPath, upload.data, { flag: "wx" });
        return {
          kind: inferMediaKind(label),
          label,
          path: targetPath
        };
      });
    } catch (error) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      throw error;
    }
  }

  allowSender(accountId: string, senderId: string): void {
    const entry = this.entries.get(loadAccount(this.options.paths, accountId).accountId);
    if (entry?.service) {
      entry.service.allowSender(senderId);
      return;
    }
    const store = this.storeFor(accountId);
    store.setPairedSenderIds([...store.listPairedSenderIds(), senderId]);
  }

  removeSender(accountId: string, senderId: string): void {
    const entry = this.entries.get(loadAccount(this.options.paths, accountId).accountId);
    if (entry?.service) {
      entry.service.removeSender(senderId);
      return;
    }
    const store = this.storeFor(accountId);
    store.setPairedSenderIds(store.listPairedSenderIds().filter((candidate) => candidate !== senderId));
  }

  private storeFor(accountId: string): RuntimeStateStore {
    const account = loadAccount(this.options.paths, accountId);
    return this.entries.get(account.accountId)?.store
      ?? new RuntimeStateStore(accountStatePaths(this.options.paths, account.accountId));
  }

  private isActive(accountId: string, sessionId: string): boolean {
    return Object.values(this.storeFor(accountId).snapshot.activeSessionIds).includes(sessionId);
  }

  private sessionSummary(accountId: string, session: ManagedSession, active: boolean): AccountSession {
    return {
      ...session,
      accountId,
      active,
      responding: this.isSessionResponding(accountId, session.id)
    };
  }

  private isSessionResponding(accountId: string, sessionId: string): boolean {
    return (this.respondingSessions.get(sessionRuntimeKey(accountId, sessionId)) ?? 0) > 0;
  }

  private setSessionResponding(accountId: string, sessionId: string, active: boolean): void {
    const key = sessionRuntimeKey(accountId, sessionId);
    const count = this.respondingSessions.get(key) ?? 0;
    const next = active ? count + 1 : Math.max(0, count - 1);
    if (next) {
      this.respondingSessions.set(key, next);
    } else {
      this.respondingSessions.delete(key);
      if (!this.respondingSessions.size) {
        for (const resolve of this.idleTurnWaiters) {
          resolve();
        }
        this.idleTurnWaiters.clear();
      }
    }
  }

  private async restartRuntimeWhenIdle(
    prepare?: RuntimePreparation,
    options: RuntimeRestartOptions = {}
  ): Promise<void> {
    if (options.interruptActiveTasks) {
      await this.interruptActiveTasksForApiSwitch();
    } else {
      await this.waitForNoActiveTurns();
    }
    if (this.shuttingDown) return;

    await prepare?.();

    const previous = this.runner;
    if (!previous) return;
    const config = this.configProvider();
    const replacement = this.runnerFactory(config);
    this.runner = replacement;
    for (const entry of this.entries.values()) {
      entry.service?.replaceRuntime(replacement, config);
    }
    previous.close();
  }

  private async interruptActiveTasksForApiSwitch(): Promise<void> {
    const notice = "当前任务已因确认的 API 切换而结束。";
    const retiringRunners = new Set<HybridCodexRunner>();
    if (this.runner) {
      retiringRunners.add(this.runner);
    }

    const cancellationRequests = [...this.entries.values()]
      .flatMap((entry) => entry.service ? [entry.service.cancelActiveTurns(notice)] : []);
    const cancellationResults = await Promise.allSettled(cancellationRequests);
    for (const result of cancellationResults) {
      if (result.status === "rejected") {
        console.warn(`Unable to request WeChat task cancellation: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }

    for (const [key, turns] of [...this.activeWebTurns.entries()]) {
      const [accountId, sessionId] = key.split("\n", 2);
      for (const control of [...turns]) {
        retiringRunners.add(control.runner);
        if (!control.cancelled) {
          control.cancelled = true;
          control.rejectCancellation(apiSwitchCancellationError());
        }
        this.finishWebTurn(accountId, sessionId, control);
        void control.runner.stop(control.threadId).catch((error: unknown) => {
          console.warn(`Unable to request Web task cancellation: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }

    for (const runner of retiringRunners) {
      runner.close();
    }
  }

  private waitForRuntimeReady(): Promise<void> | undefined {
    return this.runtimeRestartPromise;
  }

  private waitForNoActiveTurns(): Promise<void> {
    if (!this.respondingSessions.size) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleTurnWaiters.add(resolve);
    });
  }

  private runnerFor(config = this.configProvider()): HybridCodexRunner {
    this.runner ??= this.runnerFactory(config);
    return this.runner;
  }

  private closeRunner(): void {
    this.runner?.close();
    this.runner = undefined;
  }

  private summary(account: WeixinAccount): AccountSummary {
    const entry = this.entries.get(account.accountId);
    const store = entry?.store ?? new RuntimeStateStore(accountStatePaths(this.options.paths, account.accountId));
    return {
      ...publicAccount(account),
      status: entry?.status ?? "stopped",
      ...(entry?.error ? { error: entry.error } : {}),
      pairedSenderIds: store.listPairedSenderIds(),
      lastActiveSenderId: store.getLastActiveSenderId(),
      sessionCount: store.listSessions().length
    };
  }
}

function requireSession(store: RuntimeStateStore, sessionId: string): ManagedSession {
  const session = store.getSession(sessionId);
  if (!session) {
    throw new Error(`Managed session not found: ${sessionId}`);
  }
  return session;
}

function parseAssistantMessage(text: string): ReturnType<typeof parseActionBlocks> {
  try {
    return parseActionBlocks(text);
  } catch {
    return { visibleText: text.trim(), actions: { send: [], control: [] } };
  }
}

function sessionAttachment(
  action: { type: "image" | "file" | "video"; path: string },
  index: number
): SessionAttachmentFile {
  let size: number | undefined;
  let available = false;
  try {
    const stat = fs.statSync(action.path);
    available = stat.isFile();
    if (available) size = stat.size;
  } catch {
    // Keep historical attachments visible even after their local file is moved.
  }
  return {
    index,
    type: action.type,
    path: action.path,
    name: path.basename(action.path),
    ...(size === undefined ? {} : { size }),
    available
  };
}

function uniqueFilePath(dir: string, fileName: string): string {
  const parsed = path.parse(fileName);
  let candidate = path.join(dir, fileName);
  for (let index = 2; fs.existsSync(candidate); index += 1) {
    candidate = path.join(dir, `${parsed.name}-${index}${parsed.ext}`);
  }
  return candidate;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_") || "session";
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sessionRuntimeKey(accountId: string, sessionId: string): string {
  return `${accountId}\n${sessionId}`;
}

function apiSwitchCancellationError(): Error {
  return new Error("Web task was stopped because the API switch was confirmed");
}

function addProviderModelFamily(models: CodexModelOption[], provider?: string): CodexModelOption[] {
  if (provider?.toLowerCase() !== "ikuncoding") {
    return models;
  }
  const commonEfforts = ["low", "medium", "high", "xhigh", "max"];
  const descriptions: Record<string, { displayName: string; description: string; efforts: string[] }> = {
    "gpt-5.6-sol": {
      displayName: "GPT-5.6 Sol",
      description: "Frontier agentic coding model for complex work.",
      efforts: [...commonEfforts, "ultra"]
    },
    "gpt-5.6-terra": {
      displayName: "GPT-5.6 Terra",
      description: "Balanced agentic coding model for everyday work.",
      efforts: [...commonEfforts, "ultra"]
    },
    "gpt-5.6-luna": {
      displayName: "GPT-5.6 Luna",
      description: "Fast and efficient model for simpler coding tasks.",
      efforts: commonEfforts
    }
  };
  const family = Object.entries(descriptions).map(([model, details]) => ({
    model,
    displayName: details.displayName,
    description: details.description,
    isDefault: false,
    defaultEffort: "medium",
    supportedEfforts: details.efforts.map((effort) => ({ effort, description: "" }))
  }));
  return [
    ...family.filter((option) => !models.some((model) => model.model === option.model)),
    ...models
  ];
}
