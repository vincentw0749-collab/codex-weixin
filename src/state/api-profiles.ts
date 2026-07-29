import crypto from "node:crypto";
import fs from "node:fs";

import type { SecretProtector } from "../security/dpapi.js";
import { writeJsonFile } from "./json-store.js";
import type { StatePaths } from "./paths.js";

const DOCUMENT_VERSION = 1;

type ApiProfileRecord = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  encryptedApiKey: string;
  createdAt: string;
  updatedAt: string;
};

type ApiProfileDocument = {
  version: 1;
  activeProfileId?: string;
  profiles: ApiProfileRecord[];
};

export type ApiProfileSummary = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateApiProfileInput = {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type UpdateApiProfileInput = {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

export type ApiProfileSeed = CreateApiProfileInput;

export type ApiProfileErrorCode = "NOT_FOUND" | "VALIDATION" | "CONFLICT" | "STORAGE";

export class ApiProfileError extends Error {
  constructor(message: string, readonly code: ApiProfileErrorCode) {
    super(message);
    this.name = "ApiProfileError";
  }
}

export class ApiProfileStore {
  private document: ApiProfileDocument;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly paths: StatePaths,
    private readonly protector: SecretProtector
  ) {
    this.document = readDocument(paths.apiProfilesPath);
  }

  list(): ApiProfileSummary[] {
    return this.document.profiles.map((profile) => this.toSummary(profile));
  }

  getActive(): ApiProfileSummary | undefined {
    const profile = this.document.profiles.find(({ id }) => id === this.document.activeProfileId);
    return profile ? this.toSummary(profile) : undefined;
  }

  create(input: CreateApiProfileInput): Promise<ApiProfileSummary> {
    return this.enqueue(async () => {
      const normalized = normalizeCreateInput(input);
      this.requireUniqueName(normalized.name);
      const now = new Date().toISOString();
      const profile: ApiProfileRecord = {
        id: crypto.randomUUID(),
        name: normalized.name,
        baseUrl: normalized.baseUrl,
        model: normalized.model,
        encryptedApiKey: await this.protector.protect(normalized.apiKey),
        createdAt: now,
        updatedAt: now
      };
      this.document.profiles.push(profile);
      this.document.activeProfileId ??= profile.id;
      this.persist();
      return this.toSummary(profile);
    });
  }

  update(id: string, input: UpdateApiProfileInput): Promise<ApiProfileSummary> {
    return this.enqueue(async () => {
      const profile = this.requireProfile(id);
      const name = input.name === undefined ? profile.name : normalizeName(input.name);
      this.requireUniqueName(name, id);
      const baseUrl = input.baseUrl === undefined ? profile.baseUrl : normalizeBaseUrl(input.baseUrl);
      const model = input.model === undefined ? profile.model : normalizeModel(input.model);
      const apiKey = input.apiKey?.trim();
      const encryptedApiKey = apiKey
        ? await this.protector.protect(apiKey)
        : profile.encryptedApiKey;
      const updated: ApiProfileRecord = {
        ...profile,
        name,
        baseUrl,
        model,
        encryptedApiKey,
        updatedAt: new Date().toISOString()
      };
      this.document.profiles[this.document.profiles.indexOf(profile)] = updated;
      this.persist();
      return this.toSummary(updated);
    });
  }

  delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      this.requireProfile(id);
      if (this.document.profiles.length === 1) {
        throw new ApiProfileError("The last profile cannot be deleted", "CONFLICT");
      }
      if (this.document.activeProfileId === id) {
        throw new ApiProfileError("The active profile cannot be deleted", "CONFLICT");
      }
      this.document.profiles = this.document.profiles.filter((profile) => profile.id !== id);
      this.persist();
    });
  }

  activate(id: string): Promise<ApiProfileSummary> {
    return this.enqueue(async () => {
      const profile = this.requireProfile(id);
      this.document.activeProfileId = id;
      this.persist();
      return this.toSummary(profile);
    });
  }

  async readSecret(id: string): Promise<string> {
    const profile = this.requireProfile(id);
    try {
      return await this.protector.unprotect(profile.encryptedApiKey);
    } catch {
      throw new ApiProfileError("Unable to decrypt the selected API key", "STORAGE");
    }
  }

  ensureMigrated(seed?: ApiProfileSeed): Promise<void> {
    return this.enqueue(async () => {
      if (this.document.profiles.length > 0 || !seed) return;
      const normalized = normalizeCreateInput(seed);
      const now = new Date().toISOString();
      const profile: ApiProfileRecord = {
        id: crypto.randomUUID(),
        name: normalized.name,
        baseUrl: normalized.baseUrl,
        model: normalized.model,
        encryptedApiKey: await this.protector.protect(normalized.apiKey),
        createdAt: now,
        updatedAt: now
      };
      this.document.profiles.push(profile);
      this.document.activeProfileId = profile.id;
      this.persist();
    });
  }

  private toSummary(profile: ApiProfileRecord): ApiProfileSummary {
    return {
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      hasApiKey: Boolean(profile.encryptedApiKey),
      active: profile.id === this.document.activeProfileId,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt
    };
  }

  private requireProfile(id: string): ApiProfileRecord {
    const profile = this.document.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new ApiProfileError("API profile not found", "NOT_FOUND");
    return profile;
  }

  private requireUniqueName(name: string, exceptId?: string): void {
    if (this.document.profiles.some((profile) =>
      profile.id !== exceptId && profile.name.localeCompare(name, undefined, { sensitivity: "accent" }) === 0
    )) {
      throw new ApiProfileError("An API profile with this name already exists", "CONFLICT");
    }
  }

  private persist(): void {
    writeJsonFile(this.paths.apiProfilesPath, this.document);
  }

  private enqueue<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function readDocument(filePath: string): ApiProfileDocument {
  if (!fs.existsSync(filePath)) return { version: DOCUMENT_VERSION, profiles: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ApiProfileDocument>;
    if (parsed.version !== DOCUMENT_VERSION || !Array.isArray(parsed.profiles)) throw new Error("invalid document");
    const profiles = parsed.profiles.map(validateRecord);
    if (parsed.activeProfileId !== undefined && !profiles.some(({ id }) => id === parsed.activeProfileId)) {
      throw new Error("invalid active profile");
    }
    return { version: DOCUMENT_VERSION, activeProfileId: parsed.activeProfileId, profiles };
  } catch {
    throw new ApiProfileError("API profile storage is invalid; restore or remove the file before retrying", "STORAGE");
  }
}

