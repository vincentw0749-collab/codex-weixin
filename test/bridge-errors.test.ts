import assert from "node:assert/strict";
import test from "node:test";

import {
  isUnclassifiedMessageHandlingError,
  userFacingMessageHandlingError
} from "../src/bridge/errors.js";

test("returns actionable guidance for the Windows sandbox launch failure", () => {
  const message = userFacingMessageHandlingError(
    new Error("windows sandbox: CreateProcessAsUserW failed: 1312")
  );

  assert.match(message, /codexExecSandbox/);
  assert.match(message, /danger-full-access/);
  assert.match(message, /risk|风险/i);
});

test("returns a retry hint for timeouts", () => {
  assert.match(
    userFacingMessageHandlingError(new Error("codex exec timed out after 600000ms")),
    /重试/
  );
});

test("turns provider rate, concurrency, and availability failures into actionable messages", () => {
  const context = { apiProfileName: "公司api" };
  const rate = userFacingMessageHandlingError(
    new Error("exceeded retry limit, last status: 429 Too Many Requests, request id: secret-request"),
    context
  );
  const concurrency = userFacingMessageHandlingError(
    new Error("Concurrency limit exceeded for user, please retry later"),
    context
  );
  const unavailable = userFacingMessageHandlingError(
    new Error("unexpected status 503 Service Unavailable: https://private.example/v1/responses"),
    context
  );

  assert.match(rate, /公司api/);
  assert.match(rate, /429/);
  assert.match(rate, /\/api/);
  assert.match(concurrency, /并发限制/);
  assert.match(unavailable, /暂时不可用/);
  for (const message of [rate, concurrency, unavailable]) {
    assert.doesNotMatch(message, /secret-request|private\.example/);
  }
});

test("does not expose arbitrary local errors to WeChat", () => {
  const message = userFacingMessageHandlingError(new Error("secret path C:/private/token.txt"));

  assert.doesNotMatch(message, /private|token\.txt/);
  assert.match(message, /本机服务输出/);
});

test("retries only reconnectable transport failures, not explicit provider failures", () => {
  assert.equal(isUnclassifiedMessageHandlingError(new Error("unexpected bridge state")), false);
  assert.equal(
    isUnclassifiedMessageHandlingError(
      new Error("stream disconnected before completion: stream closed before response.completed")
    ),
    true
  );
  assert.equal(isUnclassifiedMessageHandlingError(new Error("unexpected status 502 Bad Gateway")), false);
  assert.equal(isUnclassifiedMessageHandlingError(new Error("unexpected status 503 Service Unavailable")), false);
  assert.equal(isUnclassifiedMessageHandlingError(new Error("socket hang up")), true);
  assert.equal(isUnclassifiedMessageHandlingError(new Error("HTTP 429 rate limit")), false);
  assert.equal(isUnclassifiedMessageHandlingError(new Error("selected model is at capacity")), false);
  assert.equal(
    isUnclassifiedMessageHandlingError(
      new Error("app-server request thread/read timed out after 15000ms")
    ),
    true
  );
  assert.equal(
    isUnclassifiedMessageHandlingError(
      new Error("app-server request thread/start timed out after 45000ms")
    ),
    true
  );
  assert.equal(
    isUnclassifiedMessageHandlingError(
      new Error("Codex app-server exited with code 1")
    ),
    true
  );
  assert.equal(
    isUnclassifiedMessageHandlingError(
      new Error("Codex app-server stdio transport is not connected")
    ),
    true
  );
});
