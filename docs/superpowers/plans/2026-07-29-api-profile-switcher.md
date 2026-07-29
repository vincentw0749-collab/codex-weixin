# API Profile Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add encrypted, saved API profiles and one-click runtime switching to the codex-weixin Settings page.

**Architecture:** A focused profile store owns validation, DPAPI ciphertext, migration, and atomic persistence. An API profile manager owns connection tests and transactional runtime activation. The HTTP server exposes only redacted summaries, while a dedicated Codex wrapper decrypts the active key directly into the child process environment.

**Tech Stack:** TypeScript, Node.js 22, Windows DPAPI through non-interactive PowerShell, Zod, native `node:test`, vanilla HTML/CSS/JavaScript, Lucide icons.

---

### Task 1: State paths and DPAPI boundary

**Files:**
- Modify: `src/state/paths.ts`
- Create: `src/security/dpapi.ts`
- Create: `test/dpapi.test.ts`
- Modify: `test/paths.test.ts`

- [ ] **Step 1: Write failing path and protector tests**

Add assertions that `resolveStatePaths(root)` returns `apiProfilesPath` and `codexHomeDir`. Add a Windows-only round-trip test and an invalid-ciphertext rejection test for `WindowsDpapiProtector`.

```ts
test("protects and restores a secret for the current Windows user", async () => {
  const protector = new WindowsDpapiProtector();
  const encrypted = await protector.protect("secret-value");
  assert.notEqual(encrypted, "secret-value");
  assert.equal(await protector.unprotect(encrypted), "secret-value");
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `npm test -- test/paths.test.ts test/dpapi.test.ts`

Expected: TypeScript import/property failures because the new path fields and protector do not exist.

- [ ] **Step 3: Implement the minimal DPAPI adapter**

Expose this interface and class:

```ts
export interface SecretProtector {
  protect(secret: string): Promise<string>;
  unprotect(ciphertext: string): Promise<string>;
}

export class WindowsDpapiProtector implements SecretProtector {
  protect(secret: string): Promise<string>;
  unprotect(ciphertext: string): Promise<string>;
}
```

Pass secret material to PowerShell through temporary child environment variables, use `ProtectedData` with `DataProtectionScope.CurrentUser`, set `windowsHide: true`, and never include secret values in thrown messages.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `npm test -- test/paths.test.ts test/dpapi.test.ts`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```text
feat: add encrypted API profile state paths
```

### Task 2: Versioned API profile store

**Files:**
- Create: `src/state/api-profiles.ts`
- Create: `test/api-profiles.test.ts`

- [ ] **Step 1: Write failing CRUD and redaction tests**

Define the desired public API in tests:

```ts
const store = new ApiProfileStore(paths, protector);
const created = await store.create({
  name: "Primary",
  baseUrl: "https://api.example/v1/",
  apiKey: "sk-private",
  model: "gpt-5.6-terra"
});
assert.equal(created.baseUrl, "https://api.example/v1");
assert.equal(created.hasApiKey, true);
assert.equal(JSON.stringify(store.list()), JSON.stringify(store.list()).replace("sk-private", "sk-private"));
```

Cover unique names, URL normalization, invalid schemes/embedded credentials, blank keys, optional key replacement on edit, active/last-profile deletion guards, corrupt JSON, serialized mutation, atomic writes, and idempotent migration.

- [ ] **Step 2: Run the store test and confirm RED**

Run: `npm test -- test/api-profiles.test.ts`

Expected: module-not-found failure for `src/state/api-profiles.ts`.

- [ ] **Step 3: Implement types and store**

Implement:

```ts
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

