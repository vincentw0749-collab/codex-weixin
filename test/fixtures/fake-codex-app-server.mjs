#!/usr/bin/env node

import fs from "node:fs";
import readline from "node:readline";

if (process.argv[2] === "exec") {
  process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "thread-exec-fallback" })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "unexpected exec fallback" }
  })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
let nextTurn = 1;
const activeTurns = new Map();
const approvalResponses = new Map();
const recoverableTurns = new Map();
const unresponsiveProbeThreads = new Set();
const unresponsiveInterruptThreads = new Set();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function fail(id, message) {
  send({ id, error: { code: -32602, message } });
}

function completedTurn(id, status, error = null) {
  return {
    id,
    items: [],
    itemsView: "full",
    status,
    error,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1
  };
}

rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (!message.method && approvalResponses.has(message.id)) {
    const expected = approvalResponses.get(message.id);
    approvalResponses.delete(message.id);
    if (JSON.stringify(message.result) !== JSON.stringify(expected.result)) {
      process.stderr.write(`unexpected approval response for ${message.id}: ${JSON.stringify(message.result)}\n`);
      process.exit(2);
      return;
    }
    if (!approvalResponses.size) {
      completePrompt(expected.threadId, expected.turnId, "approval");
    }
    return;
  }

  if (message.method === "initialize") {
    if (message.jsonrpc) {
      fail(message.id, "jsonrpc header must be omitted");
      return;
    }
    if (message.params?.clientInfo?.name !== "codex-weixin") {
      fail(message.id, "missing codex-weixin clientInfo");
      return;
    }
    respond(message.id, {
      userAgent: "fake-codex",
      codexHome: "/tmp/fake-codex-home",
      platformFamily: "unix",
      platformOs: "test"
    });
    return;
  }

  if (message.method === "initialized") {
    initialized = true;
    return;
  }

  if (!initialized) {
    fail(message.id, "Not initialized");
    return;
  }

  if (message.method === "thread/start") {
    if (message.params?.approvalPolicy !== "never") {
      fail(message.id, "approvalPolicy must be never");
      return;
    }
    respond(message.id, {
      thread: { id: "thread-new" },
      model: message.params.model ?? "configured-model",
      reasoningEffort: "high"
    });
    return;
  }

  if (message.method === "thread/resume") {
    respond(message.id, {
      thread: { id: message.params.threadId },
      model: "resumed-model",
      reasoningEffort: "medium"
    });
    return;
  }

  if (message.method === "config/read") {
    respond(message.id, {
      config: {
        model: "configured-model",
        model_provider: "FixtureProvider",
        model_reasoning_effort: "high"
      },
      origins: {}
    });
    return;
  }

  if (message.method === "model/list") {
    respond(message.id, {
      data: [{
        id: "configured-model",
        model: "configured-model",
        displayName: "Configured Model",
        description: "Model used by the test fixture.",
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced" },
          { reasoningEffort: "high", description: "Deeper reasoning" }
        ],
        defaultReasoningEffort: "medium",
        isDefault: true
      }],
      nextCursor: null
    });
    return;
  }

  if (message.method === "thread/list") {
    respond(message.id, { data: [{ id: "thread-new" }], nextCursor: null, backwardsCursor: null });
    return;
  }

  if (message.method === "thread/read") {
    if (unresponsiveProbeThreads.has(message.params.threadId)) {
      return;
    }
    const recoverable = recoverableTurns.get(message.params.threadId);
    if (recoverable) {
      respond(message.id, {
        thread: {
          id: message.params.threadId,
          turns: [recoverable]
        }
      });
      return;
    }
    const activeTurnId = activeTurns.get(message.params.threadId);
    if (activeTurnId) {
      respond(message.id, {
        thread: {
          id: message.params.threadId,
          turns: [completedTurn(activeTurnId, "inProgress")]
        }
      });
      return;
    }
    respond(message.id, {
      thread: {
        id: message.params.threadId,
        turns: [
          {
            id: "history-turn-1",
            status: "completed",
            startedAt: 1_700_000_000,
            completedAt: 1_700_000_002,
            items: [
              {
                type: "userMessage",
                id: "history-user-1",
                clientId: null,
                content: [{ type: "text", text: "hello history", text_elements: [] }]
              },
              {
                type: "agentMessage",
                id: "history-commentary-1",
                text: "working",
                phase: "commentary",
                memoryCitation: null
              },
              {
                type: "agentMessage",
                id: "history-assistant-1",
                text: "history reply",
                phase: "final_answer",
                memoryCitation: null
              },
              { type: "reasoning", id: "history-reasoning-1", summary: [], content: ["hidden"] }
            ]
          }
        ]
      }
    });
    return;
  }

  if (message.method === "turn/start") {
    const turnId = `turn-${nextTurn++}`;
    const prompt = message.params?.input?.[0]?.text;
    if (message.params?.input?.[0]?.type !== "text" || typeof prompt !== "string") {
      fail(message.id, "turn/start requires text input");
      return;
    }
    activeTurns.set(message.params.threadId, turnId);
    respond(message.id, { turn: completedTurn(turnId, "inProgress") });
    if (prompt === "hold") {
      if (process.env.CODEX_TEST_HOLD_MARKER) {
        fs.writeFileSync(process.env.CODEX_TEST_HOLD_MARKER, "started");
      }
      return;
    }
    if (prompt === "unresponsive-probe") {
      unresponsiveProbeThreads.add(message.params.threadId);
      return;
    }
    if (prompt === "unresponsive-interrupt") {
      unresponsiveInterruptThreads.add(message.params.threadId);
      return;
    }
    if (prompt === "approval") {
      requestApprovals(message.params.threadId, turnId);
      return;
    }
    setTimeout(() => {
      completePrompt(message.params.threadId, turnId, prompt, {
        omitTurnCompleted: prompt === "missing-completion"
      });
    }, prompt === "slow" ? 400 : prompt === "in-progress" ? 110 : 5);
    return;
  }

  if (message.method === "turn/interrupt") {
    if (unresponsiveInterruptThreads.has(message.params.threadId)) {
      return;
    }
    const activeTurnId = activeTurns.get(message.params.threadId);
    if (activeTurnId !== message.params.turnId) {
      fail(message.id, "turn/interrupt used the wrong turnId");
      return;
    }
    respond(message.id, {});
    send({
      method: "turn/completed",
      params: { threadId: message.params.threadId, turn: completedTurn(activeTurnId, "interrupted") }
    });
    activeTurns.delete(message.params.threadId);
    return;
  }

  fail(message.id, `unsupported method: ${message.method}`);
});

