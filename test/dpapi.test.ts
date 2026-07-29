import assert from "node:assert/strict";
import test from "node:test";

import { WindowsDpapiProtector } from "../src/security/dpapi.js";

test("protects and restores a secret for the current Windows user", {
  skip: process.platform !== "win32"
}, async () => {
  const protector = new WindowsDpapiProtector();
  const encrypted = await protector.protect("secret-value");

  assert.notEqual(encrypted, "secret-value");
  assert.equal(await protector.unprotect(encrypted), "secret-value");
});

test("rejects invalid DPAPI ciphertext without echoing it", {
  skip: process.platform !== "win32"
}, async () => {
  const protector = new WindowsDpapiProtector();
  const invalid = "not-valid-dpapi-ciphertext";

  await assert.rejects(
    protector.unprotect(invalid),
    (error: Error) => !error.message.includes(invalid) && /decrypt/i.test(error.message)
  );
});
