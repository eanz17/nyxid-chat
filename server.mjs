import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_ROOT = resolve(ROOT, "public");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "4310", 10);
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const ALLOWED_SURFACES = new Set(["workflow", "nyxid-chat"]);
const SESSION_COOKIE = "nyxid_chat_session";
const OAUTH_STATE_COOKIE = "nyxid_chat_oauth_state";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const BROKER_SUBJECT_TOKEN_TYPE = "urn:nyxid:params:oauth:token-type:binding-id";
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const sessions = new Map();
const oauthStates = new Map();
let jwksCache = null;
const OAUTH_CLIENT_ID = String(process.env.NYXID_OAUTH_CLIENT_ID || "").trim();

if (!OAUTH_CLIENT_ID) {
  throw new Error("NYXID_OAUTH_CLIENT_ID is required.");
}

const defaults = {
  transport: "nyxid-oauth",
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
  oauthClientId: OAUTH_CLIENT_ID,
  oauthRedirectUri:
    process.env.NYXID_OAUTH_REDIRECT_URI || `http://127.0.0.1:${PORT}/auth/callback`,
  oauthScopes:
    process.env.NYXID_OAUTH_SCOPES ||
    "openid profile email proxy",
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

function parseCookies(req) {
  const header = String(req.headers.cookie || "");
  return Object.fromEntries(header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return [];
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    return key ? [[key, decodeURIComponent(value)]] : [];
  }));
}

