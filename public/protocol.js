const SECRET_KEY = /(authorization|api[-_]?key|token|secret|password|credential|cookie)/i;
const PRIVATE_KEY = /^(reasoningContent|reasoning_content)$/i;
const SECRET_VALUE = /(Bearer\s+)[A-Za-z0-9._~+\/-]+|nyx(?:id)?_[A-Za-z0-9_-]{8,}/gi;

export async function consumeSse(response, onFrame) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const parsed = extractSseEvents(buffer, done);
    buffer = parsed.rest;
    for (const event of parsed.events) {
      if (!event.data || event.data === "[DONE]") continue;
      try {
        await onFrame(JSON.parse(event.data), event);
      } catch (error) {
        await onFrame({
          type: "DEMO_PROTOCOL_ERROR",
          protocolError: { message: error.message, raw: event.data.slice(0, 500) },
        }, event);
      }
    }
    if (done) break;
  }
}

export function extractSseEvents(input, flush = false) {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = flush ? "" : blocks.pop() || "";
  const events = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = "message";
    let id = "";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0
        ? ""
        : line.slice(separator + 1).replace(/^ /, "");
      if (field === "event") event = value;
      if (field === "id") id = value;
      if (field === "data") data.push(value);
    }
    if (data.length) events.push({ event, id, data: data.join("\n") });
  }
  if (flush && rest.trim()) {
    const tail = extractSseEvents(`${rest}\n\n`, false);
    events.push(...tail.events);
  }
  return { events, rest };
}

export function normalizeFrame(raw) {
  if (!raw || typeof raw !== "object") {
    return { type: "unknown", raw };
  }

  if (raw.type) return normalizeTypedFrame(raw);
  if (raw.runStarted) return { type: "run_started", ...raw.runStarted, raw };
  if (raw.runFinished) return { type: "run_finished", ...raw.runFinished, raw };
  if (raw.runError) return { type: "run_error", ...raw.runError, raw };
  if (raw.runStopped) return { type: "run_stopped", ...raw.runStopped, raw };
  if (raw.stepStarted) return { type: "step_started", ...raw.stepStarted, raw };
  if (raw.stepFinished) return { type: "step_finished", ...raw.stepFinished, raw };
  if (raw.textMessageStart) return { type: "text_start", ...raw.textMessageStart, raw };
  if (raw.textMessageContent) return { type: "text_delta", ...raw.textMessageContent, raw };
  if (raw.textMessageEnd) return { type: "text_end", ...raw.textMessageEnd, raw };
  if (raw.toolCallStart) return { type: "tool_start", ...raw.toolCallStart, raw };
  if (raw.toolCallEnd) return { type: "tool_end", ...raw.toolCallEnd, raw };
  if (raw.usage) return { type: "usage", ...raw.usage, raw };
  if (raw.stateSnapshot) return { type: "state_snapshot", ...raw.stateSnapshot, raw };
  if (raw.custom) return normalizeCustom(raw.custom, raw);
  return { type: "unknown", raw };
}

function normalizeTypedFrame(raw) {
  switch (String(raw.type).toUpperCase()) {
    case "RUN_STARTED":
      return { type: "run_started", actorId: raw.actorId, ...(raw.runStarted || {}), raw };
    case "RUN_FINISHED":
      return { type: "run_finished", ...(raw.runFinished || {}), raw };
    case "RUN_ERROR":
      return { type: "run_error", ...(raw.runError || {}), raw };
    case "TEXT_MESSAGE_START":
      return { type: "text_start", ...(raw.textMessageStart || {}), raw };
    case "TEXT_MESSAGE_CONTENT":
      return { type: "text_delta", ...(raw.textMessageContent || {}), raw };
    case "TEXT_MESSAGE_END":
      return { type: "text_end", ...(raw.textMessageEnd || {}), raw };
    case "TOOL_CALL_START":
      return { type: "tool_start", ...(raw.toolCallStart || {}), raw };
    case "TOOL_CALL_END":
      return { type: "tool_end", ...(raw.toolCallEnd || {}), raw };
    case "TOOL_APPROVAL_REQUEST":
      return {
        type: "approval",
        approvalKind: "nyxid-chat",
        ...(raw.toolApprovalRequest || {}),
        raw,
      };
    case "AUTHORIZATION_REQUIRED":
      return {
        type: "authorization_required",
        ...(raw.authorizationRequired || {}),
        raw,
      };
    case "USAGE":
      return { type: "usage", ...(raw.usage || {}), raw };
    case "MEDIA_CONTENT":
      return { type: "media", ...(raw.mediaContent || {}), raw };
    case "CUSTOM":
      return normalizeCustom(raw.custom || {}, raw);
    case "DEMO_PROTOCOL_ERROR":
      return { type: "protocol_error", ...(raw.protocolError || {}), raw };
    default:
      return { type: String(raw.type).toLowerCase(), raw };
  }
}

