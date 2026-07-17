import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(t, extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timed out")), 5000);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`server exited with ${code}`)));
    child.stdout.once("data", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  return { baseUrl: `http://127.0.0.1:${port}`, port };
}

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sse(res, frame) {
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
}

async function startMockNyxId(t) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const state = {
    authHeaders: [],
    logoutRequests: 0,
    proxyAuthorizations: [],
    proxyCookies: [],
    streamAborts: 0,
    streamScenario: "keepalive-only",
  };
  const resources = {
    aevatar: `${baseUrl}/api/v1/proxy/s/aevatar`,
    llm: `${baseUrl}/api/v1/proxy/s/chrono-llm-public`,
    ornn: `${baseUrl}/api/v1/proxy/s/ornn-api`,
    openai: `${baseUrl}/api/v1/proxy/s/openai-test`,
  };
  const services = [
    {
      id: "svc-aevatar",
      slug: "aevatar",
      label: "Aevatar",
      resource_uri: resources.aevatar,
      is_active: true,
      credential_source: { type: "personal" },
    },
    {
      id: "svc-llm",
      slug: "chrono-llm-public",
      label: "Chrono LLM Public",
      resource_uri: resources.llm,
      is_active: true,
      credential_source: { type: "personal" },
    },
    {
      id: "svc-ornn",
      slug: "ornn-api",
      label: "Ornn",
      resource_uri: resources.ornn,
      is_active: true,
      credential_source: { type: "personal" },
    },
    {
      id: "svc-openai",
      slug: "openai-test",
      label: "OpenAI test",
      resource_uri: resources.openai,
      is_active: true,
      credential_source: { type: "personal" },
    },
  ];

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url || "/", baseUrl);
    const authenticated = req.headers.cookie === "nyx_session=test-session" ||
      req.headers.authorization === "Bearer test-access-token";
    if (url.pathname.startsWith("/api/v1/proxy/")) {
      state.proxyCookies.push(req.headers.cookie || "");
      state.proxyAuthorizations.push(req.headers.authorization || "");
      if (!authenticated) {
        json(res, 401, { message: "not authenticated" });
        return;
      }
    }
    if (req.method === "GET" && url.pathname === "/api/v1/users/me") {
      state.authHeaders.push({
        path: url.pathname,
        authorization: req.headers.authorization || "",
        cookie: req.headers.cookie || "",
      });
      if (!authenticated) {
        json(res, 401, { message: "not authenticated" });
        return;
      }
      json(res, 200, {
        id: "user-1",
        display_name: "Test User",
        email: "test@example.com",
        avatar_url: "",
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/auth/logout") {
      if (!authenticated) {
        json(res, 401, { message: "not authenticated" });
        return;
      }
      state.logoutRequests += 1;
      json(res, 200, { ok: true }, {
        "Set-Cookie": "nyx_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/user-services") {
      state.authHeaders.push({
        path: url.pathname,
        authorization: req.headers.authorization || "",
        cookie: req.headers.cookie || "",
      });
      if (!authenticated) {
        json(res, 401, { message: "not authenticated" });
        return;
      }
      json(res, 200, { services });
      return;
    }
    if (req.method === "GET" &&
        url.pathname === "/api/v1/proxy/s/aevatar/api/capabilities") {
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" &&
        url.pathname === "/api/v1/proxy/s/ornn-api/api/v1/skill-search") {
      json(res, 200, { items: [] });
      return;
    }
    if (req.method === "POST" &&
        url.pathname === "/api/v1/proxy/s/aevatar/api/scopes/user-1/nyxid-chat/conversations") {
      json(res, 200, { actorId: "actor-1" });
      return;
    }
    if (req.method === "GET" &&
        url.pathname === "/api/v1/proxy/s/aevatar/api/scopes/user-1/nyxid-chat/conversations") {
      json(res, 200, { conversations: [{ actorId: "actor-1" }] });
      return;
    }
    if (req.method === "POST" &&
        url.pathname === "/api/v1/proxy/s/aevatar/api/scopes/user-1/nyxid-chat/conversations/actor-1:stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Correlation-Id": "corr-test-stream",
      });
      const timers = [];
      const writeKeepalive = () => sse(res, {
        type: "CUSTOM",
        custom: { name: "aevatar.nyxid_chat.keepalive", payload: {} },
      });
      writeKeepalive();
      const keepaliveTimer = setInterval(writeKeepalive, 20);
      const cleanup = () => {
        clearInterval(keepaliveTimer);
        timers.forEach(clearTimeout);
      };
      res.once("close", () => {
        cleanup();
        if (!res.writableEnded) state.streamAborts += 1;
      });

      if (state.streamScenario === "progress-then-finish") {
        timers.push(setTimeout(() => sse(res, {
          type: "RUN_STARTED",
          runStarted: { runId: "run-1" },
        }), 120));
        timers.push(setTimeout(() => {
          sse(res, { type: "RUN_FINISHED", runFinished: {} });
          res.end();
        }, 240));
      }
      return;
    }
    json(res, 404, { message: "not found" });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { baseUrl, resources, state };
}

test("site-session BFF protects APIs and returns localhost login through first-party handoff", async (t) => {
  const nyxid = await startMockNyxId(t);
  const { baseUrl, port } = await startServer(t, {
    NYXID_BASE_URL: nyxid.baseUrl,
    NYXID_WEB_URL: nyxid.baseUrl,
    NYXID_AEVATAR_PROXY_URL: nyxid.resources.aevatar,
  });

  const session = await fetch(`${baseUrl}/api/auth/session`);
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { authenticated: false });

  const health = await fetch(`${baseUrl}/api/demo/health`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: "{}",
  });
  assert.equal(health.status, 401);
  assert.equal((await health.json()).code, "AUTH_REQUIRED");

  const crossOrigin = await fetch(`${baseUrl}/api/demo/health`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
    body: "{}",
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).code, "ORIGIN_REJECTED");

  const login = await fetch(`${baseUrl}/api/auth/login`, { redirect: "manual" });
  assert.equal(login.status, 302);
  const handoff = new URL(login.headers.get("location"));
  assert.equal(handoff.origin, nyxid.baseUrl);
  assert.equal(handoff.pathname, "/cli-auth");
  assert.equal(handoff.searchParams.get("port"), String(port));
  assert.equal(handoff.searchParams.get("client_ua"), "nyxid-assistant");
  assert.ok(handoff.searchParams.get("state"));

  const callback = await fetch(`${baseUrl}/callback?${new URLSearchParams({
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    state: handoff.searchParams.get("state"),
  })}`, { redirect: "manual" });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "/");
  const localSessionCookie = callback.headers.get("set-cookie").split(";", 1)[0];
  assert.match(localSessionCookie, /^nyxid_chat_token_session=/);

  const authenticated = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: `${localSessionCookie}; nyx_session=stale-local-cookie; theme=dark` },
  });
  assert.equal(authenticated.status, 200);
  assert.equal((await authenticated.json()).user.id, "user-1");
  assert.ok(nyxid.state.authHeaders.some(
    (entry) => entry.authorization === "Bearer test-access-token" && entry.cookie === "",
  ));

  const localLogout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: localSessionCookie, Origin: baseUrl },
  });
  assert.equal(localLogout.status, 200);
  assert.match(localLogout.headers.get("set-cookie"), /nyxid_chat_token_session=;/);

  const sameOriginReturnTo = "/assistant?c=conversation-1#latest";
  const sameOriginLogin = await fetch(
    `${baseUrl}/api/auth/login?${new URLSearchParams({ return_to: sameOriginReturnTo })}`,
    {
      headers: {
        "X-Forwarded-Host": new URL(nyxid.baseUrl).host,
        "X-Forwarded-Proto": "http",
      },
      redirect: "manual",
    },
  );
  const siteLogin = new URL(sameOriginLogin.headers.get("location"));
  assert.equal(siteLogin.pathname, "/login");
  assert.equal(
    siteLogin.searchParams.get("return_to"),
    `${nyxid.baseUrl}${sameOriginReturnTo}`,
  );

  const externalReturnLogin = await fetch(
    `${baseUrl}/api/auth/login?${new URLSearchParams({
      return_to: "https://attacker.example/collect",
    })}`,
    {
      headers: {
        "X-Forwarded-Host": new URL(nyxid.baseUrl).host,
        "X-Forwarded-Proto": "http",
      },
      redirect: "manual",
    },
  );
  const externalReturnTarget = new URL(externalReturnLogin.headers.get("location"));
  assert.equal(externalReturnTarget.searchParams.get("return_to"), `${nyxid.baseUrl}/`);

  const incremental = await fetch(`${baseUrl}/api/auth/authorize?serviceId=svc-openai`);
  assert.equal(incremental.status, 410);
  assert.equal((await incremental.json()).code, "DEVELOPER_APP_AUTH_REMOVED");
});

