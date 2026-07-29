import type { CodexRuntimeInfo } from "../codex/app-server-runner.js";
import type { CodexWeixinConfig } from "../state/config.js";
import {
  ApiProfileError,
  type ApiProfileStore,
  type ApiProfileSummary,
  type CreateApiProfileInput,
  type UpdateApiProfileInput
} from "../state/api-profiles.js";

export type ApiProfileTestResult = {
  ok: true;
  latencyMs: number;
};

export type ApiProfileManagerOptions = {
  store: ApiProfileStore;
  fetch?: typeof globalThis.fetch;
  writeProviderConfig: (profile: ApiProfileSummary) => void;
  loadConfig: () => CodexWeixinConfig;
  saveConfig: (config: CodexWeixinConfig) => void;
  restartRuntime: () => Promise<void>;
  readRuntime: () => Promise<CodexRuntimeInfo>;
};

export class ApiProfileManager {
  private readonly fetch: typeof globalThis.fetch;
  private activationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ApiProfileManagerOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  list(): ApiProfileSummary[] {
    return this.options.store.list();
  }

  getActive(): ApiProfileSummary | undefined {
    return this.options.store.getActive();
  }

  create(input: CreateApiProfileInput): Promise<ApiProfileSummary> {
    return this.options.store.create(input);
  }

  update(id: string, input: UpdateApiProfileInput): Promise<ApiProfileSummary> {
    return this.options.store.update(id, input);
  }

  delete(id: string): Promise<void> {
    return this.options.store.delete(id);
  }

  async test(id: string): Promise<ApiProfileTestResult> {
    const profile = requireSummary(this.options.store, id);
    const apiKey = await this.options.store.readSecret(id);
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetch(`${profile.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
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
      if (response.status === 404 || response.status === 405) {
        throw new ApiProfileError("Responses endpoint was not found", "VALIDATION");
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

  activate(id: string): Promise<ApiProfileSummary> {
    const result = this.activationQueue.then(() => this.activateOnce(id), () => this.activateOnce(id));
    this.activationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async activateOnce(id: string): Promise<ApiProfileSummary> {
    await this.test(id);
    const target = requireSummary(this.options.store, id);
    const previous = this.options.store.getActive();
    const previousConfig = this.options.loadConfig();
    try {
      const active = await this.options.store.activate(id);
      this.options.writeProviderConfig(active);
      this.options.saveConfig({ ...previousConfig, model: active.model });
      await this.options.restartRuntime();
      const runtime = await this.options.readRuntime();
      if (runtime.model !== active.model) {
        throw new Error("runtime model mismatch");
      }
      return active;
    } catch {
      await this.rollback(previous, previousConfig);
      throw new ApiProfileError("API activation failed; the previous API remains active", "CONFLICT");
    }
  }

  private async rollback(previous: ApiProfileSummary | undefined, previousConfig: CodexWeixinConfig): Promise<void> {
    if (!previous) return;
    try {
      await this.options.store.activate(previous.id);
      this.options.writeProviderConfig(previous);
      this.options.saveConfig(previousConfig);
      await this.options.restartRuntime();
    } catch {
      throw new ApiProfileError("API activation and automatic rollback failed", "STORAGE");
    }
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