function requestApprovals(threadId, turnId) {
  const requests = [
    {
      id: "approve-command",
      method: "item/commandExecution/requestApproval",
      params: { threadId, turnId, itemId: "command-item", command: "test" },
      result: { decision: "acceptForSession" }
    },
    {
      id: "approve-file",
      method: "item/fileChange/requestApproval",
      params: { threadId, turnId, itemId: "file-item", grantRoot: "/tmp/project" },
      result: { decision: "acceptForSession" }
    },
    {
      id: "approve-permissions",
      method: "item/permissions/requestApproval",
      params: {
        threadId,
        turnId,
        itemId: "permissions-item",
        permissions: { network: { domains: { "127.0.0.1": "allow" } } }
      },
      result: {
        permissions: { network: { domains: { "127.0.0.1": "allow" } } },
        scope: "session"
      }
    }
  ];
  for (const request of requests) {
    approvalResponses.set(request.id, { result: request.result, threadId, turnId });
    send({ id: request.id, method: request.method, params: request.params });
  }
}

function completePrompt(threadId, turnId, prompt, options = {}) {
  const progressCount = prompt === "stuck-progress-queue" ? 4 : 1;
  for (let index = 0; index < progressCount; index += 1) {
    const progressItemId = `progress-${turnId}-${index}`;
    const progressText = progressCount === 1 ? `working:${prompt}` : `working:${prompt}:${index}`;
    send({
      method: "item/started",
      params: {
        threadId,
        turnId,
        item: { type: "agentMessage", id: progressItemId, text: "", phase: "commentary", memoryCitation: null }
      }
    });
    send({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: progressItemId, delta: progressText }
    });
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        completedAtMs: Date.now(),
        item: { type: "agentMessage", id: progressItemId, text: progressText, phase: "commentary", memoryCitation: null }
      }
    });
  }
  const itemId = `item-${turnId}`;
  send({
    method: "item/started",
    params: {
      threadId,
      turnId,
      item: { type: "agentMessage", id: itemId, text: "", phase: "final_answer", memoryCitation: null }
    }
  });
  for (const delta of ["reply:", prompt]) {
    send({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId, delta }
    });
  }
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      completedAtMs: Date.now(),
      item: { type: "agentMessage", id: itemId, text: `reply:${prompt}`, phase: "final_answer", memoryCitation: null }
    }
  });
  if (options.omitTurnCompleted) {
    recoverableTurns.set(threadId, {
      ...completedTurn(turnId, "completed"),
      items: [{ type: "agentMessage", id: itemId, text: `reply:${prompt}`, phase: "final_answer" }]
    });
    activeTurns.delete(threadId);
    return;
  }
  send({
    method: "turn/completed",
    params: { threadId, turn: completedTurn(turnId, "completed") }
  });
  activeTurns.delete(threadId);
}
