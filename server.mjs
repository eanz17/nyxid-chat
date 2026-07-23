import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSseEvents, normalizeFrame } from "./public/protocol.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_ROOT = resolve(ROOT, "public");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "4310", 10);
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const ALLOWED_SURFACES = new Set(["workflow", "nyxid-chat"]);
const LOCAL_TOKEN_SESSION_COOKIE = "nyxid_chat_token_session";
const LOGIN_HANDOFF_TTL_MS = 10 * 60 * 1000;
const LOCAL_TOKEN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const loginHandoffs = new Map();
const localTokenSessions = new Map();
const STREAM_PROGRESS_TIMEOUT_MS = positiveInteger(
  process.env.DEMO_STREAM_PROGRESS_TIMEOUT_MS,
  120_000,
);

const defaults = {
  transport: "nyxid-session",
  surface: allowedValue(
    process.env.DEMO_DEFAULT_SURFACE,
    ALLOWED_SURFACES,
    "nyxid-chat",
  ),
  directBaseUrl: sanitizeBaseUrl(
    process.env.AEVATAR_BASE_URL || "https://aevatar-console-backend-api.aevatar.ai",
  ),
  proxyBaseUrl: sanitizeBaseUrl(
    process.env.NYXID_AEVATAR_PROXY_URL ||
      "https://nyx-api.chrono-ai.fun/api/v1/proxy/s/aevatar",
  ),
  nyxidBaseUrl: sanitizeBaseUrl(
    process.env.NYXID_BASE_URL || "https://nyx-api.chrono-ai.fun",
  ),
  nyxidWebUrl: sanitizeBaseUrl(
    process.env.NYXID_WEB_URL || "https://nyx.chrono-ai.fun",
  ),
  sessionCookieName: sanitizeCookieName(
    process.env.NYXID_SESSION_COOKIE_NAME || "nyx_session",
  ),
  llmServiceSlug: process.env.NYXID_LLM_SERVICE_SLUG || "chrono-llm-public",
  ornnServiceSlug: process.env.NYXID_ORNN_SERVICE_SLUG || "ornn-api",
  ornnWebUrl: sanitizeBaseUrl(process.env.ORNN_WEB_URL || "https://ornn.chrono-ai.fun"),
  workflow: "direct",
};

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  constructor(status, message, code = "DEMO_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function allowedValue(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizeBaseUrl(value) {
  const parsed = new URL(String(value).trim());
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error("Upstream URL must use http or https.");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function sanitizeCookieName(value) {
  const name = String(value || "").trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
    throw new Error("NYXID_SESSION_COOKIE_NAME is invalid.");
  }
  return name;
}

function bearerAuthorization(req) {
  const value = String(req.headers.authorization || "").trim();
  return /^Bearer [^\s,]+$/i.test(value) ? value : "";
}

function requestCookie(req, expectedName) {
  const header = String(req.headers.cookie || "");
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === expectedName && value) return value;
  }
  return "";
}

function responseCookie(name, value, { maxAge, secure = false } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function jwtExpiryMs(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return Number.isFinite(payload.exp) ? Number(payload.exp) * 1000 : null;
  } catch {
    return null;
  }
}

async function refreshLocalToken(sessionId, session) {
  const response = await fetch(`${defaults.nyxidBaseUrl}/api/v1/auth/refresh`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ refresh_token: session.refreshToken }),
    redirect: "manual",
  });
  const text = await response.text();
  const payload = parseJsonOutput(text);
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    localTokenSessions.delete(sessionId);
    return null;
  }
  if (!response.ok || !payload?.access_token || !payload?.refresh_token) {
    throw new HttpError(
      502,
      `Unable to refresh the local NyxID session: ${redactMessage(payload?.message || text)}`,
      "NYXID_TOKEN_REFRESH_FAILED",
    );
  }
  session.accessToken = String(payload.access_token);
  session.refreshToken = String(payload.refresh_token);
  session.accessTokenExpiresAt = Date.now() + Number(payload.expires_in || 900) * 1000;
  session.expiresAt = jwtExpiryMs(session.refreshToken) || Date.now() + LOCAL_TOKEN_SESSION_TTL_MS;
  return session.accessToken;
}

async function localSessionAuthorization(req) {
  const sessionId = requestCookie(req, LOCAL_TOKEN_SESSION_COOKIE);
  if (!sessionId) return null;
  const session = localTokenSessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    localTokenSessions.delete(sessionId);
    return null;
  }
  let accessToken = session.accessToken;
  if (session.accessTokenExpiresAt <= Date.now() + 60_000) {
    accessToken = await refreshLocalToken(sessionId, session);
  }
  return accessToken ? { authorization: `Bearer ${accessToken}`, localSessionId: sessionId } : null;
}

async function requestCredential(req) {
  const authorization = bearerAuthorization(req);
  if (authorization) return { authorization };
  const localSession = await localSessionAuthorization(req);
  if (localSession) return localSession;
  const siteSession = requestCookie(req, defaults.sessionCookieName);
  if (siteSession) return { cookie: `${defaults.sessionCookieName}=${siteSession}` };
  return null;
}

