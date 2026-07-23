import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";

const SESSION_COOKIE = "nyx_session=test-session";

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

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function startMockNyxId(t) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const state = {
    keys: [
      {
        id: "key-openai",
        label: "My OpenAI",
        slug: "openai",
        catalog_service_slug: "llm-openai",
        catalog_service_name: "OpenAI",
        credential_type: "api_key",
        service_type: "api",
        status: "active",
        is_active: true,
      },
    ],
    createKeyBodies: [],
    streamBodies: [],
    storedMessages: [
      {
        id: "turn-1:user",
        role: "user",
        content: "帮我看 GitHub\n\n[[NYXID_CONTEXT]]\n内部目录内容\n[[/NYXID_CONTEXT]]",
        timestamp: 1,
      },
      { id: "turn-1:assistant", role: "assistant", content: "好的", timestamp: 2 },
    ],
  };
  const catalog = {
    entries: [
      {
        slug: "llm-openai",
        name: "OpenAI",
        description: "GPT models via your own key",
        provider_type: null,
        requires_credential: true,
        service_type: "api",
        icon_url: "",
        api_key_url: "https://platform.openai.com/api-keys",
        api_key_instructions: "Create a key",
        documentation_url: "",
      },
      {
        slug: "api-stripe",
        name: "Stripe",
        description: "Payments data and operations",
        provider_type: null,
        requires_credential: true,
        service_type: "api",
        icon_url: "https://icons.example/stripe.png",
        api_key_url: "https://dashboard.stripe.com/apikeys",
        api_key_instructions: "Use a restricted key",
        documentation_url: "https://docs.stripe.com",
      },
      {
        slug: "api-github",
        name: "GitHub",
        description: "Repos, issues, and PRs via OAuth",
        provider_type: "oauth2",
        requires_credential: true,
        service_type: "api",
        icon_url: "",
        api_key_url: "",
        api_key_instructions: "",
        documentation_url: "",
      },
    ],
  };

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url || "/", baseUrl);
    const authenticated = (req.headers.cookie || "").includes(SESSION_COOKIE);
    if (!authenticated) {
      json(res, 401, { message: "not authenticated" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/users/me") {
      json(res, 200, { id: "user-1", display_name: "Test User", email: "test@example.com" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/keys") {
      json(res, 200, { keys: state.keys });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/v1/keys") {
      const body = await readJsonBody(req);
      state.createKeyBodies.push(body);
      state.keys.push({
        id: `key-${body.service_slug}`,
        label: body.label,
        slug: body.service_slug,
        catalog_service_slug: body.service_slug,
        catalog_service_name: body.label,
        credential_type: "api_key",
        service_type: "api",
        status: "active",
        is_active: true,
      });
      json(res, 200, { id: `key-${body.service_slug}`, slug: body.service_slug, label: body.label });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/catalog") {
      json(res, 200, catalog);
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
      state.streamBodies.push(await readJsonBody(req));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "RUN_FINISHED", runFinished: {} })}\n\n`);
      res.end();
      return;
    }
    if (req.method === "GET" &&
        url.pathname === "/api/v1/proxy/s/aevatar/api/scopes/user-1/chat-history/conversations/actor-1") {
      json(res, 200, state.storedMessages);
      return;
    }
    json(res, 404, { message: `unexpected ${req.method} ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { baseUrl, state };
}

async function startServer(t, mockBaseUrl) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      NYXID_BASE_URL: mockBaseUrl,
      NYXID_WEB_URL: mockBaseUrl,
      NYXID_AEVATAR_PROXY_URL: `${mockBaseUrl}/api/v1/proxy/s/aevatar`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timed out")), 5000);
    child.once("error", reject);
    child.stdout.once("data", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  return { baseUrl: `http://127.0.0.1:${port}` };
}

test("connectors endpoint merges NyxID keys with the catalog", async (t) => {
  const mock = await startMockNyxId(t);
  const server = await startServer(t, mock.baseUrl);

  const response = await fetch(`${server.baseUrl}/api/nyxid/connectors`, {
    headers: { Cookie: SESSION_COOKIE },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.deepEqual(payload.connected.map((service) => service.slug), ["llm-openai"]);
  assert.equal(payload.connected[0].status, "connected");
  assert.deepEqual(
    payload.available.map((service) => service.slug).sort(),
    ["api-github", "api-stripe"],
  );
  const stripe = payload.available.find((service) => service.slug === "api-stripe");
  assert.equal(stripe.authKind, "api_key");
  assert.equal(stripe.apiKeyUrl, "https://dashboard.stripe.com/apikeys");
  const github = payload.available.find((service) => service.slug === "api-github");
  assert.equal(github.authKind, "oauth");
});

test("key creation proxies to NyxID and refreshes the connector cache", async (t) => {
  const mock = await startMockNyxId(t);
  const server = await startServer(t, mock.baseUrl);

  const created = await fetch(`${server.baseUrl}/api/nyxid/keys`, {
    method: "POST",
    headers: { Cookie: SESSION_COOKIE, "Content-Type": "application/json" },
    body: JSON.stringify({ serviceSlug: "api-stripe", credential: "sk_test_123", label: "Stripe" }),
  });
  assert.equal(created.status, 200);
  const payload = await created.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.key.slug, "api-stripe");
  assert.deepEqual(mock.state.createKeyBodies, [
    { service_slug: "api-stripe", credential: "sk_test_123", label: "Stripe" },
  ]);

  const connectors = await (await fetch(`${server.baseUrl}/api/nyxid/connectors`, {
    headers: { Cookie: SESSION_COOKIE },
  })).json();
  assert.ok(connectors.connected.some((service) => service.slug === "api-stripe"));
  assert.ok(!connectors.available.some((service) => service.slug === "api-stripe"));

  const invalid = await fetch(`${server.baseUrl}/api/nyxid/keys`, {
    method: "POST",
    headers: { Cookie: SESSION_COOKIE, "Content-Type": "application/json" },
    body: JSON.stringify({ serviceSlug: "api-stripe" }),
  });
  assert.equal(invalid.status, 400);
});

test("chat prompts carry the service catalog context for the LLM", async (t) => {
  const mock = await startMockNyxId(t);
  const server = await startServer(t, mock.baseUrl);

  const response = await fetch(`${server.baseUrl}/api/demo/chat`, {
    method: "POST",
    headers: { Cookie: SESSION_COOKIE, "Content-Type": "application/json" },
    body: JSON.stringify({ surface: "nyxid-chat", prompt: "帮我拉取昨天的失败支付" }),
  });
  assert.equal(response.status, 200);
  await response.text();

  assert.equal(mock.state.streamBodies.length, 1);
  const outbound = mock.state.streamBodies[0].prompt;
  assert.ok(outbound.startsWith("帮我拉取昨天的失败支付"), "user text must stay first for titles");
  assert.match(outbound, /\[\[NYXID_CONTEXT\]\]/);
  assert.match(outbound, /已连接的服务/);
  assert.match(outbound, /llm-openai/);
  assert.match(outbound, /api-stripe/);
  assert.match(outbound, /```nyxid:connect/);
  assert.match(outbound, /\[\[\/NYXID_CONTEXT\]\]/);
});

test("stored history strips the injected context from user messages", async (t) => {
  const mock = await startMockNyxId(t);
  const server = await startServer(t, mock.baseUrl);

  const response = await fetch(`${server.baseUrl}/api/demo/conversations/actor-1?surface=nyxid-chat`, {
    headers: { Cookie: SESSION_COOKIE },
  });
  assert.equal(response.status, 200);
  const messages = await response.json();
  assert.equal(messages[0].content, "帮我看 GitHub");
  assert.equal(messages[1].content, "好的");
});
