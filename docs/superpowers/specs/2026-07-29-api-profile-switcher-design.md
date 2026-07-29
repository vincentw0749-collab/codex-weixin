# API Profile Switcher Design

## Goal

Add an API connection manager to the existing codex-weixin Settings view. A user can save several OpenAI Responses-compatible API endpoints and switch the WeChat Codex runtime between them without editing TOML, exposing secrets to the browser, losing WeChat login state, or losing managed Codex sessions.

The feature controls only the Codex runtime launched by codex-weixin. It does not modify the desktop Codex user's global provider configuration.

## User Experience

The Settings view gains an unframed "API connections" group above the existing Codex runtime settings.

Each saved connection is one compact row containing:

- Display name
- Base URL
- Default model
- Active or unavailable state
- Icon buttons for test, edit, activate, and delete

The active connection uses a status dot and an explicit "Current" label. Activating another row is a single click. Destructive removal uses the existing confirmation-dialog pattern. Familiar Lucide icons and hover tooltips are used for row actions.

An Add/Edit dialog contains:

- Connection name
- Base URL
- API key in a password field with a show/hide control
- Default model ID
- Two commands: "Save" and "Save and activate"

Editing a profile leaves its stored key unchanged when the key field is blank. The UI never receives an existing API key or encrypted payload. Responses API is the only supported wire protocol and is stated as a fixed compatibility requirement instead of exposed as a misleading selector.

The existing connection is imported as the initial active profile during first migration. Existing settings for model, reasoning effort, workspace, and streaming remain intact.

## Architecture

### Storage

Add `apiProfilesPath` to `StatePaths`, pointing to `~/.codex-weixin/api-profiles.json`.

The store uses a versioned document:

```json
{
  "version": 1,
  "activeProfileId": "uuid",
  "profiles": [
    {
      "id": "uuid",
      "name": "Primary",
      "baseUrl": "https://api.example/v1",
      "model": "gpt-5.6-terra",
      "encryptedApiKey": "dpapi-base64",
      "createdAt": "ISO-8601",
      "updatedAt": "ISO-8601"
    }
  ]
}
```

Writes are atomic. Names are unique case-insensitively. Base URLs must use `http:` or `https:`, have no credentials, and are normalized without trailing slashes. IDs are generated server-side.

On Windows, API keys are encrypted for the current Windows user with DPAPI. Ciphertext is stored locally and cannot be decrypted under another Windows account. The key, ciphertext, and decrypted value are never returned by the HTTP API or written to logs. A profile summary exposes only `hasApiKey: true`.

The implementation fails closed if DPAPI is unavailable. It does not silently fall back to plaintext storage.

### Active Runtime Contract

The codex-weixin Codex wrapper reads the active profile from the profile store, decrypts the key for the current Windows user, and exports it only to the child Codex process using `CODEX_WEIXIN_PROVIDER_KEY`.

The dedicated Codex home continues to use a stable provider ID, `codex_local_access`, with:

- `wire_api = "responses"`
- `env_key = "CODEX_WEIXIN_PROVIDER_KEY"`
- The active profile's Base URL
- The active profile's default model

Activating a profile updates the dedicated Codex configuration atomically, updates codex-weixin's selected model, and restarts running account runners. WeChat credentials, authorization lists, sessions, and attachment storage are untouched.

### Migration

On the first run without `api-profiles.json`, import the currently working provider as a profile named "Current API". Read the Base URL and model from the dedicated codex-weixin Codex configuration. Migrate the current bearer token through the wrapper's existing compatible token source, encrypt it, and remove no existing data. Migration is idempotent.

### HTTP API

All mutation routes retain the existing local Host/Origin and request-token checks.

- `GET /api/api-profiles`: return profile summaries and active ID
- `POST /api/api-profiles`: create a profile
- `PATCH /api/api-profiles/:id`: edit profile metadata and optionally replace the key
- `DELETE /api/api-profiles/:id`: remove an inactive profile
- `POST /api/api-profiles/:id/test`: issue a minimal Responses request without changing active state
- `POST /api/api-profiles/:id/activate`: activate, restart runners, and return refreshed runtime data

The active profile cannot be deleted. The last remaining profile cannot be deleted.

### Test And Activation Behavior

Connection testing sends a minimal non-streaming request to `<baseUrl>/responses` using the saved model and bearer token. It uses a short timeout and requests a fixed short response. Errors are reduced to a useful status message without including response bodies that might contain secrets.

Activation is transactional:

1. Snapshot the previous active profile and generated Codex configuration.
2. Generate the new configuration and restart account runners.
3. Confirm that Codex starts and reports the expected provider/model.
4. Persist the new active ID.
5. On failure, restore the previous configuration and active ID, restart the previous runtime, and return the failure.

Testing a profile is explicit. "Save and activate" performs activation validation but does not require a separate test click.

## Components

- `src/state/api-profiles.ts`: validation, CRUD, migration, atomic persistence, public summaries
- `src/security/dpapi.ts`: Windows DPAPI encrypt/decrypt boundary
- `src/codex/provider-config.ts`: deterministic dedicated Codex TOML generation
- `src/server/http-server.ts`: authenticated routes and response shaping
- `src/server/account-manager.ts`: controlled runtime restart and runtime verification reuse
- `src/state/paths.ts`: profile and dedicated Codex config paths
- `src/web/index.html`: Settings group and Add/Edit dialog
- `src/web/app.js`: profile state, API calls, rendering, dialog behavior, action feedback
- `src/web/styles.css`: compact responsive rows and dialog fields matching the current UI
- `scripts/codex-weixin-codex.mjs`: profile-aware child environment without exposing secrets

## Error Handling

- Duplicate name, malformed URL, blank model, or missing key: reject with field-specific 400 errors.
- API authentication/protocol failure: keep the current profile active and show a concise connection error.
- Runtime restart failure: rollback and report that the previous API remains active.
- Corrupt profile storage: preserve the file, refuse mutation, and show a repair-oriented error.
- Missing active profile/key: service remains available for management but does not start Codex turns until repaired.
- Concurrent mutation: serialize writes and activation operations inside the store.

## Verification

Automated tests cover:

- Profile validation, normalization, uniqueness, CRUD, and atomic persistence
- DPAPI round trip and wrong-payload failure on Windows
- No secret material in profile summaries, API responses, logs, or error text
- First-run migration and idempotency
- Generated TOML escaping and active profile selection
- HTTP authorization and every route's success/failure behavior
- Activation success, restart, and rollback
- Active/last-profile deletion protection
- Existing account, session, attachment, and config tests remain green

UI verification covers desktop and mobile widths, keyboard operation, password visibility, Add/Edit/Save/Test/Activate/Delete flows, long Base URLs, loading/disabled states, and error messages. Screenshots are inspected for text overlap, overflow, clipped controls, and consistency with the existing management UI.

## Delivery

Build from the local `feature/api-profiles` branch, run typecheck and the complete test suite, then point the existing launcher at the verified local build. Back up the current launcher/config first. Confirm the current WeChat account remains running, the three managed sessions remain present, the active conversation history still loads, and a real test message succeeds through the selected profile.