export class ApiProfileStore {
  list(): ApiProfileSummary[];
  getActive(): ApiProfileSummary | undefined;
  create(input: CreateApiProfileInput): Promise<ApiProfileSummary>;
  update(id: string, input: UpdateApiProfileInput): Promise<ApiProfileSummary>;
  delete(id: string): Promise<void>;
  activate(id: string): Promise<ApiProfileSummary>;
  readSecret(id: string): Promise<string>;
  ensureMigrated(seed?: ApiProfileSeed): Promise<void>;
}
```

Use a private promise queue for mutations, `crypto.randomUUID()`, a version discriminator, and temp-file-plus-rename writes in the state directory.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `npm test -- test/api-profiles.test.ts`

Expected: all store tests pass and no assertion output contains a key or ciphertext.

- [ ] **Step 5: Commit**

```text
feat: persist encrypted API profiles
```

### Task 3: Dedicated provider configuration and wrapper

**Files:**
- Create: `src/codex/provider-config.ts`
- Create: `scripts/codex-weixin-codex.mjs`
- Create: `test/provider-config.test.ts`

- [ ] **Step 1: Write failing provider rendering and migration parsing tests**

Test deterministic TOML rendering, escaping, model/base URL substitution, fixed Responses wire protocol, constant environment-key reference, and extraction of a seed from existing dedicated/global Codex configuration without exposing the token in a public object.

```ts
const toml = renderProviderConfig(profile, {
  instructionsFile: "C:\\Users\\Test\\.codex\\instructions.md"
});
assert.match(toml, /wire_api = "responses"/);
assert.match(toml, /env_key = "CODEX_WEIXIN_PROVIDER_KEY"/);
assert.doesNotMatch(toml, /sk-private/);
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm test -- test/provider-config.test.ts`

Expected: module-not-found failure for `provider-config.ts`.

- [ ] **Step 3: Implement renderer, atomic writer, seed reader, and wrapper**

The wrapper must:

1. Read `~/.codex-weixin/api-profiles.json`.
2. Select `activeProfileId`.
3. Decrypt `encryptedApiKey` with current-user DPAPI without printing it.
4. Locate the newest local Codex desktop executable.
5. Launch it with original arguments and these child-only environment variables:

```js
{
  CODEX_HOME: path.join(os.homedir(), ".codex-weixin", "codex-home"),
  CODEX_SQLITE_HOME: path.join(os.homedir(), ".codex"),
  CODEX_WEIXIN_PROVIDER_KEY: decryptedKey
}
```

Forward `SIGINT` and `SIGTERM`, inherit stdio, hide the child window, and return the child exit code.

- [ ] **Step 4: Run focused tests and static checks**

Run: `npm test -- test/provider-config.test.ts`

Run: `node --check scripts/codex-weixin-codex.mjs`

Expected: both commands exit 0.

- [ ] **Step 5: Commit**

```text
feat: generate isolated Codex provider config
```

### Task 4: Connection test and transactional activation manager

**Files:**
- Create: `src/server/api-profile-manager.ts`
- Create: `test/api-profile-manager.test.ts`
- Modify: `src/server/account-manager.ts`

- [ ] **Step 1: Write failing connection and activation tests**

Use injected `fetch`, config writer, runtime reader, and runner restarter functions. Cover:

- Test request URL, bearer header, Responses JSON shape, model, timeout, and successful status.
- Sanitized 401, 404, timeout, malformed JSON, and protocol failure errors.
- Activation order: test, active ID update, config write, codex-weixin model update, restart, runtime verification.
- Rollback of active ID, generated TOML, model selection, and runtime after restart/verification failure.

```ts
await manager.activate(profile.id);
assert.deepEqual(events, [
  "test:profile",
  "active:profile",
  "write-config:profile",
  "restart",
  "verify:gpt-5.6-terra"
]);
```

- [ ] **Step 2: Run the manager test and confirm RED**

Run: `npm test -- test/api-profile-manager.test.ts`

Expected: module-not-found failure for `api-profile-manager.ts`.

- [ ] **Step 3: Implement the manager**

Expose `list`, `create`, `update`, `delete`, `test`, and `activate`. Use `AbortSignal.timeout(20_000)` for provider checks. Read at most a bounded response body for error classification and never include response bodies, request headers, ciphertext, or decrypted keys in errors.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `npm test -- test/api-profile-manager.test.ts`

Expected: all manager tests pass.

- [ ] **Step 5: Commit**

```text
feat: switch API profiles transactionally
```

### Task 5: Authenticated HTTP API and bootstrap integration

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/server/http-server.ts`
- Modify: `test/http-server.test.ts`

- [ ] **Step 1: Write failing route tests**

Add tests for bootstrap summaries and all six routes. Assert mutation requests reject missing Origin/token, profile responses never contain `apiKey` or `encryptedApiKey`, edit preserves a blank key, active deletion returns 409, and activation returns refreshed `apiProfiles`, `config`, and `codexRuntime`.

