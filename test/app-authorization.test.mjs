import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, message, timeout = 2000) {
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

test("NyxID site service can be configured and retried inside the chat", async () => {
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

  let githubAuthorized = false;
  let openedServicePath = "";
  let popup = null;
  const chatRequests = [];
  window.open = (path) => {
    openedServicePath = path;
    popup = {
      closed: false,
      close() { this.closed = true; },
      focus() {},
    };
    return popup;
  };

  const services = () => [
    { id: "a", slug: "aevatar", label: "Aevatar", resourceUri: "aevatar", core: true, authorized: true, active: true, available: true },
    { id: "l", slug: "chrono-llm-public", label: "Chrono LLM", resourceUri: "chrono-llm-public", core: true, authorized: true, active: true, available: true },
    { id: "o", slug: "ornn-api", label: "Ornn", resourceUri: "ornn-api", core: true, authorized: true, active: true, available: true },
    { id: "github", slug: "api-github", label: "GitHub", resourceUri: "api-github", core: false, authorized: githubAuthorized, active: true, available: githubAuthorized },
  ];

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
        resources: ["aevatar", "chrono-llm-public", "ornn-api", ...(githubAuthorized ? ["api-github"] : [])],
      });
    }
    if (url.pathname === "/api/auth/services") return jsonResponse({ services: services() });
    if (url.pathname === "/api/demo/health") {
      return jsonResponse({
        ok: true,
        latencyMs: 1,
        components: { aevatar: { ok: true }, ornn: { ok: true } },
      });
    }
    if (url.pathname === "/api/demo/conversations" && method === "GET") {
      return jsonResponse({ conversations: [] });
    }
    if (url.pathname === "/api/demo/chat" && method === "POST") {
      chatRequests.push(JSON.parse(init.body));
      if (chatRequests.length === 1) {
        return streamResponse([
          {
            type: "AUTHORIZATION_REQUIRED",
            authorizationRequired: {
              serviceSlug: "api-github",
              message: "GitHub access is required for this request.",
            },
          },
          { type: "RUN_FINISHED", runFinished: {} },
        ]);
      }
      return streamResponse([
        { type: "TEXT_MESSAGE_START", textMessageStart: {} },
        { type: "TEXT_MESSAGE_CONTENT", textMessageContent: { delta: "Retry completed" } },
        { type: "TEXT_MESSAGE_END", textMessageEnd: {} },
        { type: "RUN_FINISHED", runFinished: {} },
      ]);
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  };

  await import(`../public/app.js?authorization-test=${Date.now()}`);
  const prompt = window.document.querySelector("#promptInput");
  await waitFor(
    () => window.document.querySelector("#accountName").textContent === "Test User" && !prompt.disabled,
    "app did not finish authenticated initialization",
  );

  window.document.querySelector("#composerServicesButton").click();
  const composerPanel = window.document.querySelector("#composerServicePanel");
  assert.equal(composerPanel.classList.contains("hidden"), false);
  assert.match(composerPanel.textContent, /GitHub/);
  assert.match(composerPanel.textContent, /需配置/);
  const githubRow = [...composerPanel.querySelectorAll(".service-access-row")]
    .find((row) => row.textContent.includes("GitHub"));
  githubRow.querySelector(".service-authorize-button").click();
  assert.equal(openedServicePath, "https://nyx.example/keys");
  window.document.querySelector("#closeComposerServicesButton").click();

  prompt.value = "Read my GitHub repositories";
  prompt.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.querySelector("#composerForm")
    .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

  await waitFor(
    () => window.document.querySelector(".authorization-callout"),
    "authorization card was not rendered in the chat",
  );
  const card = window.document.querySelector(".authorization-callout");
  assert.match(card.textContent, /GitHub/);
  assert.match(card.textContent, /api-github/);

  const authorize = card.querySelector(".service-authorize-button");
  assert.equal(authorize.textContent.trim(), "管理 Services");
  authorize.click();
  assert.equal(openedServicePath, "https://nyx.example/keys");
  assert.match(card.textContent, /返回这里刷新状态/);

  card.querySelector(".service-authorize-button").click();
  await waitFor(
    () => card.classList.contains("error") && card.textContent.includes("尚未检测到可用"),
    "authorization card did not report an unavailable service after refresh",
  );
  card.querySelector(".service-authorize-button").click();

  githubAuthorized = true;
  card.querySelector(".service-authorize-button").click();
  await waitFor(
    () => card.classList.contains("granted") && card.textContent.includes("重试请求"),
    "authorization card did not update after refreshing NyxID services",
  );

  await waitFor(() => !prompt.disabled, "first chat run did not finish");
  card.querySelector(".service-authorize-button").click();
  await waitFor(() => chatRequests.length === 2, "original chat request was not retried");
  assert.equal(chatRequests[1].prompt, "Read my GitHub repositories");
  await waitFor(
    () => window.document.querySelector(".conversation-view:not([hidden])").textContent.includes("Retry completed"),
    "retried chat output was not rendered",
  );

  page.window.close();
});