function cookieValue(name, value, { maxAge, secure = false } = {}) {
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

function setCookies(res, values) {
  res.setHeader("Set-Cookie", values);
}

function requestSession(req) {
  const sessionId = parseCookies(req)[SESSION_COOKIE];
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function requireSession(req) {
  const session = requestSession(req);
  if (!session) {
    throw new HttpError(401, "Sign in with NyxID to continue.", "AUTH_REQUIRED");
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
  if (originHost !== req.headers.host) {
    throw new HttpError(403, "Cross-origin request rejected.", "ORIGIN_REJECTED");
  }
}

function oauthResourceForSlug(slug) {
  return `${defaults.nyxidBaseUrl}/api/v1/proxy/s/${encodeURIComponent(slug)}`;
}

function requiredOAuthResources() {
  return Array.from(new Set([
    defaults.proxyBaseUrl,
    oauthResourceForSlug(defaults.llmServiceSlug),
    oauthResourceForSlug(defaults.ornnServiceSlug),
  ]));
}

async function runtimeConfig(body, req) {
  const session = requireSession(req);
  const surface = allowedValue(body.surface, ALLOWED_SURFACES, defaults.surface);

  return {
    transport: defaults.transport,
    surface,
    token: await accessTokenForSession(session),
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
  const headers = { Accept: accept };
  if (runtime.token) headers.Authorization = `Bearer ${runtime.token}`;
  return headers;
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
    .replace(/nyx(?:id)?_[A-Za-z0-9_-]{8,}/gi, "nyx_[redacted]")
    .slice(0, 1200);
}

async function fetchRequest(runtime, path, { method = "GET", body, accept } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const headers = authHeaders(runtime, accept || "application/json");
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return await fetch(upstreamUrl(runtime, path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
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

function randomToken(size = 32) {
  return randomBytes(size).toString("base64url");
}

function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function oauthForm(entries, resources = []) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== null && value !== "") form.set(key, String(value));
  }
  resources.forEach((resource) => form.append("resource", resource));
  return form;
}

async function oauthTokenRequest(entries, resources = []) {
  const response = await fetch(`${defaults.nyxidBaseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: oauthForm(entries, resources),
    redirect: "manual",
  });
  const text = await response.text();
  const payload = parseJsonOutput(text);
  if (!response.ok || !payload?.access_token) {
    const message = payload?.error_description || payload?.message || payload?.error || text;
    throw new HttpError(
      response.status === 400 ? 401 : 502,
      `NyxID token exchange failed: ${redactMessage(message)}`,
      "OAUTH_TOKEN_EXCHANGE_FAILED",
    );
  }
  return payload;
}

function decodeJwtPart(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(401, "NyxID returned an invalid token.", "OAUTH_TOKEN_INVALID");
  }
}

function decodeJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    throw new HttpError(401, "NyxID returned an invalid token.", "OAUTH_TOKEN_INVALID");
  }
  return {
    header: decodeJwtPart(parts[0]),
    payload: decodeJwtPart(parts[1]),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], "base64url"),
  };
}

async function getJwks(forceRefresh = false) {
  if (!forceRefresh && jwksCache?.expiresAt > Date.now()) return jwksCache.value;
  const response = await fetch(`${defaults.nyxidBaseUrl}/.well-known/jwks.json`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new HttpError(502, "Unable to verify the NyxID login response.", "OAUTH_JWKS_FAILED");
  }
  const value = await response.json();
  jwksCache = { value, expiresAt: Date.now() + 60 * 60 * 1000 };
  return value;
}

async function verifyIdToken(token, expectedNonce) {
  const decoded = decodeJwt(token);
  if (decoded.header.alg !== "RS256" || !decoded.header.kid) {
    throw new HttpError(401, "NyxID ID token uses an unsupported signature.", "OAUTH_ID_TOKEN_INVALID");
  }
  let jwks = await getJwks();
  let jwk = jwks.keys?.find((candidate) => candidate.kid === decoded.header.kid);
  if (!jwk) {
    jwks = await getJwks(true);
    jwk = jwks.keys?.find((candidate) => candidate.kid === decoded.header.kid);
    if (!jwk) {
      throw new HttpError(401, "NyxID ID token signing key was not found.", "OAUTH_ID_TOKEN_INVALID");
    }
  }
  const valid = verify(
    "RSA-SHA256",
    Buffer.from(decoded.signingInput),
    createPublicKey({ key: jwk, format: "jwk" }),
    decoded.signature,
  );
  const audience = Array.isArray(decoded.payload.aud)
    ? decoded.payload.aud
    : [decoded.payload.aud];
  const now = Math.floor(Date.now() / 1000);
  if (!valid || decoded.payload.iss !== defaults.nyxidBaseUrl ||
      !audience.includes(defaults.oauthClientId) || decoded.payload.exp <= now - 30 ||
      decoded.payload.iat > now + 60 || decoded.payload.nonce !== expectedNonce) {
    throw new HttpError(401, "NyxID ID token validation failed.", "OAUTH_ID_TOKEN_INVALID");
  }
  return decoded.payload;
}

async function fetchUserInfo(accessToken) {
  const response = await fetch(`${defaults.nyxidBaseUrl}/oauth/userinfo`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.sub) {
    throw new HttpError(401, "Unable to read the authorized NyxID account.", "OAUTH_USERINFO_FAILED");
  }
  return payload;
}

async function fetchClientConsentResources(accessToken) {
  const authHeaders = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  const consentResponse = await fetch(`${defaults.nyxidBaseUrl}/api/v1/users/me/consents`, {
    headers: authHeaders,
  });
  if (!consentResponse.ok) return [];
  const consentPayload = await consentResponse.json().catch(() => null);
  const consents = Array.isArray(consentPayload?.consents)
    ? consentPayload.consents
    : Array.isArray(consentPayload)
      ? consentPayload
      : [];
  const consent = consents.find((item) => item.client_id === defaults.oauthClientId);
  if (!consent) return [];
  if (consent.allow_all_services || consent.legacy_unrestricted) {
    const servicesResponse = await fetch(`${defaults.nyxidBaseUrl}/api/v1/user-services`, {
      headers: authHeaders,
    });
    if (!servicesResponse.ok) return [];
    const servicesPayload = await servicesResponse.json().catch(() => null);
    return (servicesPayload?.services || [])
      .filter((service) => service.is_active !== false && service.credential_source?.allowed !== false)
      .map((service) => service.resource_uri || oauthResourceForSlug(service.slug))
      .filter(Boolean);
  }
  return (Array.isArray(consent.allowed_services) ? consent.allowed_services : [])
    .filter((service) => !service.deleted && service.slug)
    .map((service) => oauthResourceForSlug(service.slug));
}

async function accessTokenForSession(session) {
  if (session.accessToken && session.accessTokenExpiresAt > Date.now() + 60_000) {
    return session.accessToken;
  }
  const tokens = await oauthTokenRequest({
    grant_type: TOKEN_EXCHANGE_GRANT,
    client_id: defaults.oauthClientId,
    subject_token: session.bindingId,
    subject_token_type: BROKER_SUBJECT_TOKEN_TYPE,
    scope: "openid profile email proxy",
  });
  session.accessToken = tokens.access_token;
  session.accessTokenExpiresAt = Date.now() + Number(tokens.expires_in || 300) * 1000;
  return session.accessToken;
}

async function nyxidApiRequest(session, path) {
  const token = await accessTokenForSession(session);
  const response = await fetch(`${defaults.nyxidBaseUrl}${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
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
  const authorized = new Set(session.resources || []);
  const coreResources = new Set(requiredOAuthResources());
  return (Array.isArray(payload?.services) ? payload.services : [])
    .map((service) => {
      const resourceUri = String(service.resource_uri || oauthResourceForSlug(service.slug || ""));
      return {
        id: String(service.id || ""),
        slug: String(service.slug || ""),
        label: String(service.label || service.catalog_service_name || service.slug || "Service"),
        resourceUri,
        active: service.is_active !== false,
        available: service.credential_source?.allowed !== false,
        authorized: authorized.has(resourceUri),
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

function sessionPayload(session) {
  if (!session) return { authenticated: false };
  return {
    authenticated: true,
    user: session.user,
    scopeId: session.user.id,
    resources: session.resources,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

async function beginAuthorization(req, res, requestedServiceIds = []) {
  const session = requestedServiceIds.length ? requireSession(req) : requestSession(req);
  const resources = new Set(
    session?.consentResources?.length
      ? session.consentResources
      : session?.resources || [],
  );
  requiredOAuthResources().forEach((resource) => resources.add(resource));

  if (requestedServiceIds.length) {
    const services = await listNyxidServices(session);
    const requested = new Set(requestedServiceIds);
    const matches = services.filter((service) => requested.has(service.id));
    if (matches.length !== requested.size) {
      throw new HttpError(400, "One or more NyxID services are unavailable.", "SERVICE_NOT_FOUND");
    }
    for (const service of matches) {
      if (!service.active || !service.available) {
        throw new HttpError(403, `${service.label} is not available to this account.`, "SERVICE_UNAVAILABLE");
      }
      resources.add(service.resourceUri);
    }
  }

  const state = randomToken();
  const verifier = randomToken(48);
  const nonce = randomToken();
  const record = {
    createdAt: Date.now(),
    verifier,
    nonce,
    resources: Array.from(resources),
    sessionId: session?.id || null,
    incremental: requestedServiceIds.length > 0,
  };
  oauthStates.set(state, record);

  const authorizeUrl = new URL("/oauth/authorize", defaults.nyxidBaseUrl);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", defaults.oauthClientId);
  authorizeUrl.searchParams.set("redirect_uri", defaults.oauthRedirectUri);
  authorizeUrl.searchParams.set("scope", defaults.oauthScopes);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("nonce", nonce);
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  if (record.incremental) authorizeUrl.searchParams.set("prompt", "consent");
  record.resources.forEach((resource) => authorizeUrl.searchParams.append("resource", resource));

  const secure = new URL(defaults.oauthRedirectUri).protocol === "https:";
  setCookies(res, [cookieValue(OAUTH_STATE_COOKIE, state, {
    maxAge: OAUTH_STATE_TTL_MS / 1000,
    secure,
  })]);
  res.writeHead(302, { Location: authorizeUrl.toString(), "Cache-Control": "no-store" });
  res.end();
}

async function revokeBinding(bindingId) {
  if (!bindingId) return;
  await fetch(`${defaults.nyxidBaseUrl}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: oauthForm({
      token: bindingId,
      token_type_hint: BROKER_SUBJECT_TOKEN_TYPE,
      client_id: defaults.oauthClientId,
    }),
  });
}

function callbackHtml(status, message) {
  const nonce = randomToken(18);
  const payload = JSON.stringify({ type: "nyxid-oauth", status, message })
    .replaceAll("<", "\\u003c");
  return {
    nonce,
    body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>NyxID authorization</title></head><body><p>${status === "success" ? "授权完成，可以关闭此窗口。" : "授权未完成，请返回 NyxID Chat。"}</p><script nonce="${nonce}">const result=${payload};if(window.opener){window.opener.postMessage(result,window.location.origin);window.close()}else{setTimeout(()=>location.replace('/'),400)}</script></body></html>`,
  };
}

function sendCallbackPage(res, status, message, cookies = []) {
  const page = callbackHtml(status, message);
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(page.body),
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${page.nonce}'; style-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    "X-Content-Type-Options": "nosniff",
  };
  if (cookies.length) headers["Set-Cookie"] = cookies;
  res.writeHead(status === "success" ? 200 : 400, headers);
  res.end(page.body);
}

async function handleOAuthCallback(req, res, requestUrl) {
  const returnedState = requestUrl.searchParams.get("state") || "";
  const stateCookie = parseCookies(req)[OAUTH_STATE_COOKIE] || "";
  const record = oauthStates.get(returnedState);
  oauthStates.delete(returnedState);
  const secure = new URL(defaults.oauthRedirectUri).protocol === "https:";
  const clearStateCookie = cookieValue(OAUTH_STATE_COOKIE, "", { maxAge: 0, secure });

  if (!record || returnedState !== stateCookie || Date.now() - record.createdAt > OAUTH_STATE_TTL_MS) {
    sendCallbackPage(res, "error", "OAuth state validation failed.", [clearStateCookie]);
    return;
  }
  if (requestUrl.searchParams.get("error")) {
    const detail = requestUrl.searchParams.get("error_description") || requestUrl.searchParams.get("error");
    sendCallbackPage(res, "error", redactMessage(detail), [clearStateCookie]);
    return;
  }
  const code = requestUrl.searchParams.get("code");
  if (!code) {
    sendCallbackPage(res, "error", "NyxID did not return an authorization code.", [clearStateCookie]);
    return;
  }

  let issuedBindingId = "";
  try {
    const tokens = await oauthTokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: defaults.oauthClientId,
      redirect_uri: defaults.oauthRedirectUri,
      code_verifier: record.verifier,
    });
    if (!tokens.id_token || !tokens.binding_id) {
      throw new HttpError(502, "NyxID did not return the required broker binding.", "OAUTH_BINDING_MISSING");
    }
    issuedBindingId = tokens.binding_id;
    const idClaims = await verifyIdToken(tokens.id_token, record.nonce);
    const userInfo = await fetchUserInfo(tokens.access_token);
    if (idClaims.sub !== userInfo.sub) {
      throw new HttpError(401, "NyxID subject validation failed.", "OAUTH_SUBJECT_MISMATCH");
    }
    const accessClaims = decodeJwt(tokens.access_token).payload;
    const grantedResources = Array.isArray(tokens.resource)
      ? tokens.resource
      : Array.isArray(accessClaims.resources)
        ? accessClaims.resources
        : [];
    const consentResources = await fetchClientConsentResources(tokens.access_token)
      .catch(() => []);
    const requestCookieSessionId = parseCookies(req)[SESSION_COOKIE];
    const previous = record.sessionId && record.sessionId === requestCookieSessionId
      ? sessions.get(record.sessionId)
      : null;
    const sessionId = previous?.id || randomToken();
    const session = {
      id: sessionId,
      user: {
        id: String(userInfo.sub),
        name: String(userInfo.name || userInfo.email || "NyxID user"),
        email: String(userInfo.email || ""),
        picture: String(userInfo.picture || ""),
      },
      bindingId: tokens.binding_id,
      accessToken: tokens.access_token,
      accessTokenExpiresAt: Date.now() + Number(tokens.expires_in || 300) * 1000,
      resources: Array.from(new Set(grantedResources)),
      consentResources: Array.from(new Set([...consentResources, ...grantedResources])),
      createdAt: previous?.createdAt || Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    sessions.set(sessionId, session);
    if (previous?.bindingId && previous.bindingId !== session.bindingId) {
      void revokeBinding(previous.bindingId).catch(() => {});
    }
    sendCallbackPage(res, "success", record.incremental ? "Service access updated." : "Signed in.", [
      cookieValue(SESSION_COOKIE, sessionId, { maxAge: SESSION_TTL_MS / 1000, secure }),
      clearStateCookie,
    ]);
  } catch (error) {
    if (issuedBindingId) void revokeBinding(issuedBindingId).catch(() => {});
    sendCallbackPage(res, "error", redactMessage(error.message), [clearStateCookie]);
  }
}

async function handleLogout(req, res) {
  const session = requestSession(req);
  if (session) {
    sessions.delete(session.id);
    await revokeBinding(session.bindingId).catch(() => {});
  }
  const secure = new URL(defaults.oauthRedirectUri).protocol === "https:";
  setCookies(res, [cookieValue(SESSION_COOKIE, "", { maxAge: 0, secure })]);
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
  json(res, 200, Array.isArray(result.data) ? result.data : []);
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

async function pipeFetchStream(req, res, runtime, path, options, prefixFrames = []) {
  const upstream = await fetchRequest(runtime, path, {
    ...options,
    accept: "text/event-stream",
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

  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  try {
    for await (const chunk of upstream.body) {
      if (res.destroyed || controller.signal.aborted) break;
      res.write(chunk);
    }
  } catch (error) {
    if (!res.destroyed) {
      writeSse(res, {
        type: "RUN_ERROR",
        runError: { message: redactMessage(error.message) },
      });
    }
  } finally {
    if (!res.writableEnded) res.end();
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
      ...(runtime.scopeId ? { scopeId: runtime.scopeId } : {}),
      ...(inputParts.length ? { inputParts } : {}),
    };
    await forwardStream(req, res, runtime, "/api/chat", {
      method: "POST",
      body: chatBody,
    });
    return;
  }

  const actorId = String(body.actorId || "").trim() || await createNyxIdConversation(runtime);
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
        prompt,
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
  const ornnResource = oauthResourceForSlug(defaults.ornnServiceSlug);
  const ornnAuthorized = runtime.session.resources.includes(ornnResource);
  const aevatarPromise = checkService(
    runtime,
    "/api/capabilities",
    "Aevatar responded through the authorized NyxID proxy route.",
  );
  const ornnPromise = ornnAuthorized
    ? checkService(
      { ...runtime, proxyBaseUrl: ornnResource },
      "/api/v1/skill-search?query=aevatar&mode=keyword&scope=mixed&page=1&pageSize=1",
      "Ornn skill search responded through the authorized NyxID proxy route.",
    )
    : Promise.resolve({
      ok: false,
      authorized: false,
      status: "authorization-required",
      latencyMs: 0,
      detail: "Authorize ornn-api when this chat needs Ornn skills.",
      serviceSlug: defaults.ornnServiceSlug,
    });
  const [aevatar, ornn] = await Promise.all([aevatarPromise, ornnPromise]);
  const ok = aevatar.ok && (!ornnAuthorized || ornn.ok);
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
    if (req.method === "GET" && requestUrl.pathname === "/api/auth/login") {
      await beginAuthorization(req, res);
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/api/auth/authorize") {
      await beginAuthorization(req, res, requestUrl.searchParams.getAll("serviceId"));
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/auth/callback") {
      await handleOAuthCallback(req, res, requestUrl);
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/api/auth/session") {
      json(res, 200, sessionPayload(requestSession(req)));
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/api/auth/services") {
      const session = requireSession(req);
      json(res, 200, { services: await listNyxidServices(session) });
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/api/auth/logout") {
      await handleLogout(req, res);
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/api/demo/config") {
      const session = requestSession(req);
      json(res, 200, {
        transport: defaults.transport,
        surface: defaults.surface,
        workflow: defaults.workflow,
        directBaseUrl: defaults.directBaseUrl,
        proxyBaseUrl: defaults.proxyBaseUrl,
        ornnWebUrl: defaults.ornnWebUrl,
        scopeId: session?.user.id || "",
        environment: "production",
        transportLocked: true,
        oauthConfigured: Boolean(defaults.oauthClientId && defaults.oauthRedirectUri),
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
  process.stdout.write(`NyxID Aevatar chat: http://${HOST}:${PORT}\n`);
});

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(id);
      void revokeBinding(session.bindingId).catch(() => {});
    }
  }
  for (const [state, record] of oauthStates) {
    if (now - record.createdAt > OAUTH_STATE_TTL_MS) oauthStates.delete(state);
  }
}, 60_000).unref();

function shutdown() {
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