- [ ] **Step 2: Run HTTP tests and confirm RED**

Run: `npm test -- test/http-server.test.ts`

Expected: 404 responses for `/api/api-profiles` routes.

- [ ] **Step 3: Add schemas, routes, and startup wiring**

Use Zod schemas with these body limits:

```ts
const apiProfileCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  baseUrl: z.string().trim().min(1).max(2048),
  apiKey: z.string().min(1).max(8192),
  model: z.string().trim().min(1).max(200)
});
```

Add `apiProfiles` and `activeApiProfileId` to bootstrap. Instantiate and migrate the manager before starting accounts so the wrapper always has an active profile.

- [ ] **Step 4: Run HTTP and existing server tests**

Run: `npm test -- test/http-server.test.ts test/account-manager.test.ts test/config.test.ts`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```text
feat: expose local API profile management routes
```

### Task 6: Settings UI

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`

- [ ] **Step 1: Add the semantic API connection group and dialog**

Add IDs used by the controller:

```text
apiProfilesList
addApiProfileButton
apiProfileDialog
apiProfileForm
apiProfileNameInput
apiProfileBaseUrlInput
apiProfileKeyInput
apiProfileModelInput
toggleApiProfileKeyButton
saveApiProfileButton
saveActivateApiProfileButton
```

Use existing button, dialog, form, and Lucide conventions. Keep protocol text concise and non-interactive.

- [ ] **Step 2: Implement rendering and actions**

Add profile data to frontend state, render compact profile rows, and support add/edit, key visibility, test, activate, and delete actions. Disable affected actions while a request is running, redraw icons after rendering, refresh bootstrap state after mutations, and announce success/failure through the existing toast.

- [ ] **Step 3: Add responsive styles**

Use a stable grid for name/URL/model/status/actions, collapse to labeled rows below the existing mobile breakpoint, clamp long URLs with a title tooltip, and keep action buttons fixed-size so loading states do not shift layout.

- [ ] **Step 4: Build and inspect generated assets**

Run: `npm run typecheck`

Run: `npm run build`

Expected: both commands exit 0 and `dist/web` contains the new controls.

- [ ] **Step 5: Commit**

```text
feat: add API profile switcher to settings
```

### Task 7: Full verification and local deployment

**Files:**
- Modify: `D:\VSCODE\project\codex-weixin-launcher.ps1`
- Modify: `C:\Users\Wang Vincent\.codex-weixin\config.json`
- Backup: `D:\VSCODE\project\shortcut-backups\`

- [ ] **Step 1: Run complete automated verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run build`

Expected: zero failed tests, zero TypeScript errors, and a successful build.

- [ ] **Step 2: Back up the active launcher and configuration**

Create timestamped copies before changing the running target. Do not copy or print decrypted API keys into logs or the repository.

- [ ] **Step 3: Point the launcher to the verified local build**

Launch `node dist/server/index.js` from `D:\VSCODE\project\codex-weixin-custom`, retain port `8787`, `CODEX_WEIXIN_OPEN=0`, hidden-window behavior, and current state directory.

- [ ] **Step 4: Migrate and verify the current API profile**

Confirm the current profile appears active, the API key is masked, Codex reports `gpt-5.6-terra` with `medium` effort, the WeChat account is running, all three managed sessions remain, and the active history loads.

- [ ] **Step 5: Browser and responsive QA**

Verify `http://127.0.0.1:8787/#settings` at desktop and mobile widths. Exercise add/edit/save/test/activate/delete, inspect screenshots for text overlap, overflow, clipped controls, dialog fit, button shifts, and long-URL behavior.

- [ ] **Step 6: End-to-end API switch and rollback test**

Save a second valid profile, switch to it, send a real short Codex message, switch back, and confirm both replies. Attempt an invalid profile and confirm the original profile remains active and the WeChat account continues running.

- [ ] **Step 7: Verify startup shortcuts**

Confirm both desktop and Startup shortcuts still resolve to the launcher and that the launcher starts the custom build after a controlled service restart.

- [ ] **Step 8: Final commit**

```text
chore: deploy verified API profile switcher
```
