import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
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
      NYXID_OAUTH_CLIENT_ID: "test-client",
      NYXID_OAUTH_REDIRECT_URI: `http://127.0.0.1:${port}/auth/callback`,
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

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function signedJwt(privateKey, kid, payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url");
  return `${header}.${body}.${signature}`;
}

async function startMockNyxId(t) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const kid = "test-key";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  const state = { nonce: "", revocations: 0 };
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
    if (req.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      json(res, 200, { keys: [publicJwk] });
      return;
    }
    if (req.method === "POST" && url.pathname === "/oauth/token") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const now = Math.floor(Date.now() / 1000);
        const accessToken = signedJwt(privateKey, kid, {
          sub: "user-1",
          iss: baseUrl,
          aud: baseUrl,
          exp: now + 300,
          iat: now,
          token_type: "access",
          scope: "openid profile email proxy",
          resources: [resources.aevatar, resources.llm, resources.ornn],
          allowed_service_ids: ["svc-aevatar", "svc-llm", "svc-ornn"],
          allow_all_services: false,
        });
        if (form.get("grant_type") === "authorization_code") {
          json(res, 200, {
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: 300,
            scope: "openid profile email proxy",
            resource: [resources.aevatar, resources.llm, resources.ornn],
            binding_id: "bnd_test-binding",
            id_token: signedJwt(privateKey, kid, {
              sub: "user-1",
              iss: baseUrl,
              aud: "test-client",
              exp: now + 3600,
              iat: now,
              nonce: state.nonce,
            }),
          });
          return;
        }
        json(res, 200, {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 300,
          scope: "openid profile email proxy",
        });
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/oauth/userinfo") {
      json(res, 200, { sub: "user-1", name: "Test User", email: "test@example.com" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/users/me/consents") {
      json(res, 200, {
        consents: [{
          client_id: "test-client",
          scopes: "openid profile email proxy",
          allow_all_services: false,
          legacy_unrestricted: false,
          allowed_services: [
            { id: "svc-aevatar", slug: "aevatar", deleted: false },
            { id: "svc-llm", slug: "chrono-llm-public", deleted: false },
            { id: "svc-ornn", slug: "ornn-api", deleted: false },
            { id: "svc-openai", slug: "openai-test", deleted: false },
          ],
        }],
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/user-services") {
      json(res, 200, { services });
      return;
    }
    if (req.method === "POST" && url.pathname === "/oauth/revoke") {
      state.revocations += 1;
      json(res, 200, {});
      return;
    }
    json(res, 404, { message: "not found" });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  t.after(() => server.close());
  return { baseUrl, resources, state };
}

test("OAuth BFF protects runtime APIs and builds a least-privilege login request", async (t) => {
  const { baseUrl, port } = await startServer(t);

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
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
  const authorize = new URL(login.headers.get("location"));
  assert.equal(authorize.origin, "https://nyx-api.chrono-ai.fun");
  assert.equal(authorize.pathname, "/oauth/authorize");
  assert.equal(authorize.searchParams.get("response_type"), "code");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorize.searchParams.get("code_challenge"));
  assert.ok(authorize.searchParams.get("nonce"));
  assert.ok(authorize.searchParams.get("state"));
  assert.equal(
    authorize.searchParams.get("redirect_uri"),
    `http://127.0.0.1:${port}/auth/callback`,
  );
  assert.equal(authorize.searchParams.get("scope"), "openid profile email proxy");
  assert.deepEqual(authorize.searchParams.getAll("resource"), [
    "https://nyx-api.chrono-ai.fun/api/v1/proxy/s/aevatar",
    "https://nyx-api.chrono-ai.fun/api/v1/proxy/s/chrono-llm-public",
    "https://nyx-api.chrono-ai.fun/api/v1/proxy/s/ornn-api",
  ]);
});

test("OAuth callback creates a server-side session and preserves existing consent on incremental auth", async (t) => {
  const nyxid = await startMockNyxId(t);
  const { baseUrl } = await startServer(t, {
    NYXID_BASE_URL: nyxid.baseUrl,
    NYXID_AEVATAR_PROXY_URL: nyxid.resources.aevatar,
    NYXID_OAUTH_CLIENT_ID: "test-client",
  });

  const login = await fetch(`${baseUrl}/api/auth/login`, { redirect: "manual" });
  const authorize = new URL(login.headers.get("location"));
  nyxid.state.nonce = authorize.searchParams.get("nonce");
  const state = authorize.searchParams.get("state");
  const stateCookie = login.headers.get("set-cookie").split(";", 1)[0];

  const callback = await fetch(`${baseUrl}/auth/callback?state=${encodeURIComponent(state)}&code=test-code`, {
    headers: { Cookie: stateCookie },
    redirect: "manual",
  });
  assert.equal(callback.status, 200);
  const sessionCookieMatch = callback.headers.get("set-cookie")
    .match(/nyxid_chat_session=([^;,]+)/);
  assert.ok(sessionCookieMatch, "callback should set an HttpOnly session cookie");
  const sessionCookie = `nyxid_chat_session=${sessionCookieMatch[1]}`;

  const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: sessionCookie },
  });
  const sessionPayload = await sessionResponse.json();
  assert.ok(Date.parse(sessionPayload.expiresAt) > Date.now());
  delete sessionPayload.expiresAt;
  assert.deepEqual(sessionPayload, {
    authenticated: true,
    user: {
      id: "user-1",
      name: "Test User",
      email: "test@example.com",
      picture: "",
    },
    scopeId: "user-1",
    resources: [nyxid.resources.aevatar, nyxid.resources.llm, nyxid.resources.ornn],
  });

  const servicesResponse = await fetch(`${baseUrl}/api/auth/services`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(servicesResponse.status, 200);
  const services = (await servicesResponse.json()).services;
  assert.equal(services.find((service) => service.id === "svc-aevatar").authorized, true);
  assert.equal(services.find((service) => service.id === "svc-aevatar").core, true);
  assert.equal(services.find((service) => service.id === "svc-llm").authorized, true);
  assert.equal(services.find((service) => service.id === "svc-llm").core, true);
  assert.equal(services.find((service) => service.id === "svc-ornn").authorized, true);
  assert.equal(services.find((service) => service.id === "svc-ornn").core, true);
  assert.equal(services.find((service) => service.id === "svc-openai").authorized, false);
  assert.equal(services.find((service) => service.id === "svc-openai").core, false);

  const incremental = await fetch(`${baseUrl}/api/auth/authorize?serviceId=svc-openai`, {
    headers: { Cookie: sessionCookie },
    redirect: "manual",
  });
  assert.equal(incremental.status, 302);
  const incrementalAuthorize = new URL(incremental.headers.get("location"));
  assert.equal(incrementalAuthorize.searchParams.get("prompt"), "consent");
  assert.deepEqual(new Set(incrementalAuthorize.searchParams.getAll("resource")), new Set([
    nyxid.resources.aevatar,
    nyxid.resources.llm,
    nyxid.resources.ornn,
    nyxid.resources.openai,
  ]));

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: sessionCookie, Origin: baseUrl },
  });
  assert.equal(logout.status, 200);
  assert.equal(nyxid.state.revocations, 1);
});

test("OAuth callback fails closed when state is missing", async (t) => {
  const { baseUrl } = await startServer(t);
  const response = await fetch(`${baseUrl}/auth/callback?state=invalid&code=invalid`);
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(await response.text(), /授权未完成/);
});
