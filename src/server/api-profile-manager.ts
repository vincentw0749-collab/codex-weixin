import type { CodexRuntimeInfo } from "../codex/app-server-runner.js";
import type { CodexWeixinConfig } from "../state/config.js";
import {
  ApiProfileError,
  type ApiProfileDisplaySummary,
  type ApiProfileStore,
  type ApiProfileSummary,
  type CreateApiProfileInput,
  normalizeCreateApiProfileInput,
  type UpdateApiProfileInput
} from "../state/api-profiles.js";

export type ApiProfileTestResult = {
  ok: true;
  latencyMs: number;
};

export type VerifiedApiProfileCreateResult = ApiProfileTestResult & {
  profile: ApiProfileSummary;
};

export type ApiProfileRuntimeOptions = {
  interruptActiveTasks?: boolean;
};

export type ApiProfileDefaults = {
  model: string;
  effort: string;
};

export type ApiProfileManagerOptions = {
  store: ApiProfileStore;
  fetch?: typeof globalThis.fetch;
  writeProviderConfig: (profile: ApiProfileSummary) => void;
  loadConfig: () => CodexWeixinConfig;
  saveConfig: (config: CodexWeixinConfig) => void;
  restartRuntime: (
    prepare?: () => Promise<void> | void,
    options?: ApiProfileRuntimeOptions
  ) => Promise<void>;
  readRuntime: () => Promise<CodexRuntimeInfo>;
  resetSessionRuntimeOverrides?: () => void;
  getActiveTaskCount?: () => number;
};

export class ApiProfileManager {
  private readonly fetch: typeof globalThis.fetch;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ApiProfileManagerOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  list(): ApiProfileSummary[] {
    return this.options.store.list();
  }

  async listForDisplay(): Promise<ApiProfileDisplaySummary[]> {
    return Promise.all(this.options.store.list().map(async (profile) => {
      try {
        const apiKey = await this.options.store.readSecret(profile.id);
        return { ...profile, apiKeyLastFour: apiKey.slice(-4) || null };
      } catch {
        return { ...profile, apiKeyLastFour: null };
      }
    }));
  }

  getActive(): ApiProfileSummary | undefined {
    return this.options.store.getActive();
  }

  getActiveTaskCount(): number {
    return this.options.getActiveTaskCount?.() ?? 0;
  }

  validateDefaults(id: string, model: string, effort: string): ApiProfileDefaults {
    const profile = requireSummary(this.options.store, id);
    const normalized = normalizeCreateApiProfileInput({
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKey: "validation-only",
      model,
      effort
    });
    return { model: normalized.model, effort: normalized.effort };
  }

  create(input: CreateApiProfileInput): Promise<ApiProfileSummary> {
    return this.enqueue(() => this.options.store.create(input));
  }

  async createVerified(input: CreateApiProfileInput): Promise<VerifiedApiProfileCreateResult> {
    const normalized = normalizeCreateApiProfileInput(input);
    const result = await this.testConnection(normalized);
    const profile = await this.enqueue(() => this.options.store.create(normalized));
    return { ...result, profile };
  }

  update(id: string, input: UpdateApiProfileInput): Promise<ApiProfileSummary> {
    return this.enqueue(() => this.updateOnce(id, input));
  }

  async setDefaults(
    id: string,
    model: string,
    effort: string,
    options: ApiProfileRuntimeOptions = {}
  ): Promise<ApiProfileSummary> {
    const defaults = this.validateDefaults(id, model, effort);
    return this.enqueue(() => this.setDefaultsOnce(id, defaults.model, defaults.effort, options));
  }

  private async setDefaultsOnce(
    id: string,
    model: string,
    effort: string,
    options: ApiProfileRuntimeOptions
  ): Promise<ApiProfileSummary> {
    const previous = requireSummary(this.options.store, id);
    if (!previous.active) return this.options.store.update(id, { model, effort });
    const previousConfig = this.options.loadConfig();
    let updated: ApiProfileSummary | undefined;
    try {
      updated = await this.applyProfile(previousConfig, async () => {
        updated = await this.options.store.update(id, { model, effort });
        return updated;
      }, options);
      return updated;
    } catch {
      if (updated) {
        await this.restoreProfile(previousConfig, async () => this.options.store.update(id, {
          model: previous.model,
          effort: previous.effort
        }));
      }
      throw new ApiProfileError("Unable to apply API defaults; the previous defaults remain active", "CONFLICT");
    }
  }

  delete(id: string): Promise<void> {
    return this.enqueue(() => this.options.store.delete(id));
  }

  async test(id: string): Promise<ApiProfileTestResult> {
    const profile = requireSummary(this.options.store, id);
    const apiKey = await this.options.store.readSecret(id);
    return this.testConnection({
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey
    });
  }