function credentialHeaders(credential, accept = "application/json") {
  // Identity and delegation headers belong to the NyxID proxy and are never accepted from clients.
  const headers = { Accept: accept };
  if (credential?.authorization) headers.Authorization = credential.authorization;
  if (credential?.cookie) headers.Cookie = credential.cookie;
  return headers;
}

async function sessionForCredential(credential) {
  const response = await fetch(`${defaults.nyxidBaseUrl}/api/v1/users/me`, {
    headers: credentialHeaders(credential),
    redirect: "manual",
  });
  if (response.status === 401 || response.status === 403) {
    if (credential.localSessionId) localTokenSessions.delete(credential.localSessionId);
    return null;
  }
  const text = await response.text();
  const profile = parseJsonOutput(text);
  if (!response.ok) {
    throw new HttpError(
      502,
      `Unable to validate the NyxID site session: ${redactMessage(profile?.message || text)}`,
      "NYXID_SESSION_CHECK_FAILED",
    );
  }
  if (!profile?.id) {
    throw new HttpError(502, "NyxID returned an invalid user profile.", "NYXID_PROFILE_INVALID");
  }
  return {
    credential,
    user: {
      id: String(profile.id),
      name: String(profile.display_name || profile.name || profile.email || "NyxID user"),
      email: String(profile.email || ""),
      picture: String(profile.avatar_url || profile.picture || ""),
    },
  };
}

async function requestSession(req) {
  const credential = await requestCredential(req);
  return credential ? await sessionForCredential(credential) : null;
}

async function requireSession(req) {
  const session = await requestSession(req);
  if (!session) {
    throw new HttpError(401, "Your NyxID site session is required.", "AUTH_REQUIRED");
  }
  return session;
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost;
  try {
    originHost = new URL(String(origin)).host;
  } catch {
    throw new HttpError(403, "Invalid request origin.", "ORIGIN_REJECTED");
  }
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",", 1)[0].trim();
  const requestHost = forwardedHost || req.headers.host;
  if (originHost !== requestHost) {
    throw new HttpError(403, "Cross-origin request rejected.", "ORIGIN_REJECTED");
  }
}

function proxyResourceForSlug(slug) {
  return `${defaults.nyxidBaseUrl}/api/v1/proxy/s/${encodeURIComponent(slug)}`;
}

function coreServiceResources() {
  return Array.from(new Set([
    defaults.proxyBaseUrl,
    proxyResourceForSlug(defaults.llmServiceSlug),
    proxyResourceForSlug(defaults.ornnServiceSlug),
  ]));
}

async function runtimeConfig(body, req) {
  const session = await requireSession(req);
  const surface = allowedValue(body.surface, ALLOWED_SURFACES, defaults.surface);

  return {
    transport: defaults.transport,
    surface,
    credential: session.credential,
    scopeId: session.user.id,
    workflow: String(body.workflow || defaults.workflow).trim() || "direct",
    directBaseUrl: defaults.directBaseUrl,
    proxyBaseUrl: defaults.proxyBaseUrl,
    session,
  };
}

function upstreamUrl(runtime, path) {
  const base = runtime.proxyBaseUrl;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function authHeaders(runtime, accept = "application/json") {
  return credentialHeaders(runtime.credential, accept);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new HttpError(413, "Request body is too large.", "PAYLOAD_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.", "INVALID_JSON");
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function startSse(res, extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...extraHeaders,
  });
  res.flushHeaders?.();
}

function writeSse(res, frame) {
  if (!res.destroyed && !res.writableEnded) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
}

function redactMessage(value) {
  return String(value || "Unknown error")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]")
    .replace(/nyx(?:id)?_[A-Za-z0-9_-]{8,}/gi, "nyx_[redacted]")
    .slice(0, 1200);
}

