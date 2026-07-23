import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConnectCardBlock,
  connectorInitial,
  splitMessageSegments,
} from "../public/blocks.js";

test("splitMessageSegments extracts connect cards between markdown text", () => {
  const source = [
    "需要先连接 GitHub 才能继续。",
    "```nyxid:connect",
    "{\"catalog_slug\":\"api-github\",\"reason\":\"读取你的仓库列表\"}",
    "```",
    "连接完成后我会自动继续。",
  ].join("\n");
  const segments = splitMessageSegments(source);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].kind, "text");
  assert.match(segments[0].text, /连接 GitHub/);
  assert.deepEqual(
    { kind: segments[1].kind, slug: segments[1].slug, reason: segments[1].reason },
    { kind: "connect_card", slug: "api-github", reason: "读取你的仓库列表" },
  );
  assert.equal(segments[1].key, "connect:api-github:0");
  assert.equal(segments[2].kind, "text");
});

test("splitMessageSegments holds back an unterminated fence while streaming", () => {
  const source = "分析中……\n```nyxid:connect\n{\"catalog_slug\":\"api-stripe\"";
  const streaming = splitMessageSegments(source, { allowPartial: true });
  assert.equal(streaming.at(-1).kind, "pending_card");
  assert.equal(streaming.filter((segment) => segment.kind === "connect_card").length, 0);

  const terminal = splitMessageSegments(source, { allowPartial: false });
  assert.equal(terminal.filter((segment) => segment.kind === "pending_card").length, 0);
  assert.match(terminal.map((segment) => segment.text || "").join("\n"), /api-stripe/);
});

test("splitMessageSegments falls back to text for invalid payloads", () => {
  const invalidJson = "```nyxid:connect\nnot-json\n```";
  const badSlug = "```nyxid:connect\n{\"catalog_slug\":\"Bad Slug!\"}\n```";
  for (const source of [invalidJson, badSlug]) {
    const segments = splitMessageSegments(source);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].kind, "text");
  }
});

test("splitMessageSegments leaves ordinary code fences to markdown", () => {
  const source = "示例：\n```js\nconsole.log(1)\n```\n结束";
  const segments = splitMessageSegments(source);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "text");
  assert.match(segments[0].text, /console\.log/);
});

test("buildConnectCardBlock enriches from the connectors snapshot", () => {
  const connectors = {
    connected: [
      { slug: "api-openai", name: "OpenAI", status: "connected", authKind: "api_key", keyId: "key-1", iconUrl: "" },
    ],
    available: [
      {
        slug: "api-stripe",
        name: "Stripe",
        description: "Payments data",
        authKind: "api_key",
        iconUrl: "https://icons.example/stripe.png",
        apiKeyUrl: "https://dashboard.stripe.com/apikeys",
        apiKeyInstructions: "Create a restricted key",
        docsUrl: "",
      },
      { slug: "api-github", name: "GitHub", description: "", authKind: "oauth", iconUrl: "", apiKeyUrl: "", apiKeyInstructions: "", docsUrl: "" },
    ],
  };

  const stripe = buildConnectCardBlock(
    { kind: "connect_card", key: "connect:api-stripe:0", slug: "api-stripe", reason: "拉取失败支付", requestedScopes: [] },
    connectors,
  );
  assert.equal(stripe.type, "connect_card");
  assert.equal(stripe.service_name, "Stripe");
  assert.equal(stripe.auth_kind, "api_key");
  assert.equal(stripe.state, "needs_connection");
  assert.equal(stripe.subtitle, "拉取失败支付");
  assert.equal(stripe.api_key_url, "https://dashboard.stripe.com/apikeys");
  assert.equal(stripe.steps.length, 3);
  assert.equal(stripe.known, true);

  const openai = buildConnectCardBlock(
    { kind: "connect_card", key: "connect:api-openai:0", slug: "api-openai", reason: "", requestedScopes: [] },
    connectors,
  );
  assert.equal(openai.state, "connected");
  assert.equal(openai.key_id, "key-1");
  assert.equal(openai.steps[0].done, true);

  const unknown = buildConnectCardBlock(
    { kind: "connect_card", key: "connect:api-x:0", slug: "api-x", reason: "", requestedScopes: [] },
    connectors,
  );
  assert.equal(unknown.known, false);
  assert.equal(unknown.state, "needs_connection");
  assert.equal(unknown.service_name, "api-x");
});

test("connectorInitial mirrors the NyxID tile initial rules", () => {
  assert.equal(connectorInitial("Stripe"), "S");
  assert.equal(connectorInitial("OpenClaw Gateway"), "OG");
  assert.equal(connectorInitial(""), "?");
});