function validateRecord(value: unknown): ApiProfileRecord {
  if (!value || typeof value !== "object") throw new Error("invalid profile");
  const record = value as Record<string, unknown>;
  const required = ["id", "name", "baseUrl", "model", "encryptedApiKey", "createdAt", "updatedAt"];
  if (required.some((key) => typeof record[key] !== "string" || !record[key])) throw new Error("invalid profile");
  return record as ApiProfileRecord;
}

function normalizeCreateInput(input: CreateApiProfileInput): CreateApiProfileInput {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) throw new ApiProfileError("API key cannot be blank", "VALIDATION");
  return {
    name: normalizeName(input.name),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    apiKey,
    model: normalizeModel(input.model)
  };
}

function normalizeName(name: string): string {
  const value = name?.trim();
  if (!value) throw new ApiProfileError("Profile name cannot be blank", "VALIDATION");
  if (value.length > 60) throw new ApiProfileError("Profile name is too long", "VALIDATION");
  return value;
}

function normalizeModel(model: string): string {
  const value = model?.trim();
  if (!value) throw new ApiProfileError("Model cannot be blank", "VALIDATION");
  if (value.length > 200) throw new ApiProfileError("Model is too long", "VALIDATION");
  return value;
}

function normalizeBaseUrl(baseUrl: string): string {
  const value = baseUrl?.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiProfileError("Base URL is invalid", "VALIDATION");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiProfileError("Base URL must use HTTP or HTTPS", "VALIDATION");
  }
  if (parsed.username || parsed.password) {
    throw new ApiProfileError("Base URL cannot contain credentials", "VALIDATION");
  }
  if (parsed.search || parsed.hash) {
    throw new ApiProfileError("Base URL cannot contain a query or fragment", "VALIDATION");
  }
  return parsed.toString().replace(/\/+$/, "");
}