test("BFF validates and forwards the NyxID site session", async (t) => {
  const nyxid = await startMockNyxId(t);
  const { baseUrl } = await startServer(t, {
    NYXID_BASE_URL: nyxid.baseUrl,
    NYXID_WEB_URL: nyxid.baseUrl,
    NYXID_AEVATAR_PROXY_URL: nyxid.resources.aevatar,
  });
  const browserCookies = "theme=dark; nyx_session=test-session; analytics_id=private";
  const sessionCookie = "nyx_session=test-session";

  const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: browserCookies },
  });
  const sessionPayload = await sessionResponse.json();
  assert.deepEqual(sessionPayload, {
    authenticated: true,
    authMode: "site-session",
    user: {
      id: "user-1",
      name: "Test User",
      email: "test@example.com",
      picture: "",
    },
    scopeId: "user-1",
    resources: [],
  });

  const servicesResponse = await fetch(`${baseUrl}/api/auth/services`, {
    headers: { Cookie: browserCookies },
  });
  assert.equal(servicesResponse.status, 200);
  const services = (await servicesResponse.json()).services;
  assert.equal(services.find((service) => service.id === "svc-aevatar").authorized, true);
  assert.equal(services.find((service) => service.id === "svc-aevatar").core, true);
  assert.equal(services.find((service) => service.id === "svc-llm").authorized, true);
  assert.equal(services.find((service) => service.id === "svc-llm").core, true);
  assert.equal(services.find((service) => service.id === "svc-ornn").authorized, true);
  assert.equal(services.find((service) => service.id === "svc-ornn").core, true);
  assert.equal(services.find((service) => service.id === "svc-openai").authorized, true);
  assert.equal(services.find((service) => service.id === "svc-openai").core, false);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: browserCookies, Origin: baseUrl },
  });
  assert.equal(logout.status, 200);
  assert.equal(nyxid.state.logoutRequests, 1);
  assert.match(logout.headers.get("set-cookie"), /nyx_session=;/);
  assert.ok(nyxid.state.authHeaders.length >= 3);
  assert.deepEqual(new Set(nyxid.state.authHeaders.map((entry) => entry.cookie)), new Set([sessionCookie]));
  assert.ok(nyxid.state.authHeaders.every((entry) => entry.authorization === ""));
});

