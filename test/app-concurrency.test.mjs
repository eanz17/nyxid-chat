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

function streamResponse(actorId, output, delay) {
  const frames = [
    {
      at: 5,
      value: {
        type: "CUSTOM",
        custom: {
          name: "demo.conversation.context",
          payload: { actorId, sessionId: `session-${actorId}` },
        },
      },
    },
    { at: 10, value: { type: "TEXT_MESSAGE_START", textMessageStart: {} } },
    { at: delay, value: { type: "TEXT_MESSAGE_CONTENT", textMessageContent: { delta: output } } },
    { at: delay + 10, value: { type: "TEXT_MESSAGE_END", textMessageEnd: {} } },
    { at: delay + 20, value: { type: "RUN_FINISHED", runFinished: {} } },
  ];
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame.value)}\n\n`));
        }, frame.at);
      }
      setTimeout(() => controller.close(), delay + 30);
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("NyxID Chat keeps concurrent conversation streams isolated and switchable", async () => {
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

  const conversations = [];
  const chatRequests = [];
  let chatSequence = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
    const method = String(init.method || "GET").toUpperCase();
    if (url.pathname === "/api/demo/config") {
      return jsonResponse({
        transport: "nyxid-session",
        authMode: "site-session",
        surface: "nyxid-chat",
        workflow: "direct",
        scopeId: "user-1",
      });
    }
    if (url.pathname === "/api/auth/session") {
      return jsonResponse({
        authenticated: true,
        user: { id: "user-1", name: "Test User", email: "test@example.com" },
        scopeId: "user-1",
        resources: ["aevatar", "chrono-llm-public", "ornn-api"],
      });
    }
    if (url.pathname === "/api/auth/services") {
      return jsonResponse({ services: [
        { id: "a", slug: "aevatar", resourceUri: "aevatar", core: true, authorized: true, active: true, available: true },
        { id: "l", slug: "chrono-llm-public", resourceUri: "chrono-llm-public", core: true, authorized: true, active: true, available: true },
        { id: "o", slug: "ornn-api", resourceUri: "ornn-api", core: true, authorized: true, active: true, available: true },
      ] });
    }
    if (url.pathname === "/api/demo/health") {
      return jsonResponse({
        ok: true,
        latencyMs: 1,
        components: { aevatar: { ok: true }, ornn: { ok: true } },
      });
    }
    if (url.pathname === "/api/demo/conversations" && method === "GET") {
      return jsonResponse({ conversations });
    }
    if (url.pathname === "/api/demo/chat" && method === "POST") {
      const body = JSON.parse(init.body);
      const index = ++chatSequence;
      const actorId = `actor-${index}`;
      conversations.unshift({
        actorId,
        title: body.prompt,
        serviceKind: "nyxid.chat",
        messageCount: 1,
        updatedAt: new Date(Date.now() + index).toISOString(),
      });
      chatRequests.push({ actorId, signal: init.signal });
      return streamResponse(actorId, index === 1 ? "FIRST_STREAM_OUTPUT" : "SECOND_STREAM_OUTPUT", index === 1 ? 100 : 60);
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  };

  await import(`../public/app.js?concurrency-test=${Date.now()}`);
  const prompt = window.document.querySelector("#promptInput");
  const composer = window.document.querySelector("#composerForm");
  const newChat = window.document.querySelector("#newChatButton");
  await waitFor(() => window.document.querySelector("#accountName").textContent === "Test User" &&
    !prompt.disabled, "app did not finish authenticated initialization");

  prompt.value = "first conversation";
  prompt.dispatchEvent(new window.Event("input", { bubbles: true }));
  composer.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => chatRequests.length === 1, "first stream did not start");

  newChat.click();
  assert.equal(chatRequests[0].signal.aborted, false, "switching conversations must not abort the first stream");
  prompt.value = "second conversation";
  prompt.dispatchEvent(new window.Event("input", { bubbles: true }));
  composer.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => chatRequests.length === 2, "second stream did not start in parallel");
  assert.equal(chatRequests[0].signal.aborted, false);
  assert.equal(chatRequests[1].signal.aborted, false);

  await waitFor(() => {
    const views = [...window.document.querySelectorAll(".conversation-view")];
    return views.some((view) => view.textContent.includes("FIRST_STREAM_OUTPUT")) &&
      views.some((view) => view.textContent.includes("SECOND_STREAM_OUTPUT"));
  }, "parallel stream output was not isolated into both conversation views");

  const activeView = window.document.querySelector(".conversation-view:not([hidden])");
  assert.match(activeView.textContent, /SECOND_STREAM_OUTPUT/);
  assert.doesNotMatch(activeView.textContent, /FIRST_STREAM_OUTPUT/);

  await waitFor(() => [...window.document.querySelectorAll(".history-session")]
    .some((button) => button.textContent.includes("first conversation")), "first conversation was not listed");
  const firstConversation = [...window.document.querySelectorAll(".history-session")]
    .find((button) => button.textContent.includes("first conversation"));
  firstConversation.click();
  const switchedView = window.document.querySelector(".conversation-view:not([hidden])");
  assert.match(switchedView.textContent, /FIRST_STREAM_OUTPUT/);
  assert.doesNotMatch(switchedView.textContent, /SECOND_STREAM_OUTPUT/);
  assert.equal(chatRequests[0].signal.aborted, false);

  page.window.close();
});