function normalizeCustom(custom, raw) {
  const name = String(custom.name || "");
  const payload = unpackAny(custom.payload);
  if (name === "aevatar.run.context") {
    return { type: "run_context", ...payload, name, raw };
  }
  if (name === "demo.conversation.context") {
    return { type: "conversation_context", ...payload, name, raw };
  }
  if (name === "aevatar.step.request") {
    return { type: "step_request", ...payload, name, raw };
  }
  if (name === "aevatar.step.completed") {
    return { type: "step_completed", ...payload, name, raw };
  }
  if (name === "aevatar.llm.reasoning") {
    return { type: "reasoning", name, raw };
  }
  if (name === "aevatar.human_input.request") {
    return {
      type: "approval",
      approvalKind: "workflow",
      ...payload,
      name,
      raw,
    };
  }
  if (name === "aevatar.tool_approval.pending") {
    return {
      type: "approval",
      approvalKind: "workflow",
      ...payload,
      toolApproval: {
        executionId: payload.executionId,
        toolCallId: payload.toolCallId,
        approvalRequestId: payload.approvalRequestId,
      },
      name,
      raw,
    };
  }
  if (name === "aevatar.authorization.required" || name === "nyxid.authorization.required") {
    return { type: "authorization_required", ...payload, name, raw };
  }
  if (name === "aevatar.workflow.waiting_signal") {
    return { type: "waiting_signal", ...payload, name, raw };
  }
  if (name === "aevatar.nyxid_chat.keepalive") {
    return { type: "keepalive", ...payload, name, raw };
  }
  if (name === "aevatar.raw.observed") {
    const nestedPayload = payload.payload && typeof payload.payload === "object"
      ? unpackAny(payload.payload)
      : payload;
    const payloadTypeUrl = payload.payloadTypeUrl ||
      payload.payload?.["@type"] ||
      custom.payload?.["@type"] ||
      "";
    const observedType = String(payloadTypeUrl).split(/[/.]/).at(-1) || "unknown";
    const observedEnvelope = {
      eventId: payload.eventId,
      publisherActorId: payload.publisherActorId,
      correlationId: payload.correlationId,
      stateVersion: payload.stateVersion,
    };
    if (observedType === "RoleChatSessionCompletedEvent") {
      return {
        type: "role_chat_completed",
        ...nestedPayload,
        observedType,
        observedEnvelope,
        name,
        raw,
      };
    }
    return {
      type: "raw_observed",
      observedType,
      observed: nestedPayload,
      observedEnvelope,
      name,
      raw,
    };
  }
  return { type: "custom", name, payload, raw };
}

export function unpackAny(payload) {
  if (!payload || typeof payload !== "object") return {};
  if (payload.value && typeof payload.value === "object") return payload.value;
  const clone = { ...payload };
  delete clone["@type"];
  return clone;
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        PRIVATE_KEY.test(key)
          ? "[not displayed]"
          : SECRET_KEY.test(key)
            ? "[redacted]"
            : redact(item),
      ]),
    );
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return JSON.stringify(redact(JSON.parse(trimmed)));
      } catch {
        // Fall through to pattern-based redaction for non-JSON tool output.
      }
    }
    return value
      .replace(
        /("?(?:authorization|api[-_]?key|token|secret|password|credential|cookie)"?\s*[:=]\s*)"?[^",\s}]+"?/gi,
        "$1\"[redacted]\"",
      )
      .replace(SECRET_VALUE, (match, prefix) => prefix ? `${prefix}[redacted]` : "nyx_[redacted]");
  }
  return value;
}

export function safeJson(value, spacing = 2) {
  try {
    return JSON.stringify(redact(value), null, spacing);
  } catch {
    return "[unserializable event]";
  }
}

export function parseArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return redact(value);
  try {
    return redact(JSON.parse(value));
  } catch {
    return { value: redact(String(value)) };
  }
}

export function mergeUsage(current, incoming) {
  const supported = [
    "available",
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "model",
  ];
  const next = { ...(current || {}) };
  let changed = false;
  for (const key of supported) {
    const value = incoming?.[key];
    if (value === undefined || value === null || value === "") continue;
    next[key] = value;
    changed = true;
  }
  return changed ? next : current || null;
}

export function normalizeConversationIndex(value) {
  const source = Array.isArray(value)
    ? value
    : Array.isArray(value?.conversations)
      ? value.conversations
      : [];
  return source
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      id: String(item.id || item.actorId || "").trim(),
      title: String(item.title || "未命名会话").trim() || "未命名会话",
      serviceId: String(item.serviceId || "").trim(),
      serviceKind: String(item.serviceKind || "").trim(),
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || item.createdAt || null,
      messageCount: Number.isFinite(Number(item.messageCount)) ? Number(item.messageCount) : 0,
      llmRoute: item.llmRoute || null,
      llmModel: item.llmModel || null,
    }))
    .filter((item) => item.id)
    .sort((left, right) => {
      const leftTime = Date.parse(left.updatedAt || "") || 0;
      const rightTime = Date.parse(right.updatedAt || "") || 0;
      return rightTime - leftTime;
    });
}

export function normalizeStoredMessages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item, index) => ({
      id: String(item.id || `history-message-${index}`),
      role: String(item.role || "assistant").toLowerCase(),
      content: String(item.content || ""),
      timestamp: Number.isFinite(Number(item.timestamp)) ? Number(item.timestamp) : 0,
      status: String(item.status || "completed"),
      error: item.error ? String(item.error) : null,
    }));
}