test("explicit bearer credentials take precedence over ambient cookies", async (t) => {
  const nyxid = await startMockNyxId(t);
  const { baseUrl } = await startServer(t, {
    NYXID_BASE_URL: nyxid.baseUrl,
    NYXID_WEB_URL: nyxid.baseUrl,
    NYXID_AEVATAR_PROXY_URL: nyxid.resources.aevatar,
  });
  const headers = {
    Authorization: "Bearer test-access-token",
    Cookie: "nyx_session=wrong-session; theme=dark",
  };

  const session = await fetch(`${baseUrl}/api/auth/session`, { headers });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.id, "user-1");

  const services = await fetch(`${baseUrl}/api/auth/services`, { headers });
  assert.equal(services.status, 200);

  const health = await fetch(`${baseUrl}/api/demo/health`, {
    method: "POST",
    headers: { ...headers, Origin: baseUrl, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  assert.ok(nyxid.state.authHeaders.every((entry) => entry.cookie === ""));
  assert.ok(nyxid.state.authHeaders.every(
    (entry) => entry.authorization === "Bearer test-access-token",
  ));
  assert.deepEqual(new Set(nyxid.state.proxyCookies), new Set([""]));
  assert.deepEqual(
    new Set(nyxid.state.proxyAuthorizations),
    new Set(["Bearer test-access-token"]),
  );
});

test("SSE proxy times out keepalive-only runs and preserves real progress", async (t) => {
  const nyxid = await startMockNyxId(t);
  const { baseUrl } = await startServer(t, {
    NYXID_BASE_URL: nyxid.baseUrl,
    NYXID_WEB_URL: nyxid.baseUrl,
    NYXID_AEVATAR_PROXY_URL: nyxid.resources.aevatar,
    DEMO_STREAM_PROGRESS_TIMEOUT_MS: "200",
  });
  const sessionCookie = "nyx_session=test-session";
  const request = () => fetch(`${baseUrl}/api/demo/chat`, {
    method: "POST",
    headers: {
      Cookie: sessionCookie,
      Origin: baseUrl,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: "find skills", surface: "nyxid-chat" }),
  });

  const stalledResponse = await request();
  assert.equal(stalledResponse.status, 200);
  assert.equal(stalledResponse.headers.get("x-correlation-id"), "corr-test-stream");
  const stalledBody = await stalledResponse.text();
  assert.match(stalledBody, /aevatar\.nyxid_chat\.keepalive/);
  assert.match(stalledBody, /UPSTREAM_PROGRESS_TIMEOUT/);
  assert.match(stalledBody, /corr-test-stream/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(nyxid.state.streamAborts, 1, "timed-out upstream stream should be cancelled");

  nyxid.state.streamScenario = "progress-then-finish";
  const progressingResponse = await request();
  assert.equal(progressingResponse.status, 200);
  const progressingBody = await progressingResponse.text();
  assert.match(progressingBody, /RUN_STARTED/);
  assert.match(progressingBody, /RUN_FINISHED/);
  assert.doesNotMatch(progressingBody, /UPSTREAM_PROGRESS_TIMEOUT/);
  assert.deepEqual(new Set(nyxid.state.proxyCookies), new Set([sessionCookie]));
});