async function fetchRequest(runtime, path, { method = "GET", body, accept, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  const requestSignal = signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;
  try {
    const headers = authHeaders(runtime, accept || "application/json");
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return await fetch(upstreamUrl(runtime, path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: requestSignal,
      redirect: "manual",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(runtime, path, options = {}) {
  const response = await fetchRequest(runtime, path, options);
  const text = await response.text();
  return {
    status: response.status,
    text,
    data: parseJsonOutput(text),
  };
}

function resolveRuntimeScope(runtime) {
  if (!runtime.scopeId) {
    throw new HttpError(401, "NyxID session has no subject.", "AUTH_SUBJECT_MISSING");
  }
  return runtime;
}

async function nyxidApiRequest(session, path, { method = "GET", body } = {}) {
  const headers = credentialHeaders(session.credential);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${defaults.nyxidBaseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await response.text();
  const data = parseJsonOutput(text);
  if (!response.ok) {
    throw new HttpError(response.status, redactMessage(data?.message || text), "NYXID_API_FAILED");
  }
  return data;
}

async function listNyxidServices(session) {
  const payload = await nyxidApiRequest(session, "/api/v1/user-services");
  const coreResources = new Set(coreServiceResources());
  return (Array.isArray(payload?.services) ? payload.services : [])
    .map((service) => {
      const resourceUri = String(service.resource_uri || proxyResourceForSlug(service.slug || ""));
      const active = service.is_active !== false;
      const available = service.credential_source?.allowed !== false;
      return {
        id: String(service.id || ""),
        slug: String(service.slug || ""),
        label: String(service.label || service.catalog_service_name || service.slug || "Service"),
        resourceUri,
        active,
        available,
        authorized: active && available,
        core: coreResources.has(resourceUri),
        source: service.credential_source?.type || "personal",
        sourceName: service.credential_source?.org_name || "",
      };
    })
    .filter((service) => service.id && service.slug && service.resourceUri)
    .sort((left, right) =>
      Number(right.core) - Number(left.core) ||
      Number(right.authorized) - Number(left.authorized) ||
      left.label.localeCompare(right.label));
}

const CONNECTORS_CACHE_TTL_MS = 60_000;
const connectorsCache = new Map();

function catalogAuthKind(entry) {
  if (entry.service_type === "ssh") return "ssh";
  const providerType = String(entry.provider_type || "").toLowerCase();
  if (providerType === "oauth2") return "oauth";
  if (providerType === "device_code") return "device_code";
  if (entry.requires_credential === false) return "none";
  if (Array.isArray(entry.token_exchange_credential_fields) &&
      entry.token_exchange_credential_fields.length) {
    return "token_exchange";
  }
  if (entry.requires_gateway_url) return "self_hosted";
  return "api_key";
}

function deriveConnectors(keys, catalog) {
  const catalogBySlug = new Map(catalog.map((entry) => [entry.slug, entry]));
  const connectedGroups = new Map();
  const customKeys = [];
  for (const key of keys) {
    if (key.catalog_service_slug) {
      const group = connectedGroups.get(key.catalog_service_slug) || [];
      group.push(key);
      connectedGroups.set(key.catalog_service_slug, group);
    } else {
      customKeys.push(key);
    }
  }
  const connected = [];
  for (const [slug, group] of connectedGroups) {
    const entry = catalogBySlug.get(slug);
    const first = group[0];
    const active = group.some((key) => key.is_active !== false && key.status !== "error");
    connected.push({
      slug,
      name: String(entry?.name || first.catalog_service_name || first.label || slug),
      description: String(entry?.description || first.description || ""),
      iconUrl: String(entry?.icon_url || ""),
      authKind: entry ? catalogAuthKind(entry) : String(first.credential_type || "api_key"),
      connectionCount: group.length,
      keyId: group.length === 1 ? String(first.id || "") : "",
      status: active ? "connected" : "error",
    });
  }
  for (const key of customKeys) {
    connected.push({
      slug: String(key.slug || ""),
      name: String(key.label || key.slug || "Custom service"),
      description: String(key.description || ""),
      iconUrl: "",
      authKind: String(key.credential_type || "custom"),
      connectionCount: 1,
      keyId: String(key.id || ""),
      status: key.is_active !== false ? "connected" : "error",
      custom: true,
    });
  }
  connected.sort((left, right) => left.name.localeCompare(right.name));
  const available = catalog
    .filter((entry) => entry.slug && !connectedGroups.has(entry.slug))
    .map((entry) => ({
      slug: String(entry.slug),
      name: String(entry.name || entry.slug),
      description: String(entry.description || ""),
      iconUrl: String(entry.icon_url || ""),
      authKind: catalogAuthKind(entry),
      apiKeyUrl: String(entry.api_key_url || ""),
      apiKeyInstructions: String(entry.api_key_instructions || ""),
      docsUrl: String(entry.documentation_url || ""),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { connected, available };
}

async function fetchNyxidConnectors(session, { fresh = false } = {}) {
  const scopeId = session.user.id;
  const cached = connectorsCache.get(scopeId);
  if (!fresh && cached && Date.now() - cached.at < CONNECTORS_CACHE_TTL_MS) {
    return cached.payload;
  }
  const [keysPayload, catalogPayload] = await Promise.all([
    nyxidApiRequest(session, "/api/v1/keys"),
    nyxidApiRequest(session, "/api/v1/catalog"),
  ]);
  const keys = Array.isArray(keysPayload?.keys) ? keysPayload.keys : [];
  const catalog = Array.isArray(catalogPayload?.entries)
    ? catalogPayload.entries
    : Array.isArray(catalogPayload)
      ? catalogPayload
      : [];
  const payload = deriveConnectors(keys, catalog);
  connectorsCache.set(scopeId, { at: Date.now(), payload });
  return payload;
}

async function handleConnectors(req, res, requestUrl) {
  const session = await requireSession(req);
  const fresh = requestUrl.searchParams.get("fresh") === "1";
  json(res, 200, await fetchNyxidConnectors(session, { fresh }));
}

async function handleCreateKey(req, res, body) {
  const session = await requireSession(req);
  const serviceSlug = String(body.serviceSlug || body.service_slug || "").trim();
  const credential = String(body.credential || "");
  const label = String(body.label || "").trim().slice(0, 120);
  if (!serviceSlug || !/^[a-z0-9][a-z0-9-]{0,80}$/i.test(serviceSlug)) {
    throw new HttpError(400, "A valid catalog serviceSlug is required.", "KEY_REQUEST_INVALID");
  }
  if (!credential || credential.length > 8192) {
    throw new HttpError(400, "A credential value is required.", "KEY_REQUEST_INVALID");
  }
  const payload = await nyxidApiRequest(session, "/api/v1/keys", {
    method: "POST",
    body: {
      service_slug: serviceSlug,
      credential,
      label: label || serviceSlug,
    },
  });
  connectorsCache.delete(session.user.id);
  json(res, 200, {
    ok: true,
    key: {
      id: String(payload?.id || ""),
      slug: String(payload?.slug || serviceSlug),
      label: String(payload?.label || label || serviceSlug),
    },
  });
}

const NYXID_CONTEXT_OPEN = "[[NYXID_CONTEXT]]";
const NYXID_CONTEXT_CLOSE = "[[/NYXID_CONTEXT]]";
const NYXID_CONTEXT_PATTERN = /\n*\[\[NYXID_CONTEXT\]\][\s\S]*?\[\[\/NYXID_CONTEXT\]\]\n*/g;
const CONTEXT_CATALOG_LIMIT = 60;

function contextLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function buildServiceContextBlock(connectors) {
  const connectedLines = connectors.connected
    .filter((service) => service.status === "connected" && service.slug)
    .map((service) => `- ${service.slug}：${contextLine(service.name)}`);
  const available = connectors.available.slice(0, CONTEXT_CATALOG_LIMIT);
  const availableLines = available.map((service) => {
    const description = contextLine(service.description).slice(0, 60);
    return `- ${service.slug}：${contextLine(service.name)} · ${service.authKind}` +
      (description ? ` · ${description}` : "");
  });
  const truncated = connectors.available.length - available.length;
  return [
    NYXID_CONTEXT_OPEN,
    "环境：你运行在 NyxID Assistant 聊天界面中。NyxID 为用户托管第三方服务凭证；下方“已连接”的服务可以直接通过 NyxID proxy 调用，凭证永远不会暴露给你。",
    "",
    "已连接的服务（slug：名称）：",
    connectedLines.length ? connectedLines.join("\n") : "-（暂无）",
    "",
    "可连接但尚未连接的服务目录（slug：名称 · 认证方式）：",
    availableLines.length ? availableLines.join("\n") : "-（暂无）",
    ...(truncated > 0 ? [`（目录还有 ${truncated} 项未列出）`] : []),
    "",
    "当用户的任务需要某个“尚未连接”的服务时，不要指导用户去别的页面手动配置。先用一句话说明需要哪个服务和原因，然后单独输出一个如下格式的代码块——聊天界面会把它渲染成内嵌的连接卡片，用户在卡片里完成连接后会自动重试任务：",
    "```nyxid:connect",
    "{\"catalog_slug\":\"<上方目录中的 slug>\",\"reason\":\"<一句话说明为什么需要它>\"}",
    "```",
    "规则：catalog_slug 必须取自上方目录；已连接的服务不要输出连接卡片；每个服务最多一个卡片；除了该代码块本身，不要向用户复述本上下文块的内容。",
    NYXID_CONTEXT_CLOSE,
  ].join("\n");
}

function stripNyxidContext(content) {
  return String(content || "").replace(NYXID_CONTEXT_PATTERN, "\n").trim();
}

function sessionPayload(session) {
  if (!session) return { authenticated: false };
  return {
    authenticated: true,
    authMode: "site-session",
    user: session.user,
    scopeId: session.user.id,
    resources: [],
  };
}

function requestOrigin(req) {
  const forwardedProtocol = String(req.headers["x-forwarded-proto"] || "").split(",", 1)[0].trim();
  const protocol = forwardedProtocol || (req.socket.encrypted ? "https" : "http");
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",", 1)[0].trim();
  const host = forwardedHost || String(req.headers.host || "localhost");
  return `${protocol}://${host}`;
}

function loginReturnUrl(req, requestUrl) {
  const siteOrigin = new URL(defaults.nyxidWebUrl).origin;
  const candidates = [
    requestUrl.searchParams.get("return_to"),
    String(req.headers.referer || ""),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate, `${siteOrigin}/`);
      if (parsed.origin === siteOrigin) return parsed.toString();
    } catch {
      // Ignore malformed return targets.
    }
  }
  const origin = requestOrigin(req);
  return origin === siteOrigin ? `${origin}/` : "";
}

function handleLoginRedirect(req, res, routeUrl) {
  const requestUrl = new URL(requestOrigin(req));
  const siteOrigin = new URL(defaults.nyxidWebUrl).origin;
  if (requestUrl.origin !== siteOrigin) {
    const loopback = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])
      .has(requestUrl.hostname);
    const port = Number.parseInt(requestUrl.port, 10);
    if (!loopback || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new HttpError(
        409,
        "NyxID site sessions require same-origin deployment; token handoff is limited to localhost.",
        "SITE_SESSION_ORIGIN_REQUIRED",
      );
    }
    const state = randomBytes(32).toString("base64url");
    loginHandoffs.set(state, { createdAt: Date.now() });
    const handoffUrl = new URL("/cli-auth", defaults.nyxidWebUrl);
    handoffUrl.searchParams.set("port", String(port));
    handoffUrl.searchParams.set("state", state);
    handoffUrl.searchParams.set("client_ua", "nyxid-assistant");
    res.writeHead(302, { Location: handoffUrl.toString(), "Cache-Control": "no-store" });
    res.end();
    return;
  }

  const loginUrl = new URL("/login", defaults.nyxidWebUrl);
  const returnTo = loginReturnUrl(req, routeUrl);
  if (returnTo) loginUrl.searchParams.set("return_to", returnTo);
  res.writeHead(302, { Location: loginUrl.toString(), "Cache-Control": "no-store" });
  res.end();
}

async function handleTokenCallback(res, requestUrl) {
  const state = requestUrl.searchParams.get("state") || "";
  const handoff = loginHandoffs.get(state);
  loginHandoffs.delete(state);
  if (!handoff || Date.now() - handoff.createdAt > LOGIN_HANDOFF_TTL_MS) {
    throw new HttpError(400, "NyxID login handoff expired or is invalid.", "LOGIN_HANDOFF_INVALID");
  }

  const accessToken = requestUrl.searchParams.get("access_token") || "";
  const refreshToken = requestUrl.searchParams.get("refresh_token") || "";
  if (!accessToken || !refreshToken || accessToken.length > 16_384 || refreshToken.length > 16_384) {
    throw new HttpError(400, "NyxID login handoff did not return valid tokens.", "LOGIN_HANDOFF_INVALID");
  }

  const credential = { authorization: `Bearer ${accessToken}` };
  const verified = await sessionForCredential(credential);
  if (!verified) {
    throw new HttpError(401, "NyxID login handoff could not be verified.", "LOGIN_HANDOFF_INVALID");
  }

  const sessionId = randomBytes(32).toString("base64url");
  const expiresAt = jwtExpiryMs(refreshToken) || Date.now() + LOCAL_TOKEN_SESSION_TTL_MS;
  localTokenSessions.set(sessionId, {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: jwtExpiryMs(accessToken) || Date.now() + 15 * 60 * 1000,
    expiresAt,
  });
  res.writeHead(303, {
    Location: "/",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Set-Cookie": responseCookie(LOCAL_TOKEN_SESSION_COOKIE, sessionId, {
      maxAge: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
    }),
  });
  res.end();
}

async function handleLogout(req, res) {
  const localSessionId = requestCookie(req, LOCAL_TOKEN_SESSION_COOKIE);
  const session = await requestSession(req);
  if (!session) {
    if (localSessionId) {
      localTokenSessions.delete(localSessionId);
      res.setHeader("Set-Cookie", responseCookie(LOCAL_TOKEN_SESSION_COOKIE, "", { maxAge: 0 }));
    }
    json(res, 200, { ok: true });
    return;
  }
  const response = await fetch(`${defaults.nyxidBaseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: credentialHeaders(session.credential),
    redirect: "manual",
  });
  if (!response.ok && response.status !== 401) {
    const text = await response.text();
    throw new HttpError(
      502,
      `Unable to end the NyxID site session: ${redactMessage(text)}`,
      "NYXID_LOGOUT_FAILED",
    );
  }
  const setCookie = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  if (localSessionId) {
    localTokenSessions.delete(localSessionId);
    setCookie.push(responseCookie(LOCAL_TOKEN_SESSION_COOKIE, "", { maxAge: 0 }));
  }
  if (setCookie.length) res.setHeader("Set-Cookie", setCookie);
  json(res, 200, { ok: true });
}

function assertUpstreamSuccess(result, code) {
  if (result.status < 200 || result.status >= 300) {
    throw new HttpError(result.status, redactMessage(result.text), code);
  }
  return result;
}

async function handleConversationIndex(req, res, query) {
  const runtime = resolveRuntimeScope(await runtimeConfig({
    ...query,
    surface: "nyxid-chat",
  }, req));
  const path = `/api/scopes/${encodeURIComponent(runtime.scopeId)}/chat-history`;
  const result = assertUpstreamSuccess(
    await requestJson(runtime, path),
    "CHAT_HISTORY_LIST_FAILED",
  );
  json(res, 200, result.data || { conversations: [] });
}

async function handleConversationDetail(req, res, query, actorId) {
  const runtime = resolveRuntimeScope(await runtimeConfig({
    ...query,
    surface: "nyxid-chat",
  }, req));
  const path = `/api/scopes/${encodeURIComponent(runtime.scopeId)}` +
    `/chat-history/conversations/${encodeURIComponent(actorId)}`;
  const result = assertUpstreamSuccess(
    await requestJson(runtime, path),
    "CHAT_HISTORY_READ_FAILED",
  );
  const messages = (Array.isArray(result.data) ? result.data : []).map((message) =>
    message && typeof message === "object" && message.role === "user"
      ? { ...message, content: stripNyxidContext(message.content) }
      : message);
  json(res, 200, messages);
}

async function handleConversationDelete(req, res, query, actorId) {
  const runtime = resolveRuntimeScope(await runtimeConfig({
    ...query,
    surface: "nyxid-chat",
  }, req));
  const scope = encodeURIComponent(runtime.scopeId);
  const actor = encodeURIComponent(actorId);
  const actorPath = `/api/scopes/${scope}/nyxid-chat/conversations/${actor}`;
  const historyPath = `/api/scopes/${scope}/chat-history/conversations/${actor}`;

  const failures = [];
  for (const [path, code] of [
    [actorPath, "CONVERSATION_DELETE_FAILED"],
    [historyPath, "CHAT_HISTORY_DELETE_FAILED"],
  ]) {
    try {
      const result = await requestJson(runtime, path, { method: "DELETE" });
      if (result.status !== 404) assertUpstreamSuccess(result, code);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new HttpError(
      failures[0].status || 502,
      failures.map((error) => redactMessage(error.message)).join("; "),
      failures[0].code || "CONVERSATION_DELETE_FAILED",
    );
  }
  json(res, 200, { ok: true, actorId });
}

function parseJsonOutput(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function isKeepaliveEvent(event) {
  if (/keepalive|heartbeat|ping/i.test(String(event?.event || ""))) return true;
  if (!event?.data || event.data === "[DONE]") return false;
  try {
    const normalized = normalizeFrame(JSON.parse(event.data));
    return normalized.type === "keepalive" ||
      /keepalive|heartbeat/i.test(String(normalized.name || ""));
  } catch {
    return false;
  }
}

async function pipeFetchStream(req, res, runtime, path, options, prefixFrames = []) {
  const controller = new AbortController();
  const abortUpstream = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  req.once("aborted", abortUpstream);
  res.once("close", abortUpstream);

  let progressTimer = null;
  let progressTimedOut = false;
  try {
    const upstream = await fetchRequest(runtime, path, {
      ...options,
      accept: "text/event-stream",
      signal: controller.signal,
    });
    const correlationId = upstream.headers.get("x-correlation-id");
    if (!upstream.ok) {
      const text = await upstream.text();
      res.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(text);
      return;
    }

    startSse(res, correlationId ? { "X-Correlation-Id": correlationId } : {});
    prefixFrames.forEach((frame) => writeSse(res, frame));
    if (!upstream.body) {
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    let eventBuffer = "";
    const resetProgressTimer = () => {
      clearTimeout(progressTimer);
      progressTimer = setTimeout(() => {
        progressTimedOut = true;
        writeSse(res, {
          type: "RUN_ERROR",
          runError: {
            code: "UPSTREAM_PROGRESS_TIMEOUT",
            message: `上游 Agent 连续 ${Math.ceil(STREAM_PROGRESS_TIMEOUT_MS / 1000)} 秒没有返回有效进度，已停止等待。`,
            ...(correlationId ? { correlationId } : {}),
          },
        });
        if (!res.writableEnded) res.end();
        abortUpstream();
      }, STREAM_PROGRESS_TIMEOUT_MS);
      progressTimer.unref?.();
    };
    resetProgressTimer();

    try {
      for await (const chunk of upstream.body) {
        if (res.destroyed || controller.signal.aborted) break;
        eventBuffer += decoder.decode(chunk, { stream: true });
        const parsed = extractSseEvents(eventBuffer, false);
        eventBuffer = parsed.rest;
        if (parsed.events.some((event) => !isKeepaliveEvent(event))) {
          resetProgressTimer();
        }
        res.write(chunk);
      }
    } catch (error) {
      if (!progressTimedOut && !controller.signal.aborted && !res.destroyed) {
        writeSse(res, {
          type: "RUN_ERROR",
          runError: { message: redactMessage(error.message) },
        });
      }
    }
  } finally {
    clearTimeout(progressTimer);
    req.off("aborted", abortUpstream);
    res.off("close", abortUpstream);
    abortUpstream();
    if (!res.writableEnded && !res.destroyed) res.end();
  }
}

async function forwardStream(req, res, runtime, path, options, prefixFrames = []) {
  await pipeFetchStream(req, res, runtime, path, options, prefixFrames);
}

function mapAttachment(attachment, surface) {
  if (!attachment?.dataBase64 || !attachment?.name) return [];
  const mediaType = String(attachment.mediaType || "application/octet-stream");
  const type = mediaType.startsWith("image/")
    ? "image"
    : mediaType.startsWith("audio/")
      ? "audio"
      : mediaType.startsWith("video/")
        ? "video"
        : "file";
  if (surface === "nyxid-chat") {
    return [{
      type,
      dataBase64: attachment.dataBase64,
      mediaType,
      name: attachment.name,
    }];
  }
  return [{
    type,
    inlineFile: {
      dataBase64: attachment.dataBase64,
      mediaType,
      name: attachment.name,
      sizeBytes: attachment.sizeBytes,
    },
  }];
}

async function createNyxIdConversation(runtime) {
  if (!runtime.scopeId) {
    throw new HttpError(400, "Scope ID is required for NyxID Chat.", "SCOPE_REQUIRED");
  }
  const path = `/api/scopes/${encodeURIComponent(runtime.scopeId)}/nyxid-chat/conversations`;
  const result = await requestJson(runtime, path, { method: "POST", body: {} });
  if (result.status < 200 || result.status >= 300) {
    throw new HttpError(result.status, redactMessage(result.text), "CONVERSATION_CREATE_FAILED");
  }
  const actorId = result.data?.actorId || result.data?.ActorId;
  if (!actorId) {
    throw new HttpError(502, "Aevatar did not return a conversation actorId.", "ACTOR_ID_MISSING");
  }
  await waitForConversation(runtime, actorId);
  return actorId;
}

async function waitForConversation(runtime, actorId) {
  const path = `/api/scopes/${encodeURIComponent(runtime.scopeId)}/nyxid-chat/conversations`;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const result = await requestJson(runtime, path);
    const conversations = result.data?.conversations || result.data?.Conversations || [];
    if (conversations.some((item) => (item.actorId || item.ActorId) === actorId)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250 + attempt * 100));
  }
}

async function handleChat(req, res, body) {
  const runtime = resolveRuntimeScope(await runtimeConfig(body, req));
  const prompt = String(body.prompt || "").trim();
  const inputParts = mapAttachment(body.attachment, runtime.surface);
  if (!prompt && inputParts.length === 0) {
    throw new HttpError(400, "Prompt or attachment is required.", "PROMPT_REQUIRED");
  }
  const sessionId = String(body.sessionId || randomUUID());

  if (runtime.surface === "workflow") {
    const chatBody = {
      prompt,
      workflow: runtime.workflow,
      sessionId,
      ...(inputParts.length ? { inputParts } : {}),
    };
    await forwardStream(req, res, runtime, "/api/chat", {
      method: "POST",
      body: chatBody,
    });
    return;
  }

  const actorId = String(body.actorId || "").trim() || await createNyxIdConversation(runtime);
  let outboundPrompt = prompt;
  if (prompt) {
    try {
      const connectors = await fetchNyxidConnectors(runtime.session);
      outboundPrompt = `${prompt}\n\n${buildServiceContextBlock(connectors)}`;
    } catch {
      // The service catalog is best-effort context; chat proceeds without it.
    }
  }
  const path = `/api/scopes/${encodeURIComponent(runtime.scopeId)}` +
    `/nyxid-chat/conversations/${encodeURIComponent(actorId)}:stream`;
  await forwardStream(
    req,
    res,
    runtime,
    path,
    {
      method: "POST",
      body: {
        prompt: outboundPrompt,
        sessionId,
        ...(inputParts.length ? { inputParts } : {}),
      },
    },
    [{
      type: "CUSTOM",
      custom: {
        name: "demo.conversation.context",
        payload: { actorId, scopeId: runtime.scopeId, sessionId },
      },
    }],
  );
}

async function handleApproval(req, res, body) {
  const runtime = resolveRuntimeScope(await runtimeConfig(body, req));
  const approved = body.approved !== false;
  const sessionId = String(body.sessionId || "");

  if (runtime.surface === "nyxid-chat") {
    const actorId = String(body.actorId || "").trim();
    const requestId = String(body.requestId || "").trim();
    if (!runtime.scopeId || !actorId || !requestId) {
      throw new HttpError(
        400,
        "scopeId, actorId and requestId are required for NyxID Chat approval.",
        "APPROVAL_CONTEXT_REQUIRED",
      );
    }
    const path = `/api/scopes/${encodeURIComponent(runtime.scopeId)}` +
      `/nyxid-chat/conversations/${encodeURIComponent(actorId)}:approve`;
    await forwardStream(req, res, runtime, path, {
      method: "POST",
      body: {
        requestId,
        approved,
        reason: body.reason || (approved ? "Approved in integration demo" : "Denied in integration demo"),
        sessionId,
      },
    });
    return;
  }

  const actorId = String(body.actorId || "").trim();
  const runId = String(body.runId || "").trim();
  const stepId = String(body.stepId || "").trim();
  const commandId = String(body.commandId || "").trim();
  if (!runtime.scopeId || !actorId || !runId || !stepId || !commandId) {
    throw new HttpError(
      400,
      "scopeId, actorId, runId, stepId and commandId are required for Workflow approval.",
      "WORKFLOW_RESUME_CONTEXT_REQUIRED",
    );
  }
  const path = `/api/scopes/${encodeURIComponent(runtime.scopeId)}` +
    `/runs/${encodeURIComponent(runId)}:resume`;
  const result = await requestJson(runtime, path, {
    method: "POST",
    body: {
      actorId,
      stepId,
      commandId,
      approved,
      userInput: body.reason || null,
      toolApproval: body.toolApproval || null,
    },
  });
  if (result.status < 200 || result.status >= 300) {
    throw new HttpError(result.status, redactMessage(result.text), "WORKFLOW_RESUME_FAILED");
  }
  json(res, result.status, result.data || { accepted: true });
}

async function handleHealth(req, res, body) {
  const runtime = resolveRuntimeScope(await runtimeConfig(body, req));
  const startedAt = Date.now();
  const checkService = async (serviceRuntime, path, successDetail) => {
    const componentStartedAt = Date.now();
    try {
      const response = await fetchRequest(serviceRuntime, path);
      await response.arrayBuffer();
      return {
        ok: response.ok,
        status: response.ok ? "reachable" : `http-${response.status}`,
        latencyMs: Date.now() - componentStartedAt,
        detail: response.ok ? successDetail : `Upstream returned HTTP ${response.status}.`,
      };
    } catch (error) {
      return {
        ok: false,
        status: "unreachable",
        latencyMs: Date.now() - componentStartedAt,
        detail: redactMessage(error.message),
      };
    }
  };
  const ornnResource = proxyResourceForSlug(defaults.ornnServiceSlug);
  const aevatarPromise = checkService(
    runtime,
    "/api/capabilities",
    "Aevatar responded through the NyxID site session.",
  );
  const ornnPromise = checkService(
    { ...runtime, proxyBaseUrl: ornnResource },
    "/api/v1/skill-search?query=aevatar&mode=keyword&scope=mixed&page=1&pageSize=1",
    "Ornn skill search responded through the NyxID site session.",
  );
  const [aevatar, ornn] = await Promise.all([aevatarPromise, ornnPromise]);
  const ok = aevatar.ok && ornn.ok;
  const detail = [
    `Aevatar: ${aevatar.detail}`,
    `Ornn: ${ornn.detail}`,
  ].join(" ");
  json(res, ok ? 200 : 502, {
    ok,
    status: ok ? "reachable" : "degraded",
    latencyMs: Date.now() - startedAt,
    detail,
    components: { aevatar, ornn },
  });
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolve(PUBLIC_ROOT, normalize(relative));
  if (!filePath.startsWith(`${PUBLIC_ROOT}/`) && filePath !== join(PUBLIC_ROOT, "index.html")) {
    throw new HttpError(404, "Not found.", "NOT_FOUND");
  }
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new HttpError(404, "Not found.", "NOT_FOUND");
  }
  if (!info.isFile()) throw new HttpError(404, "Not found.", "NOT_FOUND");
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": "no-store",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self' https://unpkg.com",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const query = Object.fromEntries(requestUrl.searchParams.entries());
  const conversationMatch = requestUrl.pathname.match(/^\/api\/demo\/conversations\/([^/]+)$/);
  try {
    if (!new Set(["GET", "HEAD", "OPTIONS"]).has(req.method || "GET")) {
      assertSameOrigin(req);
    }
    if (req.method === "GET" && requestUrl.pathname === "/callback") {
      await handleTokenCallback(res, requestUrl);
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/api/auth/login") {
      handleLoginRedirect(req, res, requestUrl);
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/api/auth/authorize") {
      throw new HttpError(
        410,
        "Developer-app consent is not used by the NyxID site integration.",
        "DEVELOPER_APP_AUTH_REMOVED",
      );
    }
    if (req.method === "GET" && requestUrl.pathname === "/api/auth/session") {
      json(res, 200, sessionPayload(await requestSession(req)));
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/api/auth/services") {
      const session = await requireSession(req);
      json(res, 200, { services: await listNyxidServices(session) });
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/api/nyxid/connectors") {
      await handleConnectors(req, res, requestUrl);
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/api/nyxid/keys") {
      await handleCreateKey(req, res, await readJson(req));
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/api/auth/logout") {
      await handleLogout(req, res);
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/api/demo/config") {
      const session = await requestSession(req);
      json(res, 200, {
        transport: defaults.transport,
        surface: defaults.surface,
        workflow: defaults.workflow,
        directBaseUrl: defaults.directBaseUrl,
        proxyBaseUrl: defaults.proxyBaseUrl,
        ornnWebUrl: defaults.ornnWebUrl,
        nyxidWebUrl: defaults.nyxidWebUrl,
        servicesUrl: new URL("/keys", defaults.nyxidWebUrl).toString(),
        scopeId: session?.user?.id || "",
        environment: "production",
        transportLocked: true,
        authMode: "site-session",
      });
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/api/demo/health") {
      await handleHealth(req, res, await readJson(req));
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/api/demo/chat") {
      await handleChat(req, res, await readJson(req));
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/api/demo/approve") {
      await handleApproval(req, res, await readJson(req));
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/api/demo/conversations") {
      await handleConversationIndex(req, res, query);
      return;
    }
    if (req.method === "GET" && conversationMatch) {
      await handleConversationDetail(req, res, query, decodeURIComponent(conversationMatch[1]));
      return;
    }
    if (req.method === "DELETE" && conversationMatch) {
      await handleConversationDelete(req, res, query, decodeURIComponent(conversationMatch[1]));
      return;
    }
    if (req.method === "GET") {
      await serveStatic(req, res, requestUrl.pathname);
      return;
    }
    throw new HttpError(404, "Not found.", "NOT_FOUND");
  } catch (error) {
    if (res.headersSent) {
      writeSse(res, {
        type: "RUN_ERROR",
        runError: { message: redactMessage(error.message) },
      });
      res.end();
      return;
    }
    const status = error instanceof HttpError ? error.status : 500;
    json(res, status, {
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
      message: redactMessage(error.message),
    });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`NyxID Assistant (site session): http://${HOST}:${PORT}\n`);
});

setInterval(() => {
  const now = Date.now();
  for (const [state, handoff] of loginHandoffs) {
    if (now - handoff.createdAt > LOGIN_HANDOFF_TTL_MS) loginHandoffs.delete(state);
  }
  for (const [sessionId, session] of localTokenSessions) {
    if (session.expiresAt <= now) localTokenSessions.delete(sessionId);
  }
}, 60_000).unref();

function shutdown() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