  private async testConnection(profile: CreateApiProfileInput): Promise<ApiProfileTestResult> {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetch(`${profile.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${profile.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: profile.model,
          input: "Reply with OK.",
          max_output_tokens: 16,
          stream: false
        }),
        signal: AbortSignal.timeout(20_000)
      });
    } catch (error) {
      if ((error as { name?: unknown }).name === "TimeoutError" || (error as { name?: unknown }).name === "AbortError") {
        throw new ApiProfileError("API connection timed out after 20 seconds", "VALIDATION");
      }
      throw new ApiProfileError("Unable to connect to the API endpoint", "VALIDATION");
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new ApiProfileError("API authentication failed", "VALIDATION");
      }
      if (response.status === 429) {
        throw new ApiProfileError("API rate limit or quota exceeded", "VALIDATION");
      }
      if (response.status === 404 || response.status === 405) {
        throw new ApiProfileError("Responses endpoint was not found", "VALIDATION");
      }
      if (response.status >= 500) {
        throw new ApiProfileError(`API service is temporarily unavailable (${response.status})`, "VALIDATION");
      }
      throw new ApiProfileError(`API request failed with status ${response.status}`, "VALIDATION");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ApiProfileError("API returned an invalid Responses payload", "VALIDATION");
    }
    if (!isResponsesPayload(payload)) {
      throw new ApiProfileError("API returned an invalid Responses payload", "VALIDATION");
    }
    return { ok: true, latencyMs: Math.max(0, Date.now() - startedAt) };
  }

  activate(id: string, options: ApiProfileRuntimeOptions = {}): Promise<ApiProfileSummary> {
    return this.enqueue(() => this.activateOnce(id, options));
  }

  private async activateOnce(id: string, options: ApiProfileRuntimeOptions): Promise<ApiProfileSummary> {
    requireSummary(this.options.store, id);
    const previous = this.options.store.getActive();
    const previousConfig = this.options.loadConfig();
    let activationApplied = false;
    try {
      return await this.applyProfile(previousConfig, async () => {
        await this.test(id);
        const activated = await this.options.store.activate(id);
        activationApplied = true;
        return activated;
      }, options);
    } catch (error) {
      await this.rollback(previous, previousConfig);
      if (!activationApplied) throw error;
      throw new ApiProfileError("API activation failed; the previous API remains active", "CONFLICT");
    }
  }

  private async rollback(previous: ApiProfileSummary | undefined, previousConfig: CodexWeixinConfig): Promise<void> {
    try {
      await this.options.restartRuntime(async () => {
        this.options.saveConfig(previousConfig);
        if (previous) {
          await this.options.store.activate(previous.id);
          this.options.writeProviderConfig(previous);
        } else {
          await this.options.store.clearActive();
        }
      });
    } catch {
      throw new ApiProfileError("API activation and automatic rollback failed", "STORAGE");
    }
  }

  private async updateOnce(id: string, input: UpdateApiProfileInput): Promise<ApiProfileSummary> {
    const previous = requireSummary(this.options.store, id);
    if (!previous.active) return this.options.store.update(id, input);
    const previousConfig = this.options.loadConfig();
    const previousApiKey = input.apiKey?.trim() ? await this.options.store.readSecret(id) : undefined;
    let updated: ApiProfileSummary | undefined;
    try {
      updated = await this.applyProfile(previousConfig, async () => {
        updated = await this.options.store.update(id, input);
        return updated;
      });
      return updated;
    } catch {
      if (updated) {
        await this.restoreProfile(previousConfig, () => this.options.store.update(id, {
          name: previous.name,
          baseUrl: previous.baseUrl,
          model: previous.model,
          effort: previous.effort,
          ...(previousApiKey ? { apiKey: previousApiKey } : {})
        }));
      }
      throw new ApiProfileError("Unable to apply API profile changes; the previous API remains active", "CONFLICT");
    }
  }

  private async applyProfile(
    baseConfig: CodexWeixinConfig,
    prepare: () => Promise<ApiProfileSummary>,
    options: ApiProfileRuntimeOptions = {}
  ): Promise<ApiProfileSummary> {
    let profile: ApiProfileSummary | undefined;
    await this.options.restartRuntime(async () => {
      profile = await prepare();
      this.options.saveConfig({ ...baseConfig, model: profile.model, effort: profile.effort });
      this.options.writeProviderConfig(profile);
    }, options);
    if (!profile) throw new Error("API profile transaction did not apply");
    const runtime = await this.options.readRuntime();
    if (runtime.model !== profile.model || (runtime.effort && runtime.effort !== profile.effort)) {
      throw new Error("runtime defaults mismatch");
    }
    this.options.resetSessionRuntimeOverrides?.();
    return profile;
  }

  private async restoreProfile(
    config: CodexWeixinConfig,
    prepare: () => Promise<ApiProfileSummary>
  ): Promise<void> {
    await this.options.restartRuntime(async () => {
      const profile = await prepare();
      this.options.saveConfig(config);
      this.options.writeProviderConfig(profile);
    });
  }

  private enqueue<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function requireSummary(store: ApiProfileStore, id: string): ApiProfileSummary {
  const profile = store.list().find((candidate) => candidate.id === id);
  if (!profile) throw new ApiProfileError("API profile not found", "NOT_FOUND");
  return profile;
}

function isResponsesPayload(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.id === "string" || Array.isArray(payload.output) || typeof payload.output_text === "string";
}
