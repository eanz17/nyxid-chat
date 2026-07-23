import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error(message);
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function streamResponse(frames) {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("LLM connect fence renders a rich card that connects and resumes the task", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const page = new JSDOM(html, { url: "http://127.0.0.1:4311/", pretendToBeVisual: true });
  const { window } = page;
  window.HTMLElement.prototype.scrollTo = function scrollTo(options = {}) {
    this.scrollTop = Number(options.top || 0);
  };

  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    confirm: () => true,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    value: () => 0,
    writable: true,
  });

  let stripeConnected = false;
  const chatRequests = [];
  const keyRequests = [];

  const connectors = () => ({
    connected: [
      { slug: "llm-openai", name: "OpenAI", description: "", iconUrl: "", authKind: "api_key", connectionCount: 1, keyId: "key-openai", status: "connected" },
      ...(stripeConnected
        ? [{ slug: "api-stripe", name: "Stripe", description: "", iconUrl: "", authKind: "api_key", connectionCount: 1, keyId: "key-stripe", status: "connected" }]
        : []),
    ],
    available: stripeConnected ? [] : [
      {
        slug: "api-stripe",
        name: "Stripe",
        description: "Payments data and operations",
        iconUrl: "",
        authKind: "api_key",
        apiKeyUrl: "https://dashboard.stripe.com/apikeys",
        apiKeyInstructions: "Use a restricted key",
        docsUrl: "",
      },
    ],
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
    const method = String(init.method || "GET").toUpperCase();
    if (url.pathname === "/api/demo/config") {
      return jsonResponse({
        transport: "nyxid-session",
        authMode: "site-session",
        surface: "nyxid-chat",
        workflow: "direct",
        nyxidWebUrl: "https://nyx.example",
        servicesUrl: "https://nyx.example/keys",
      });
    }
    if (url.pathname === "/api/auth/session") {
      return jsonResponse({
        authenticated: true,
        authMode: "site-session",
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        scopeId: "user-1",
        resources: [],
      });
    }
    if (url.pathname === "/api/auth/services") {
      return jsonResponse({ services: [
        { id: "a", slug: "aevatar", label: "Aevatar", resourceUri: "aevatar", core: true, authorized: true, active: true, available: true },
      ] });
    }
    if (url.pathname === "/api/nyxid/connectors") return jsonResponse(connectors());
    if (url.pathname === "/api/nyxid/keys" && method === "POST") {
      keyRequests.push(JSON.parse(init.body));
      stripeConnected = true;
      return jsonResponse({ ok: true, key: { id: "key-stripe", slug: "api-stripe", label: "Stripe" } });
    }
    if (url.pathname === "/api/demo/health") {
      return jsonResponse({ ok: true, latencyMs: 1, components: { aevatar: { ok: true }, ornn: { ok: true } } });
    }
    if (url.pathname === "/api/demo/conversations" && method === "GET") {
      return jsonResponse({ conversations: [] });
    }
    if (url.pathname === "/api/demo/chat" && method === "POST") {
      chatRequests.push(JSON.parse(init.body));
      if (chatRequests.length === 1) {
        const reply = [
          "要拉取失败支付，需要先连接 Stripe。",
          "```nyxid:connect",
          "{\"catalog_slug\":\"api-stripe\",\"reason\":\"读取昨天的失败支付\"}",
          "```",
        ].join("\n");
        return streamResponse([
          { type: "TEXT_MESSAGE_START", textMessageStart: {} },
          { type: "TEXT_MESSAGE_CONTENT", textMessageContent: { delta: reply } },
          { type: "TEXT_MESSAGE_END", textMessageEnd: {} },
          { type: "RUN_FINISHED", runFinished: {} },
        ]);
      }
      return streamResponse([
        { type: "TEXT_MESSAGE_START", textMessageStart: {} },
        { type: "TEXT_MESSAGE_CONTENT", textMessageContent: { delta: "已拿到 23 笔失败支付。" } },
        { type: "TEXT_MESSAGE_END", textMessageEnd: {} },
        { type: "RUN_FINISHED", runFinished: {} },
      ]);
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  };

  await import(`../public/app.js?connect-card-test=${Date.now()}`);
  const prompt = window.document.querySelector("#promptInput");
  await waitFor(
    () => window.document.querySelector("#accountName").textContent === "Test User" && !prompt.disabled,
    "app did not finish authenticated initialization",
  );

  prompt.value = "拉取昨天的失败 Stripe 支付";
  prompt.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.querySelector("#composerForm")
    .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

  await waitFor(
    () => window.document.querySelector(".connect-card"),
    "connect card was not rendered from the nyxid:connect fence",
  );
  const card = window.document.querySelector(".connect-card");
  assert.match(card.querySelector(".cc-title").textContent, /Stripe/);
  assert.match(card.querySelector(".cc-sub").textContent, /读取昨天的失败支付/);
  assert.equal(card.querySelector(".cc-pill").textContent, "未连接");
  assert.equal(card.querySelectorAll(".cc-step").length, 3);
  assert.match(card.querySelector(".cc-foot").textContent, /NyxID/);

  const visibleText = window.document.querySelector(".conversation-view:not([hidden])").textContent;
  assert.ok(!visibleText.includes("nyxid:connect"), "raw fence must not leak into the thread");

  const pasteButton = [...card.querySelectorAll(".cc-btn")]
    .find((button) => button.textContent.includes("粘贴 API key"));
  assert.ok(pasteButton, "api-key connect action missing");
  pasteButton.click();

  const input = card.querySelector(".cc-key-form input");
  assert.ok(input, "inline credential input missing");
  assert.equal(card.querySelector(".cc-key-link").href, "https://dashboard.stripe.com/apikeys");
  input.value = "sk_test_abc";
  card.querySelector(".cc-key-form")
    .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

  await waitFor(
    () => card.classList.contains("connected"),
    "card did not flip to connected after key submit",
  );
  assert.deepEqual(keyRequests, [
    { serviceSlug: "api-stripe", credential: "sk_test_abc", label: "Stripe" },
  ]);
  assert.equal(card.querySelector(".cc-pill").textContent, "已连接");
  assert.ok(!card.querySelector(".cc-key-form"), "credential form should close after connect");

  await waitFor(() => chatRequests.length === 2, "original task was not retried automatically", 4000);
  assert.equal(chatRequests[1].prompt, "拉取昨天的失败 Stripe 支付");
  await waitFor(
    () => window.document.querySelector(".conversation-view:not([hidden])").textContent.includes("已拿到 23 笔失败支付"),
    "retried run output was not rendered",
  );

  page.window.close();
});
