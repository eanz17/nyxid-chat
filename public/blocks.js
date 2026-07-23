// Rich content blocks for assistant messages, aligned with the NyxID
// assistant block model (frontend/src/types/assistant.ts in the NyxID repo).
// The LLM triggers a block by emitting a fenced code block whose info string
// is `nyxid:connect`; the body is a JSON payload. Everything else stays
// markdown text.

const CONNECT_FENCE = /^```\s*nyxid:connect\s*$/;
const ANY_FENCE_CLOSE = /^```\s*$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,80}$/;

export const CONNECT_CARD_STATES = new Set([
  "needs_connection",
  "waiting_for_provider",
  "waiting_for_user",
  "connected",
  "error",
  "timed_out",
]);

/**
 * Split raw assistant text into renderable segments:
 *   { kind: "text", text }                      → markdown
 *   { kind: "connect_card", key, slug, ... }    → rich card
 *   { kind: "pending_card" }                    → unfinished fence while streaming
 * With `allowPartial`, an unterminated nyxid fence at the end of the input is
 * held back as a pending segment instead of leaking half-written JSON.
 */
export function splitMessageSegments(source, { allowPartial = false } = {}) {
  const lines = String(source || "").split("\n");
  const segments = [];
  let textBuffer = [];
  let ordinal = 0;

  const flushText = () => {
    if (!textBuffer.length) return;
    const value = textBuffer.join("\n");
    if (value.trim()) segments.push({ kind: "text", text: value });
    textBuffer = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (CONNECT_FENCE.test(line.trim())) {
      let cursor = index + 1;
      const body = [];
      let closed = false;
      while (cursor < lines.length) {
        if (ANY_FENCE_CLOSE.test(lines[cursor].trim())) {
          closed = true;
          break;
        }
        body.push(lines[cursor]);
        cursor += 1;
      }
      if (!closed) {
        if (allowPartial) {
          flushText();
          segments.push({ kind: "pending_card" });
          return segments;
        }
        textBuffer.push(line, ...body);
        break;
      }
      flushText();
      segments.push(parseConnectSegment(body.join("\n"), ordinal));
      ordinal += 1;
      index = cursor + 1;
      continue;
    }
    textBuffer.push(line);
    index += 1;
  }
  flushText();
  return segments;
}

function parseConnectSegment(rawJson, ordinal) {
  let payload = null;
  try {
    payload = JSON.parse(rawJson);
  } catch {
    return { kind: "text", text: `\`\`\`\n${rawJson}\n\`\`\`` };
  }
  const slug = String(payload?.catalog_slug || payload?.slug || "").trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    return { kind: "text", text: `\`\`\`\n${rawJson}\n\`\`\`` };
  }
  return {
    kind: "connect_card",
    key: `connect:${slug}:${ordinal}`,
    slug,
    reason: String(payload.reason || "").replace(/\s+/g, " ").trim().slice(0, 300),
    requestedScopes: Array.isArray(payload.requested_scopes)
      ? payload.requested_scopes.map((scope) => String(scope).slice(0, 60)).slice(0, 12)
      : [],
  };
}

/**
 * Build a NyxID-shaped connect_card block from a parsed segment plus the
 * connectors snapshot served by `/api/nyxid/connectors`.
 */
export function buildConnectCardBlock(segment, connectors) {
  const available = (connectors?.available || []).find((service) => service.slug === segment.slug) || null;
  const connectedService = (connectors?.connected || []).find((service) => service.slug === segment.slug) || null;
  const info = connectedService || available;
  const isConnected = Boolean(connectedService && connectedService.status === "connected");
  const authKind = String(info?.authKind || "api_key");
  const serviceName = String(info?.name || segment.slug);
  return {
    type: "connect_card",
    block_id: segment.key,
    catalog_slug: segment.slug,
    service_name: serviceName,
    icon_url: String(info?.iconUrl || ""),
    subtitle: segment.reason || String(info?.description || "").slice(0, 140),
    auth_kind: authKind,
    requested_scopes: segment.requestedScopes || [],
    key_id: connectedService?.keyId || null,
    granted_scopes: null,
    device_user_code: null,
    device_verification_url: null,
    state: isConnected ? "connected" : "needs_connection",
    error_message: null,
    known: Boolean(info),
    api_key_url: String(available?.apiKeyUrl || ""),
    api_key_instructions: String(available?.apiKeyInstructions || ""),
    docs_url: String(available?.docsUrl || ""),
    steps: connectCardSteps(serviceName, authKind, isConnected),
    footer: "由 NyxID 托管凭证 · Agent 不接触原始密钥 · 可随时在 NyxID 撤销",
  };
}

export function connectCardSteps(serviceName, authKind, connected) {
  const authorizeBody = authKind === "api_key"
    ? "在下方粘贴 API key，或前往 NyxID 完成连接。密钥直接提交给 NyxID，不会出现在聊天记录里。"
    : authKind === "oauth"
      ? "跳转到 NyxID 完成 OAuth 授权，只授予所需的最小权限。"
      : authKind === "device_code"
        ? "跳转到 NyxID 完成设备码授权。"
        : "跳转到 NyxID 完成该服务的连接配置。";
  return [
    {
      title: `授权 NyxID 访问 ${serviceName}`,
      body: authorizeBody,
      done: connected,
    },
    {
      title: "NyxID 封存并代理凭证",
      body: "凭证加密保存在 NyxID vault；每次调用都经代理转发并限定范围。",
      done: connected,
    },
    {
      title: "自动继续任务",
      body: "连接完成后会自动重试你的原始请求，无需再问一遍。",
      done: false,
    },
  ];
}

export function connectorInitial(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.charAt(0) || "?";
  const second = words.length > 1 ? words[1]?.charAt(0) || "" : "";
  return `${first}${second}`.toUpperCase();
}
