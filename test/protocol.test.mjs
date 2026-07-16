import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSseEvents,
  mergeUsage,
  normalizeConversationIndex,
  normalizeFrame,
  normalizeStoredMessages,
  parseArguments,
  redact,
} from "../public/protocol.js";

test("extractSseEvents handles chunk boundaries, comments, and multiline data", () => {
  const first = extractSseEvents(": keepalive\n\ndata: {\"a\":", false);
  assert.equal(first.events.length, 0);
  assert.equal(first.rest, "data: {\"a\":");

  const second = extractSseEvents(`${first.rest}1}\n\nevent: custom\ndata: line one\ndata: line two\n\n`, false);
  assert.deepEqual(second.events, [
    { event: "message", id: "", data: "{\"a\":1}" },
    { event: "custom", id: "", data: "line one\nline two" },
  ]);
});

test("normalizeFrame maps workflow protobuf JSON and NyxID AGUI frames", () => {
  assert.deepEqual(
    normalizeFrame({ textMessageContent: { messageId: "m1", delta: "hello" } }).type,
    "text_delta",
  );
  assert.deepEqual(
    normalizeFrame({
      type: "TOOL_CALL_START",
      toolCallStart: { toolCallId: "c1", toolName: "ornn_search_skills" },
    }).type,
    "tool_start",
  );
  assert.deepEqual(
    normalizeFrame({
      custom: {
        name: "nyxid.authorization.required",
        payload: { serviceSlug: "api-github", message: "Grant service access" },
      },
    }),
    {
      type: "authorization_required",
      serviceSlug: "api-github",
      message: "Grant service access",
      name: "nyxid.authorization.required",
      raw: {
        custom: {
          name: "nyxid.authorization.required",
          payload: { serviceSlug: "api-github", message: "Grant service access" },
        },
      },
    },
  );
});

test("normalizeFrame extracts workflow run and approval context from Any JSON", () => {
  const context = normalizeFrame({
    custom: {
      name: "aevatar.run.context",
      payload: {
        "@type": "type.googleapis.com/aevatar.workflow.runs.WorkflowRunContextPayload",
        actorId: "Workflow:1",
        workflowName: "direct",
        commandId: "cmd-1",
      },
    },
  });
  assert.equal(context.type, "run_context");
  assert.equal(context.actorId, "Workflow:1");

  const approval = normalizeFrame({
    custom: {
      name: "aevatar.tool_approval.pending",
      payload: {
        runId: "run-1",
        stepId: "step-1",
        executionId: "exec-1",
        toolCallId: "call-1",
        approvalRequestId: "approval-1",
      },
    },
  });
  assert.equal(approval.type, "approval");
  assert.deepEqual(approval.toolApproval, {
    executionId: "exec-1",
    toolCallId: "call-1",
    approvalRequestId: "approval-1",
  });
});

test("normalizeFrame unwraps raw observed role completion events", () => {
  const completion = normalizeFrame({
    custom: {
      name: "aevatar.raw.observed",
      payload: {
        "@type": "type.googleapis.com/aevatar.workflow.runs.WorkflowObservedEnvelopeCustomPayload",
        eventId: "evt-1",
        payloadTypeUrl: "type.googleapis.com/aevatar.ai.RoleChatSessionCompletedEvent",
        publisherActorId: "WorkflowRole:planner",
        correlationId: "cmd-1",
        stateVersion: "4",
        payload: {
          "@type": "type.googleapis.com/aevatar.ai.RoleChatSessionCompletedEvent",
          sessionId: "session-1",
          content: "done",
          reasoningContent: "private trace",
          toolCalls: [{
            callId: "call-1",
            toolName: "ornn_search_skills",
            argumentsJson: "{\"query\":\"nyxid\"}",
          }],
          toolReceipts: [{
            callId: "call-1",
            toolName: "ornn_search_skills",
            status: "AGENT_TOOL_RECEIPT_STATUS_SUCCESS",
            resultJson: "{\"found\":true}",
          }],
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
          model: "gpt-test",
        },
      },
    },
  });

  assert.equal(completion.type, "role_chat_completed");
  assert.equal(completion.content, "done");
  assert.equal(completion.toolCalls[0].toolName, "ornn_search_skills");
  assert.equal(completion.usage.totalTokens, 120);
  assert.equal(completion.observedEnvelope.eventId, "evt-1");
});

test("mergeUsage preserves known usage when an empty frame arrives", () => {
  const known = { totalTokens: 120, model: "gpt-test" };
  assert.equal(mergeUsage(known, {}), known);
  assert.deepEqual(mergeUsage(known, { promptTokens: 100 }), {
    totalTokens: 120,
    model: "gpt-test",
    promptTokens: 100,
  });
});

test("redact removes credential-shaped keys and values", () => {
  assert.deepEqual(
    redact({ authorization: "Bearer abc.def", nested: { api_key: "secret", note: "nyxid_ag_123456789" } }),
    { authorization: "[redacted]", nested: { api_key: "[redacted]", note: "nyx_[redacted]" } },
  );
  assert.deepEqual(parseArguments('{"token":"abc","action":"list"}'), {
    token: "[redacted]",
    action: "list",
  });
  assert.equal(
    redact('tool result: {"token":"arbitrary-value","ok":true}'),
    'tool result: {"token":"[redacted]","ok":true}',
  );
  assert.equal(redact({ reasoningContent: "private trace" }).reasoningContent, "[not displayed]");
});

test("normalizeConversationIndex keeps real NyxID history metadata and sorts newest first", () => {
  const conversations = normalizeConversationIndex({
    conversations: [
      {
        id: "nyxid-chat-old",
        title: "Older",
        serviceKind: "nyxid.chat",
        updatedAt: "2026-07-14T10:00:00Z",
        messageCount: 2,
      },
      {
        id: "nyxid-chat-new",
        title: "Newest",
        serviceKind: "nyxid.chat",
        updatedAt: "2026-07-15T10:00:00Z",
        messageCount: "4",
        llmModel: null,
      },
    ],
  });
  assert.deepEqual(conversations.map((item) => item.id), ["nyxid-chat-new", "nyxid-chat-old"]);
  assert.equal(conversations[0].messageCount, 4);
  assert.equal(conversations[0].llmModel, null);
});

test("normalizeStoredMessages preserves production roles, content, status, and errors", () => {
  assert.deepEqual(normalizeStoredMessages([
    { id: "u1", role: "USER", content: "hello", timestamp: "123", status: "completed" },
    { id: "a1", role: "assistant", content: "done", timestamp: 124, status: "failed", error: "x" },
  ]), [
    { id: "u1", role: "user", content: "hello", timestamp: 123, status: "completed", error: null },
    { id: "a1", role: "assistant", content: "done", timestamp: 124, status: "failed", error: "x" },
  ]);
});
