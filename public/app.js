import {
  consumeSse,
  mergeUsage,
  normalizeConversationIndex,
  normalizeFrame,
  normalizeStoredMessages,
  parseArguments,
  redact,
  safeJson,
} from "./protocol.js";

const PREFERENCES_KEY = "nyxid-chat:production-preferences:v3-oauth";
const THEME_KEY = "nyxid-chat-demo:theme";
const CORE_AUTHORIZATION_ATTEMPT_KEY = "nyxid-chat:core-authorization-attempt:v1";
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const surfaceLabels = {
  workflow: "Workflow API",
  "nyxid-chat": "NyxID Chat",
};

const surfacePaths = {
  workflow: "POST /api/chat",
  "nyxid-chat": "NyxIdChatGAgent",
};

const transportLabels = {
  "nyxid-oauth": "Authorized via NyxID",
};

const $ = (selector) => document.querySelector(selector);
const dom = {
  actorFact: $("#actorFact"),
  assistantNavButton: $("#assistantNavButton"),
  attachButton: $("#attachButton"),
  attachmentChip: $("#attachmentChip"),
  attachmentName: $("#attachmentName"),
  cancelSettingsButton: $("#cancelSettingsButton"),
  clearEventsButton: $("#clearEventsButton"),
  closeInspectorButton: $("#closeInspectorButton"),
  closeSettingsButton: $("#closeSettingsButton"),
  commandFact: $("#commandFact"),
  commandFactRow: $("#commandFactRow"),
  composerForm: $("#composerForm"),
  composerStatus: $("#composerStatus"),
  connectionButton: $("#connectionButton"),
  connectionDot: $("#connectionDot"),
  connectionTest: $("#connectionTest"),
  connectionText: $("#connectionText"),
  conversationTitle: $("#conversationTitle"),
  accountAvatar: $("#accountAvatar"),
  accountEmail: $("#accountEmail"),
  accountName: $("#accountName"),
  authGate: $("#authGate"),
  emptyState: $("#emptyState"),
  emptyDescription: $("#emptyDescription"),
  emptyLoginButton: $("#emptyLoginButton"),
  emptyTitle: $("#emptyTitle"),
  eventCount: $("#eventCount"),
  eventList: $("#eventList"),
  eventsPanel: $("#eventsPanel"),
  eventsTabButton: $("#eventsTabButton"),
  fileInput: $("#fileInput"),
  inspector: $("#inspector"),
  mobileBackdrop: $("#mobileBackdrop"),
  mobileInspectorButton: $("#mobileInspectorButton"),
  mobileMenuButton: $("#mobileMenuButton"),
  newChatButton: $("#newChatButton"),
  openSettingsNav: $("#openSettingsNav"),
  promptInput: $("#promptInput"),
  quickActions: $("#quickActions"),
  recentGroup: $("#recentGroup"),
  recentSessionsList: $("#recentSessionsList"),
  removeAttachmentButton: $("#removeAttachmentButton"),
  routeClientState: $("#routeClientState"),
  routeLabel: $("#routeLabel"),
  routeOrnnState: $("#routeOrnnState"),
  routeSurfaceValue: $("#routeSurfaceValue"),
  routeTransportValue: $("#routeTransportValue"),
  routeUpstreamState: $("#routeUpstreamState"),
  runFact: $("#runFact"),
  runFactRow: $("#runFactRow"),
  runPanel: $("#runPanel"),
  runStatus: $("#runStatus"),
  runTabButton: $("#runTabButton"),
  sendButton: $("#sendButton"),
  serviceCount: $("#serviceCount"),
  serviceList: $("#serviceList"),
  servicesButton: $("#servicesButton"),
  servicesCount: $("#servicesCount"),
  sessionFact: $("#sessionFact"),
  settingsButton: $("#settingsButton"),
  settingsDialog: $("#settingsDialog"),
  settingsForm: $("#settingsForm"),
  loginButton: $("#loginButton"),
  logoutButton: $("#logoutButton"),
  sidebar: $("#sidebar"),
  sidebarRuntimeDot: $("#sidebarRuntimeDot"),
  currentSessionButton: $("#currentSessionButton"),
  sidebarSessionMeta: $("#sidebarSessionMeta"),
  sidebarSessionTitle: $("#sidebarSessionTitle"),
  sidebarSurface: $("#sidebarSurface"),
  sidebarTransport: $("#sidebarTransport"),
  stepCount: $("#stepCount"),
  stepList: $("#stepList"),
  stopButton: $("#stopButton"),
  testConnectionButton: $("#testConnectionButton"),
  themeButton: $("#themeButton"),
  thread: $("#thread"),
  toast: $("#toast"),
  toastText: $("#toastText"),
  usageElapsed: $("#usageElapsed"),
  usageModel: $("#usageModel"),
  usageTokens: $("#usageTokens"),
  workflowField: $("#workflowField"),
  workflowInput: $("#workflowInput"),
};

const state = {
  config: {
    transport: "nyxid-oauth",
    surface: "nyxid-chat",
    directBaseUrl: "https://aevatar-console-backend-api.aevatar.ai",
    proxyBaseUrl: "https://nyx-api.chrono-ai.fun/api/v1/proxy/s/aevatar",
    ornnWebUrl: "https://ornn.chrono-ai.fun",
    scopeId: "",
    workflow: "direct",
  },
  auth: { authenticated: false, user: null, resources: [] },
  services: [],
  oauthPopup: null,
  sessionId: createId("session"),
  actorId: null,
  attachment: null,
  activeController: null,
  activeConversation: null,
  conversationStates: new Map(),
  conversations: [],
  conversationLoadSequence: 0,
  currentConversationMeta: null,
  health: null,
  historyError: null,
  historyLoading: false,
  historyRequestSequence: 0,
  historyRefreshTimer: null,
  run: createRunState(),
  toastTimer: null,
};

function createRunState() {
  return {
    status: "idle",
    surface: null,
    config: null,
    startedAt: null,
    completedAt: null,
    context: {},
    steps: new Map(),
    tools: new Map(),
    events: [],
    usage: null,
    pendingApproval: null,
    assistantBody: null,
    activityCard: null,
    activityStatus: null,
    assistantText: "",
    textElement: null,
    progressRow: null,
    progressLabel: null,
    progressTimers: [],
    approvalCard: null,
    authorizationPrompted: false,
    eventSequence: 0,
  };
}

let conversationContext = null;

function createConversationState({ actorId = null, meta = null, title = "新会话" } = {}) {
  const thread = el("div", "conversation-view");
  thread.hidden = true;
  const entry = {
    key: createId("conversation"),
    actorId,
    sessionId: createId("session"),
    meta,
    title,
    draft: "",
    attachment: null,
    run: createRunState(),
    controller: null,
    controllers: new Set(),
    thread,
    scrollTop: 0,
    backgroundUi: {
      routeOrnnState: el("span"),
      routeUpstreamState: el("span"),
      sidebarSessionMeta: el("span"),
    },
  };
  state.conversationStates.set(entry.key, entry);
  dom.threadViewport.append(thread);
  return entry;
}

function persistConversationState(entry = state.activeConversation) {
  if (!entry) return;
  entry.actorId = state.actorId;
  entry.sessionId = state.sessionId;
  entry.meta = state.currentConversationMeta;
  entry.attachment = state.attachment;
  entry.run = state.run;
  entry.controller = state.activeController;
  if (entry === state.activeConversation && isActiveConversationContext()) {
    entry.draft = dom.promptInput.value;
  }
}

function restoreConversationState(entry) {
  state.actorId = entry.actorId;
  state.sessionId = entry.sessionId;
  state.currentConversationMeta = entry.meta;
  state.attachment = entry.attachment;
  state.run = entry.run;
  state.activeController = entry.controller;
}

function withConversationState(entry, callback) {
  if (!entry) return callback();
  if (conversationContext === entry) return callback();

  // Frame handlers are synchronous, so legacy render helpers can be routed to
  // the owning conversation without exposing background state to the active UI.
  const previousContext = conversationContext;
  const active = state.activeConversation;
  if (entry === active) {
    conversationContext = entry;
    try {
      return callback();
    } finally {
      persistConversationState(entry);
      conversationContext = previousContext;
    }
  }

  persistConversationState(active);
  const snapshot = {
    actorId: state.actorId,
    sessionId: state.sessionId,
    currentConversationMeta: state.currentConversationMeta,
    attachment: state.attachment,
    run: state.run,
    activeController: state.activeController,
    thread: dom.thread,
    routeOrnnState: dom.routeOrnnState,
    routeUpstreamState: dom.routeUpstreamState,
    sidebarSessionMeta: dom.sidebarSessionMeta,
  };
  conversationContext = entry;
  restoreConversationState(entry);
  dom.thread = entry.thread;
  dom.routeOrnnState = entry.backgroundUi.routeOrnnState;
  dom.routeUpstreamState = entry.backgroundUi.routeUpstreamState;
  dom.sidebarSessionMeta = entry.backgroundUi.sidebarSessionMeta;
  try {
    return callback();
  } finally {
    persistConversationState(entry);
    state.actorId = snapshot.actorId;
    state.sessionId = snapshot.sessionId;
    state.currentConversationMeta = snapshot.currentConversationMeta;
    state.attachment = snapshot.attachment;
    state.run = snapshot.run;
    state.activeController = snapshot.activeController;
    dom.thread = snapshot.thread;
    dom.routeOrnnState = snapshot.routeOrnnState;
    dom.routeUpstreamState = snapshot.routeUpstreamState;
    dom.sidebarSessionMeta = snapshot.sidebarSessionMeta;
    conversationContext = previousContext;
  }
}

function isActiveConversationContext() {
  return !conversationContext || conversationContext === state.activeConversation;
}

function findConversationState(actorId) {
  return Array.from(state.conversationStates.values()).find((entry) => entry.actorId === actorId) || null;
}

function activateConversationState(entry) {
  if (!entry) return;
  persistConversationState();
  if (state.activeConversation) {
    state.activeConversation.scrollTop = dom.threadViewport.scrollTop;
    state.activeConversation.thread.hidden = true;
  }
  state.activeConversation = entry;
  entry.thread.hidden = false;
  dom.thread = entry.thread;
  restoreConversationState(entry);
  dom.promptInput.value = entry.draft;
  autoResizeComposer();
  renderAttachment();
  requestAnimationFrame(() => {
    dom.threadViewport.scrollTop = entry.scrollTop;
  });
}

function removeConversationState(entry) {
  if (!entry) return;
  abortConversationRun(entry);
  state.conversationStates.delete(entry.key);
  entry.thread.remove();
}

function initializeConversationStates() {
  dom.threadViewport = dom.thread;
  const emptyState = dom.emptyState;
  dom.threadViewport.replaceChildren();
  const initial = createConversationState();
  initial.thread.append(emptyState);
  initial.thread.hidden = false;
  state.activeConversation = initial;
  dom.thread = initial.thread;
  restoreConversationState(initial);
}

function createId(prefix) {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  return `${prefix}-${id}`;
}

initializeConversationStates();

function refreshIcons(root = document) {
  if (globalThis.lucide?.createIcons) {
    globalThis.lucide.createIcons({ attrs: { "aria-hidden": "true" }, root });
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function init() {
  applyTheme(readStorage(THEME_KEY) || "dark");
  configureMarkdown();
  bindEvents();
  refreshIcons();
  try {
    const response = await fetch("/api/demo/config", { cache: "no-store" });
    const remote = await response.json();
    const stored = readJsonStorage(PREFERENCES_KEY) || {};
    const storedSurface = Object.hasOwn(surfaceLabels, stored.surface) ? stored.surface : remote.surface;
    const storedWorkflow = new Set(["direct", "auto", "auto_review"]).has(stored.workflow)
      ? stored.workflow
      : remote.workflow;
    state.config = {
      ...state.config,
      ...remote,
      surface: storedSurface,
      workflow: storedWorkflow,
      transport: "nyxid-oauth",
      scopeId: "",
    };
  } catch (error) {
    showToast(`无法读取 demo 配置：${error.message}`);
  }
  await refreshAuthSession({ includeServices: true });
  updateConfigUi();
  renderInspector();
  if (state.auth.authenticated) await refreshRuntimeData();
}

function bindEvents() {
  dom.composerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendPrompt();
  });
  dom.promptInput.addEventListener("input", () => {
    if (state.activeConversation) state.activeConversation.draft = dom.promptInput.value;
    autoResizeComposer();
  });
  dom.promptInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendPrompt();
    }
  });
  dom.stopButton.addEventListener("click", cancelRun);
  dom.newChatButton.addEventListener("click", newChat);
  dom.assistantNavButton.addEventListener("click", focusCurrentConversation);
  dom.currentSessionButton.addEventListener("click", focusCurrentConversation);
  dom.settingsButton.addEventListener("click", openSettings);
  dom.openSettingsNav.addEventListener("click", openSettings);
  dom.servicesButton.addEventListener("click", openSettings);
  dom.connectionButton.addEventListener("click", openSettings);
  dom.closeSettingsButton.addEventListener("click", closeSettings);
  dom.cancelSettingsButton.addEventListener("click", closeSettings);
  dom.settingsForm.addEventListener("submit", saveSettings);
  dom.settingsForm.querySelectorAll('input[name="surface"]').forEach((input) => {
    input.addEventListener("change", updateSettingsVisibility);
  });
  dom.testConnectionButton.addEventListener("click", () => {
    if (state.auth.authenticated) void checkConnection(readSettingsForm(), true);
    else beginOAuth("/api/auth/login");
  });
  dom.loginButton.addEventListener("click", () => beginOAuth("/api/auth/login"));
  dom.emptyLoginButton.addEventListener("click", () => beginOAuth("/api/auth/login"));
  dom.logoutButton.addEventListener("click", () => void logout());
  dom.themeButton.addEventListener("click", toggleTheme);
  dom.attachButton.addEventListener("click", () => dom.fileInput.click());
  dom.fileInput.addEventListener("change", () => void selectAttachment());
  dom.removeAttachmentButton.addEventListener("click", clearAttachment);
  dom.runTabButton.addEventListener("click", () => setInspectorTab("run"));
  dom.eventsTabButton.addEventListener("click", () => setInspectorTab("events"));
  dom.clearEventsButton.addEventListener("click", clearEvents);
  dom.mobileMenuButton.addEventListener("click", () => openMobilePanel("sidebar"));
  dom.mobileInspectorButton.addEventListener("click", () => openMobilePanel("inspector"));
  dom.closeInspectorButton.addEventListener("click", closeMobilePanels);
  dom.mobileBackdrop.addEventListener("click", closeMobilePanels);
  document.querySelectorAll("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => void sendPrompt(button.dataset.prompt || ""));
  });
  window.addEventListener("message", (event) => void handleOAuthMessage(event));
  setInterval(updateElapsed, 1000);
}

function configureMarkdown() {
  globalThis.marked?.setOptions?.({
    gfm: true,
    breaks: true,
  });
}

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readJsonStorage(key) {
  const value = readStorage(key);
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage may be disabled; the demo remains usable for the current page.
  }
}

function readSessionStorage(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionStorage(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // A failed write only means the browser may ask again after a reload.
  }
}

function removeSessionStorage(key) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Storage may be disabled.
  }
}

function beginOAuth(path) {
  const width = 560;
  const height = 720;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
  const popup = window.open(
    path,
    "nyxid-oauth",
    `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
  );
  if (!popup) {
    window.location.assign(path);
    return;
  }
  state.oauthPopup = popup;
  popup.focus();
}

async function handleOAuthMessage(event) {
  if (event.origin !== window.location.origin || event.data?.type !== "nyxid-oauth") return;
  state.oauthPopup?.close();
  state.oauthPopup = null;
  if (event.data.status !== "success") {
    showToast(event.data.message || "NyxID 授权未完成。");
    return;
  }
  await refreshAuthSession({ includeServices: true });
  updateConfigUi();
  if (state.auth.authenticated) {
    showToast(event.data.message || "NyxID 授权已更新。");
    await refreshRuntimeData();
  }
}

async function refreshAuthSession({ includeServices = false } = {}) {
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    const payload = await response.json();
    state.auth = payload.authenticated
      ? payload
      : { authenticated: false, user: null, resources: [] };
    state.config.scopeId = payload.scopeId || "";
    if (state.auth.authenticated && includeServices) await loadServices();
    if (!state.auth.authenticated) state.services = [];
  } catch {
    state.auth = { authenticated: false, user: null, resources: [] };
    state.services = [];
    state.config.scopeId = "";
  }
  renderAuthUi();
  return state.auth;
}

async function loadServices() {
  if (!state.auth.authenticated) {
    state.services = [];
    renderServiceList();
    return;
  }
  dom.serviceList.replaceChildren(el("div", "service-access-empty", "正在读取 NyxID services…"));
  try {
    const response = await fetch("/api/auth/services", { cache: "no-store" });
    if (!response.ok) throw await responseError(response);
    const payload = await response.json();
    state.services = Array.isArray(payload.services) ? payload.services : [];
  } catch (error) {
    state.services = [];
    dom.serviceList.replaceChildren(el("div", "service-access-empty service-access-error", error.message));
    return;
  }
  renderServiceList();
  maybeAuthorizeMissingCoreServices();
}

function maybeAuthorizeMissingCoreServices() {
  const missing = state.services.filter((service) =>
    service.core && !service.authorized && service.active && service.available);
  if (!missing.length) {
    removeSessionStorage(CORE_AUTHORIZATION_ATTEMPT_KEY);
    return;
  }
  const attempt = JSON.stringify({
    subject: state.auth.user?.id || "",
    resources: missing.map((service) => service.resourceUri).sort(),
  });
  if (readSessionStorage(CORE_AUTHORIZATION_ATTEMPT_KEY) === attempt) return;

  writeSessionStorage(CORE_AUTHORIZATION_ATTEMPT_KEY, attempt);
  const query = new URLSearchParams();
  missing.forEach((service) => query.append("serviceId", service.id));
  beginOAuth(`/api/auth/authorize?${query.toString()}`);
}

function renderAuthUi() {
  const authenticated = state.auth.authenticated;
  const user = state.auth.user || {};
  dom.accountName.textContent = authenticated ? user.name || "NyxID user" : "尚未登录";
  dom.accountEmail.textContent = authenticated
    ? user.email || "已通过 NyxID 授权"
    : "连接 NyxID 后管理 service 授权";
  dom.accountAvatar.replaceChildren(authenticated
    ? el("span", "account-initial", (user.name || user.email || "N").slice(0, 1).toUpperCase())
    : iconNode("user-round"));
  dom.loginButton.classList.toggle("hidden", authenticated);
  dom.logoutButton.classList.toggle("hidden", !authenticated);
  dom.authGate.classList.toggle("hidden", authenticated);
  dom.quickActions.classList.toggle("hidden", !authenticated);
  dom.emptyTitle.textContent = authenticated ? "NyxID Assistant" : "连接你的 NyxID 账户";
  dom.emptyDescription.textContent = authenticated
    ? "今天要在 NyxID 上做什么？"
    : "授权 Aevatar 使用你明确选择的 NyxID services";
  dom.promptInput.disabled = !authenticated;
  dom.attachButton.disabled = !authenticated;
  dom.sendButton.disabled = !authenticated;
  dom.newChatButton.disabled = !authenticated;
  dom.promptInput.placeholder = authenticated
    ? "告诉 Assistant 你要完成的操作"
    : "请先使用 NyxID 登录";
  if (!authenticated) {
    setConnectionStatus("idle", "登录 NyxID");
    setRouteState(dom.routeUpstreamState, "waiting");
    setRouteState(dom.routeOrnnState, "waiting");
    dom.composerStatus.textContent = "登录后，Aevatar 仅能使用你授权的 services";
    state.conversations = [];
    state.historyError = null;
    state.historyLoading = false;
    renderHistoryList();
  }
  renderServiceList();
  refreshIcons(dom.settingsDialog);
}

function renderServiceList() {
  const services = state.services;
  const authorizedCount = services.filter((service) => service.authorized).length;
  dom.servicesCount.textContent = String(authorizedCount);
  dom.serviceCount.textContent = `${authorizedCount} / ${services.length}`;
  if (!state.auth.authenticated) {
    dom.serviceList.replaceChildren(el("div", "service-access-empty", "登录后显示 NyxID services"));
    return;
  }
  if (!services.length) {
    dom.serviceList.replaceChildren(el("div", "service-access-empty", "没有可用的 NyxID service"));
    return;
  }
  dom.serviceList.replaceChildren();
  for (const service of services) {
    const row = el("div", `service-access-row${service.authorized ? " authorized" : ""}`);
    const icon = el("span", "service-access-icon");
    icon.append(iconNode(service.authorized ? "shield-check" : "lock-keyhole"));
    const copy = el("div", "service-access-copy");
    copy.append(
      el("strong", "", service.label),
      el("small", "", service.core
        ? "Chat runtime · required"
        : `${service.slug}${service.sourceName ? ` · ${service.sourceName}` : ""}`),
    );
    const status = el(
      "span",
      `service-access-status ${service.authorized ? "granted" : ""}`,
      service.authorized ? "已授权" : "未授权",
    );
    row.append(icon, copy, status);
    if (!service.authorized && service.active && service.available) {
      const authorize = el("button", "service-authorize-button", "授权");
      authorize.type = "button";
      authorize.addEventListener("click", () => {
        beginOAuth(`/api/auth/authorize?serviceId=${encodeURIComponent(service.id)}`);
      });
      row.append(authorize);
    }
    dom.serviceList.append(row);
  }
  refreshIcons(dom.serviceList);
}

async function logout() {
  abortAllRuns();
  dom.logoutButton.disabled = true;
  try {
    await fetch("/api/auth/logout", { method: "POST", headers: demoHeaders() });
  } finally {
    dom.logoutButton.disabled = false;
    state.auth = { authenticated: false, user: null, resources: [] };
    state.services = [];
    state.config.scopeId = "";
    state.health = null;
    removeSessionStorage(CORE_AUTHORIZATION_ATTEMPT_KEY);
    closeSettings();
    newChat({ refreshHistory: false });
    for (const entry of Array.from(state.conversationStates.values())) {
      if (entry !== state.activeConversation) removeConversationState(entry);
    }
    renderAuthUi();
  }
}

function autoResizeComposer() {
  dom.promptInput.rows = 1;
  const styles = getComputedStyle(dom.promptInput);
  const lineHeight = Number.parseFloat(styles.lineHeight) || 20;
  const verticalPadding = (Number.parseFloat(styles.paddingTop) || 0) +
    (Number.parseFloat(styles.paddingBottom) || 0);
  const contentHeight = Math.max(lineHeight, dom.promptInput.scrollHeight - verticalPadding);
  dom.promptInput.rows = Math.max(1, Math.min(7, Math.ceil(contentHeight / lineHeight)));
}

function openSettings() {
  applyConfigToForm(state.config);
  updateSettingsVisibility();
  if (!dom.settingsDialog.open) dom.settingsDialog.showModal();
  if (state.auth.authenticated) void loadServices();
  closeMobilePanels();
  refreshIcons(dom.settingsDialog);
}

function closeSettings() {
  if (dom.settingsDialog.open) dom.settingsDialog.close();
}

function applyConfigToForm(config) {
  const surface = dom.settingsForm.querySelector(`input[name="surface"][value="${config.surface}"]`);
  if (surface) surface.checked = true;
  dom.workflowInput.value = config.workflow || "direct";
}

function readSettingsForm() {
  const surface = dom.settingsForm.querySelector('input[name="surface"]:checked')?.value || "workflow";
  return {
    ...state.config,
    surface,
    transport: "nyxid-oauth",
    workflow: dom.workflowInput.value,
  };
}

function updateSettingsVisibility() {
  const surface = dom.settingsForm.querySelector('input[name="surface"]:checked')?.value || "workflow";
  dom.workflowField.classList.toggle("hidden", surface !== "workflow");
}

function saveSettings(event) {
  event.preventDefault();
  const previousConfig = state.config;
  state.config = readSettingsForm();
  const persisted = {
    surface: state.config.surface,
    workflow: state.config.workflow,
  };
  writeStorage(PREFERENCES_KEY, JSON.stringify(persisted));
  const routeChanged = previousConfig.surface !== state.config.surface ||
    previousConfig.workflow !== state.config.workflow;
  if (routeChanged) newChat({ refreshHistory: false });
  updateConfigUi();
  closeSettings();
  void refreshRuntimeData();
}

async function refreshRuntimeData() {
  if (!state.auth.authenticated) return;
  await checkConnection(state.config, false);
  await loadConversations();
}

function updateConfigUi() {
  const surface = surfaceLabels[state.config.surface];
  const transport = transportLabels[state.config.transport];
  dom.sidebarSurface.textContent = surface;
  dom.sidebarTransport.textContent = transport;
  dom.routeTransportValue.textContent = transport;
  dom.routeSurfaceValue.textContent = surfacePaths[state.config.surface];
  dom.routeLabel.textContent = state.config.surface === "workflow"
    ? `${shortTransport()} · /api/chat`
    : `${shortTransport()} · NyxIdChat`;
  const isNyxIdChat = state.config.surface === "nyxid-chat";
  dom.recentGroup.classList.toggle("hidden", !isNyxIdChat);
  dom.runFactRow.classList.toggle("hidden", isNyxIdChat);
  dom.commandFactRow.classList.toggle("hidden", isNyxIdChat);
  dom.stopButton.setAttribute("aria-label", "停止接收");
  dom.stopButton.title = "停止接收（不会撤销已提交的生产操作）";
  dom.composerStatus.textContent = state.auth.authenticated
    ? "生产环境 · 仅可使用已授权 services，高风险操作需要确认"
    : "登录后，Aevatar 仅能使用你授权的 services";
  renderHistoryList();
}

function shortTransport() {
  return state.config.transport === "nyxid-oauth" ? "NyxID OAuth" : state.config.transport;
}

async function checkConnection(config, inDialog) {
  if (!state.auth.authenticated) {
    if (!inDialog) setConnectionStatus("idle", "登录 NyxID");
    if (inDialog) setDialogConnection("idle", "尚未连接", "登录后通过 NyxID OAuth 调用 Aevatar");
    return;
  }
  if (!inDialog) {
    setConnectionStatus("checking", "正在检查");
    if (!state.activeController) {
      setRouteState(dom.routeUpstreamState, "checking", "checking");
      setRouteState(dom.routeOrnnState, "checking", "checking");
    }
  }
  if (inDialog) setDialogConnection("checking", "正在测试", "等待响应");
  try {
    const response = await fetch("/api/demo/health", {
      method: "POST",
      headers: demoHeaders(config),
      body: JSON.stringify(configPayload(config)),
    });
    const result = await response.json();
    if (!inDialog) {
      state.health = result.components || null;
      applyHealthRouteState();
    }
    const detail = [
      result.latencyMs !== undefined ? `${result.latencyMs} ms` : "",
      result.detail || "",
    ].filter(Boolean).join(" · ");
    if (!response.ok || !result.ok) {
      if (!inDialog) setConnectionStatus("error", "Production degraded");
      if (inDialog) setDialogConnection("error", "连接异常", detail || `HTTP ${response.status}`);
      return;
    }
    const label = "Production connected";
    if (!inDialog) setConnectionStatus("ok", label);
    if (inDialog) {
      setDialogConnection("ok", label, detail);
    }
  } catch (error) {
    if (!inDialog) {
      state.health = null;
      setConnectionStatus("error", "Disconnected");
      if (!state.activeController) {
        setRouteState(dom.routeUpstreamState, "unavailable", "error");
        setRouteState(dom.routeOrnnState, "unavailable", "error");
      }
    }
    if (inDialog) setDialogConnection("error", "连接失败", error.message);
  }
}

function setRouteState(element, text, status = "") {
  element.textContent = text;
  element.className = `route-state ${status}`.trim();
}

function applyHealthRouteState({ includeAevatar = !state.activeController } = {}) {
  const aevatar = state.health?.aevatar;
  const ornn = state.health?.ornn;
  if (includeAevatar) {
    setRouteState(
      dom.routeUpstreamState,
      aevatar?.ok ? "ready" : "unavailable",
      aevatar?.ok ? "ok" : "error",
    );
  }
  const hasRunningOrnnTool = Array.from(state.run.tools.values()).some((tool) =>
    tool.status === "running" && /ornn_search_skills|use_skill/i.test(tool.name));
  if (!hasRunningOrnnTool && ornn?.status === "authorization-required") {
    setRouteState(dom.routeOrnnState, "authorization needed", "checking");
  } else if (!hasRunningOrnnTool) {
    setRouteState(
      dom.routeOrnnState,
      ornn?.ok ? "ready" : "unavailable",
      ornn?.ok ? "ok" : "error",
    );
  }
}

function setConnectionStatus(status, text) {
  dom.connectionDot.className = `status-dot ${status}`;
  dom.sidebarRuntimeDot.className = `status-dot ${status}`;
  dom.connectionText.textContent = text;
  dom.routeClientState.textContent = status === "ok" ? "ready" : status;
  const routeClass = status === "ok" ? "ok" : status === "error" ? "error" : status === "checking" ? "active" : "";
  dom.routeClientState.className = `route-state ${routeClass}`.trim();
}

function setDialogConnection(status, title, detail) {
  const dot = dom.connectionTest.querySelector(".status-dot");
  dot.className = `status-dot ${status}`;
  dom.connectionTest.querySelector("strong").textContent = title;
  const detailElement = dom.connectionTest.querySelector("small");
  detailElement.textContent = detail;
  detailElement.title = detail;
}

function configPayload(config) {
  return {
    surface: config.surface,
    workflow: config.workflow,
  };
}

function demoHeaders() {
  return { "Content-Type": "application/json" };
}

function historyUrl(actorId) {
  const params = new URLSearchParams({
    surface: "nyxid-chat",
    workflow: state.config.workflow,
  });
  const path = actorId
    ? `/api/demo/conversations/${encodeURIComponent(actorId)}`
    : "/api/demo/conversations";
  return `${path}?${params}`;
}

function historyConfigKey() {
  return [state.config.transport, state.config.scopeId, state.config.surface].join(":");
}

async function loadConversations({ silent = false } = {}) {
  if (!state.auth.authenticated || state.config.surface !== "nyxid-chat") {
    state.conversations = [];
    state.historyError = null;
    state.historyLoading = false;
    renderHistoryList();
    return;
  }
  const sequence = ++state.historyRequestSequence;
  const configKey = historyConfigKey();
  state.historyLoading = true;
  state.historyError = null;
  if (!silent) renderHistoryList();
  try {
    const response = await fetch(historyUrl(), {
      headers: demoHeaders(),
      cache: "no-store",
    });
    if (!response.ok) throw await responseError(response);
    const payload = await response.json();
    if (sequence !== state.historyRequestSequence || configKey !== historyConfigKey()) return;
    state.conversations = normalizeConversationIndex(payload)
      .filter((item) => !item.serviceKind || item.serviceKind === "nyxid.chat");
    for (const conversation of state.conversations) {
      const entry = findConversationState(conversation.id);
      if (!entry) continue;
      entry.meta = conversation;
      if (!entry.controller) entry.title = conversation.title;
    }
    const current = state.conversations.find((item) => item.id === state.actorId);
    if (current) {
      state.currentConversationMeta = current;
      if (state.activeConversation) state.activeConversation.meta = current;
      setConversationTitle(current.title);
      if (!state.activeController) {
        dom.sidebarSessionMeta.textContent = `${current.messageCount} 条消息 · ${formatHistoryTime(current.updatedAt)}`;
      }
    }
    state.historyError = null;
  } catch (error) {
    if (sequence !== state.historyRequestSequence || configKey !== historyConfigKey()) return;
    state.historyError = error.message || "无法读取生产会话";
  } finally {
    if (sequence === state.historyRequestSequence) {
      state.historyLoading = false;
      renderHistoryList();
    }
  }
}

function renderHistoryList() {
  if (!dom.recentSessionsList) return;
  dom.recentSessionsList.replaceChildren();
  if (state.config.surface !== "nyxid-chat") return;
  if (!state.auth.authenticated) {
    dom.recentSessionsList.append(el("div", "history-empty", "登录后显示会话"));
    return;
  }
  if (state.historyLoading && !state.conversations.length) {
    dom.recentSessionsList.append(el("div", "history-empty", "正在加载生产会话…"));
    return;
  }
  if (state.historyError) {
    const error = el("div", "history-error");
    error.append(el("span", "", state.historyError));
    const retry = el("button", "history-retry", "重试");
    retry.type = "button";
    retry.addEventListener("click", () => void loadConversations());
    error.append(retry);
    dom.recentSessionsList.append(error);
    return;
  }
  const recent = state.conversations;
  if (!recent.length) {
    dom.recentSessionsList.append(el("div", "history-empty", "暂无其他生产会话"));
    return;
  }
  for (const conversation of recent) {
    const row = el("div", `history-row${conversation.id === state.activeConversation?.actorId ? " active" : ""}`);
    const open = el("button", "history-session");
    open.type = "button";
    open.title = conversation.title;
    const copy = el("span", "history-session-copy");
    const conversationState = findConversationState(conversation.id);
    const running = Boolean(conversationState?.controller);
    copy.append(
      el("strong", "", conversation.title),
      el("small", "", `${conversation.messageCount} 条消息 · ${formatHistoryTime(conversation.updatedAt)}` +
        (conversationState?.run.pendingApproval ? " · 待确认" : running ? " · 运行中" : "")),
    );
    open.append(iconNode("message-circle"), copy);
    open.addEventListener("click", () => void loadConversation(conversation));
    const remove = el("button", "history-delete");
    remove.type = "button";
    remove.title = `删除 ${conversation.title}`;
    remove.setAttribute("aria-label", `删除会话：${conversation.title}`);
    remove.append(iconNode("trash-2"));
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteConversation(conversation, remove);
    });
    row.append(open, remove);
    dom.recentSessionsList.append(row);
  }
  refreshIcons(dom.recentSessionsList);
}

async function loadConversation(conversation) {
  const sequence = ++state.conversationLoadSequence;
  const cached = findConversationState(conversation.id);
  if (cached) {
    cached.meta = conversation;
    cached.title = conversation.title;
    activateConversationState(cached);
    renderActiveConversationState();
    closeMobilePanels();
    dom.promptInput.focus();
    return;
  }
  const configKey = historyConfigKey();
  try {
    const response = await fetch(historyUrl(conversation.id), {
      headers: demoHeaders(),
      cache: "no-store",
    });
    if (!response.ok) throw await responseError(response);
    const messages = normalizeStoredMessages(await response.json());
    if (sequence !== state.conversationLoadSequence || configKey !== historyConfigKey()) return;
    const existing = findConversationState(conversation.id);
    if (existing) {
      existing.meta = conversation;
      existing.title = conversation.title;
      activateConversationState(existing);
      renderActiveConversationState();
      closeMobilePanels();
      dom.promptInput.focus();
      return;
    }
    const entry = createConversationState({
      actorId: conversation.id,
      meta: conversation,
      title: conversation.title,
    });
    activateConversationState(entry);
    state.run.context = {
      actorId: conversation.id,
      sessionId: state.sessionId,
    };
    dom.thread.replaceChildren();
    for (const message of messages) renderStoredMessage(message);
    if (!messages.length) {
      const { body } = createMessageShell("assistant");
      body.append(el("div", "info-callout", "该生产会话目前没有已存储消息。"));
    }
    persistConversationState(entry);
    renderActiveConversationState();
    closeMobilePanels();
    refreshIcons(dom.thread);
    scrollThread();
    dom.promptInput.focus();
  } catch (error) {
    if (sequence !== state.conversationLoadSequence) return;
    showToast(error.message || "无法读取生产会话");
  }
}

function renderActiveConversationState() {
  const entry = state.activeConversation;
  if (!entry) return;
  const running = Boolean(entry.controller);
  setConversationTitle(entry.title || entry.meta?.title || "新会话");
  setRunningUi(running);
  const status = entry.run.pendingApproval ? "running" : entry.run.status;
  const labels = {
    idle: "Ready",
    running: entry.run.pendingApproval ? "Approval" : "Running",
    complete: "Complete",
    error: "Error",
    stopped: "Stopped",
    closed: "Closed",
  };
  setRunStatus(status, labels[status] || "Idle");
  dom.sidebarSessionMeta.textContent = entry.run.pendingApproval
    ? "Waiting for approval"
    : running
      ? "Running"
      : entry.meta
        ? `${entry.meta.messageCount} 条消息 · ${formatHistoryTime(entry.meta.updatedAt)}`
        : entry.run.startedAt
          ? labels[entry.run.status] || "Ready"
          : "尚未运行";
  if (running) setRouteState(dom.routeUpstreamState, "streaming", "active");
  else applyHealthRouteState();
  renderInspector();
  renderEventLog();
  renderHistoryList();
  renderAttachment();
  refreshIcons(entry.thread);
}

function renderStoredMessage(message) {
  const role = message.role === "user" ? "user" : "assistant";
  const { body } = createMessageShell(role);
  if (message.content) {
    const content = el("div", `message-text${role === "assistant" ? " markdown-body" : ""}`);
    if (role === "assistant") renderMarkdown(content, message.content);
    else content.textContent = message.content;
    body.append(content);
  }
  if (message.error) {
    const callout = el("div", "error-callout");
    callout.append(iconNode("circle-alert"), el("span", "", message.error));
    body.append(callout);
  }
}

async function deleteConversation(conversation, button) {
  const confirmed = globalThis.confirm(
    `确定删除生产会话“${conversation.title}”？\n\n这会删除 Aevatar 中的 NyxID Chat actor 和历史消息，无法撤销。`,
  );
  if (!confirmed) return;
  const entry = findConversationState(conversation.id);
  if (entry) abortConversationRun(entry);
  button.disabled = true;
  try {
    const response = await fetch(historyUrl(conversation.id), {
      method: "DELETE",
      headers: demoHeaders(),
    });
    if (!response.ok) throw await responseError(response);
    if (entry === state.activeConversation) {
      newChat({ refreshHistory: false });
      removeConversationState(entry);
    } else {
      removeConversationState(entry);
    }
    await loadConversations();
    showToast("生产会话已删除。");
  } catch (error) {
    button.disabled = false;
    showToast(error.message || "删除生产会话失败");
  }
}

function scheduleHistoryRefresh() {
  if (state.config.surface !== "nyxid-chat") return;
  void loadConversations({ silent: true });
  clearTimeout(state.historyRefreshTimer);
  state.historyRefreshTimer = setTimeout(() => {
    void loadConversations({ silent: true });
  }, 1500);
}

function focusCurrentConversation() {
  closeMobilePanels();
  dom.threadViewport.scrollTo({ top: dom.threadViewport.scrollHeight, behavior: "smooth" });
  dom.promptInput.focus();
}

function formatHistoryTime(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return date.toLocaleString("zh-CN", sameDay
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

async function sendPrompt(overridePrompt) {
  if (!state.auth.authenticated) {
    beginOAuth("/api/auth/login");
    return;
  }
  if (state.activeController) {
    showToast("当前运行尚未结束。");
    return;
  }
  const prompt = String(overridePrompt ?? dom.promptInput.value).trim();
  if (!prompt && !state.attachment) return;

  const conversation = state.activeConversation;
  state.run = createRunState();
  state.run.status = "running";
  state.run.surface = state.config.surface;
  state.run.config = configPayload(state.config);
  state.run.startedAt = Date.now();
  const controller = new AbortController();
  const run = state.run;
  const runSurface = state.config.surface;
  const requestConfig = state.run.config || configPayload(state.config);
  const requestSessionId = state.sessionId;
  const requestActorId = state.actorId;
  state.activeController = controller;
  conversation.controller = controller;
  conversation.controllers.add(controller);
  dom.emptyState.classList.add("hidden");
  const attachment = state.attachment;
  addUserMessage(prompt, attachment);
  if (!state.actorId) setConversationTitle(prompt || attachment?.name || "附件会话");
  dom.promptInput.value = "";
  conversation.draft = "";
  autoResizeComposer();
  clearAttachment();
  setRunningUi(true);
  setRunStatus("running", "Running");
  setRouteState(dom.routeUpstreamState, "streaming", "active");
  applyHealthRouteState();
  startRunProgress();
  renderInspector();
  persistConversationState(conversation);

  try {
    const response = await fetch("/api/demo/chat", {
      method: "POST",
      headers: demoHeaders(),
      signal: controller.signal,
      body: JSON.stringify({
        ...requestConfig,
        prompt,
        sessionId: requestSessionId,
        actorId: runSurface === "nyxid-chat" ? requestActorId : null,
        attachment,
      }),
    });
    if (!response.ok) throw await responseError(response);
    await consumeSse(response, async (raw) => {
      withConversationState(conversation, () => handleFrame(raw));
    });
    withConversationState(conversation, () => {
      if (state.run.status !== "running") return;
      state.run.status = "closed";
      state.run.completedAt = Date.now();
      removeRunProgress();
      finalizeRunningExecution("done", "Stream closed");
      setRunStatus("idle", "Closed");
      dom.sidebarSessionMeta.textContent = "Stream closed";
      addInfo("SSE 已关闭，但没有收到明确的终止事件。");
    });
  } catch (error) {
    const authExpired = error.code === "AUTH_REQUIRED" || error.code === "OAUTH_TOKEN_EXCHANGE_FAILED";
    withConversationState(conversation, () => {
      if (error.name === "AbortError") {
        state.run.status = "stopped";
        state.run.completedAt = Date.now();
        removeRunProgress();
        finalizeRunningExecution("error", "Stopped receiving");
        setRunStatus("idle", "Stopped");
        dom.sidebarSessionMeta.textContent = "Stopped receiving";
        addInfo("当前页面已停止接收。已提交的生产操作不会被自动撤销，上游 Agent 可能仍在执行。");
        return;
      }
      state.run.status = "error";
      state.run.completedAt = Date.now();
      removeRunProgress();
      finalizeRunningExecution("error", "Run failed");
      setRunStatus("error", "Error");
      dom.sidebarSessionMeta.textContent = "Failed";
      if (error.status === 403 || error.code === "SERVICE_NOT_AUTHORIZED") {
        addServiceAuthorizationPrompt(error.message || "此操作需要新的 service 权限。");
      } else if (!authExpired) {
        addError(error.message || "请求失败");
      }
    });
    if (authExpired) {
      await refreshAuthSession();
      withConversationState(conversation, () => {
        addServiceAuthorizationPrompt("NyxID 登录已失效，请重新授权。", { login: true });
      });
    }
  } finally {
    withConversationState(conversation, () => {
      clearRunProgressTimers(run);
      releaseConversationController(conversation, controller);
      setRunningUi(Boolean(state.activeController));
      setRouteState(
        dom.routeUpstreamState,
        state.run.status === "complete" ? "complete" : state.run.status,
        state.run.status === "complete" ? "ok" : state.run.status === "error" ? "error" : "",
      );
      applyHealthRouteState({ includeAevatar: false });
      renderInspector();
    });
    renderHistoryList();
    if (runSurface === "nyxid-chat") scheduleHistoryRefresh();
  }
}

async function responseError(response) {
  try {
    const payload = await response.json();
    const error = new Error(payload.message || payload.detail || payload.error || `HTTP ${response.status}`);
    error.code = payload.code || "";
    error.status = response.status;
    error.serviceSlug = payload.serviceSlug || payload.service_slug || "";
    return error;
  } catch {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    return error;
  }
}

function handleFrame(raw) {
  const event = normalizeFrame(raw);
  recordEvent(event, raw);
  switch (event.type) {
    case "run_context":
      state.run.context = { ...state.run.context, ...pickContext(event) };
      updateRunProgress("运行上下文已建立，Agent 正在分析请求…");
      break;
    case "conversation_context":
      state.actorId = event.actorId || state.actorId;
      state.run.context = { ...state.run.context, ...pickContext(event) };
      updateRunProgress("生产会话已创建，Agent 正在加载工具…");
      renderHistoryList();
      scheduleHistoryRefresh();
      break;
    case "run_started":
      state.run.context.actorId = event.actorId || event.threadId || state.run.context.actorId;
      state.run.context.runId = event.runId || state.run.context.runId;
      state.actorId = state.run.surface === "nyxid-chat"
        ? state.run.context.actorId || state.actorId
        : state.actorId;
      updateRunProgress("Agent 已启动，正在分析请求…");
      setRunStatus("running", "Running");
      break;
    case "step_started":
      startStep(event.stepName || "workflow-step", "step");
      break;
    case "step_finished":
      finishStep(event.stepName || "workflow-step", "step");
      break;
    case "step_request":
      state.run.context.runId = event.runId || state.run.context.runId;
      startStep(event.stepId || event.stepType || "step-request", "step");
      break;
    case "step_completed":
      state.run.context.runId = event.runId || state.run.context.runId;
      finishStep(event.stepId || "step-completed", "step", event.success === false ? "error" : "done");
      break;
    case "tool_start":
      removeRunProgress();
      addTool(event);
      break;
    case "tool_end":
      removeRunProgress();
      finishTool(event);
      break;
    case "role_chat_completed":
      removeRunProgress();
      applyRoleChatCompletion(event);
      break;
    case "text_start":
      removeRunProgress();
      startText();
      break;
    case "text_delta":
      removeRunProgress();
      appendText(event.delta || "");
      break;
    case "text_end":
      finishText();
      break;
    case "approval":
      removeRunProgress();
      renderApproval(event);
      break;
    case "authorization_required": {
      removeRunProgress();
      state.run.authorizationPrompted = true;
      const service = state.services.find((item) =>
        item.id === event.serviceId || item.slug === event.serviceSlug ||
        item.resourceUri === event.resource);
      addServiceAuthorizationPrompt(
        event.message || `授权 ${event.serviceLabel || event.serviceSlug || "此 service"} 后重试该请求。`,
        { serviceId: service?.id || event.serviceId || "" },
      );
      break;
    }
    case "usage":
      state.run.usage = mergeUsage(state.run.usage, event);
      break;
    case "reasoning":
      updateRunProgress("Agent 正在规划要执行的生产操作…");
      dom.sidebarSessionMeta.textContent = "Agent planning";
      break;
    case "media":
      removeRunProgress();
      renderMedia(event);
      break;
    case "run_finished":
      appendFallbackText(event.result?.output);
      completeRun();
      break;
    case "run_stopped":
      state.run.status = "stopped";
      state.run.completedAt = Date.now();
      removeRunProgress();
      finalizeRunningExecution("error", "Run stopped");
      setRunStatus("idle", "Stopped");
      dom.sidebarSessionMeta.textContent = "Stopped";
      break;
    case "run_error":
    case "protocol_error":
      state.run.status = "error";
      state.run.completedAt = Date.now();
      removeRunProgress();
      finalizeRunningExecution("error", "Run failed");
      setRunStatus("error", "Error");
      dom.sidebarSessionMeta.textContent = "Failed";
      addError(event.message || "Aevatar stream returned an error.");
      break;
    case "keepalive":
      updateRunProgress("Agent 仍在处理生产请求，请稍候…");
      dom.sidebarSessionMeta.textContent = "Running";
      break;
    default:
      break;
  }
  renderInspector();
}

function pickContext(event) {
  return {
    actorId: event.actorId,
    runId: event.runId,
    commandId: event.commandId,
    workflowName: event.workflowName,
    sessionId: event.sessionId,
  };
}

function recordEvent(event, raw) {
  state.run.eventSequence += 1;
  const safeRaw = event.type === "reasoning"
    ? { custom: { name: "aevatar.llm.reasoning", payload: "[not displayed]" } }
    : redact(raw);
  state.run.events.push({
    id: state.run.eventSequence,
    at: new Date(),
    type: event.type,
    raw: safeRaw,
  });
  if (state.run.events.length > 120) state.run.events.shift();
  renderEventLog();
}

function addUserMessage(prompt, attachment) {
  const { body } = createMessageShell("user");
  if (prompt) body.append(el("div", "message-text", prompt));
  if (attachment) {
    const file = el("div", "message-file");
    const icon = document.createElement("i");
    icon.dataset.lucide = "file";
    file.append(icon, el("span", "", attachment.name));
    body.append(file);
    refreshIcons(file);
  }
  scrollThread();
}

function createMessageShell(role) {
  const message = el("article", `message ${role}`);
  const avatar = el("div", "message-avatar");
  if (role === "assistant") {
    const icon = document.createElement("i");
    icon.dataset.lucide = "sparkles";
    avatar.append(icon);
  } else {
    avatar.textContent = "ME";
  }
  const body = el("div", "message-body");
  message.append(avatar, body);
  dom.thread.append(message);
  refreshIcons(message);
  return { message, body };
}

function ensureAssistantBody() {
  if (state.run.assistantBody?.isConnected) return state.run.assistantBody;
  state.run.assistantBody = createMessageShell("assistant").body;
  scrollThread();
  return state.run.assistantBody;
}

function ensureActivityCard() {
  if (state.run.activityCard?.isConnected) return state.run.activityCard;
  const card = el("div", "activity-card");
  const header = el("div", "activity-header");
  const icon = document.createElement("i");
  icon.dataset.lucide = "workflow";
  const label = el("span", "", "Execution");
  const status = el("span", "", "Running");
  header.append(icon, label, status);
  card.append(header);
  ensureAssistantBody().append(card);
  state.run.activityCard = card;
  state.run.activityStatus = status;
  refreshIcons(card);
  scrollThread();
  return card;
}

function startRunProgress() {
  const conversation = conversationContext || state.activeConversation;
  const card = ensureActivityCard();
  const row = el("div", "tool-row progress-row");
  const stateIcon = el("span", "tool-state-icon");
  stateIcon.append(iconNode("loader-circle"));
  const copy = el("div", "tool-copy");
  const label = el("small", "", state.actorId
    ? "正在连接现有生产会话…"
    : "正在连接 Aevatar 并创建生产会话…");
  copy.append(el("strong", "", surfaceLabels[state.config.surface]), label);
  row.append(stateIcon, copy, el("span", "tool-duration", "…"));
  card.append(row);
  state.run.progressRow = row;
  state.run.progressLabel = label;
  state.run.progressTimers = [
    setTimeout(() => {
      withConversationState(conversation, () => {
        updateRunProgress("Agent 正在分析请求，首次运行可能需要一些时间…");
      });
    }, 15_000),
    setTimeout(() => {
      withConversationState(conversation, () => {
        updateRunProgress("Agent 正在调用生产服务，仍在处理…");
      });
    }, 35_000),
  ];
  dom.sidebarSessionMeta.textContent = "Connecting to production";
  refreshIcons(row);
  scrollThread();
}

function updateRunProgress(message) {
  if (state.run.progressLabel?.isConnected) {
    state.run.progressLabel.textContent = message;
    dom.sidebarSessionMeta.textContent = "Running";
  }
}

function clearRunProgressTimers(run = state.run) {
  for (const timer of run.progressTimers) clearTimeout(timer);
  run.progressTimers = [];
}

function removeRunProgress() {
  clearRunProgressTimers();
  state.run.progressRow?.remove();
  state.run.progressRow = null;
  state.run.progressLabel = null;
  const card = state.run.activityCard;
  if (card?.isConnected && !card.querySelector(".tool-row")) {
    card.remove();
    state.run.activityCard = null;
    state.run.activityStatus = null;
  }
  if (state.run.assistantBody?.isConnected && !state.run.assistantBody.childElementCount) {
    state.run.assistantBody.closest(".message")?.remove();
    state.run.assistantBody = null;
  }
}

function addTool(event) {
  const id = event.toolCallId || createId("tool");
  if (state.run.tools.has(id)) return;
  const name = event.toolName || "tool";
  const card = ensureActivityCard();
  const row = el("div", "tool-row");
  row.dataset.toolCallId = id;
  const stateIcon = el("span", "tool-state-icon");
  const icon = document.createElement("i");
  icon.dataset.lucide = "loader-circle";
  stateIcon.append(icon);
  const copy = el("div", "tool-copy");
  copy.append(el("strong", "", name), el("small", "", "Running"));
  const duration = el("span", "tool-duration", "…");
  row.append(stateIcon, copy, duration);
  card.append(row);
  state.run.tools.set(id, {
    id,
    name,
    status: "running",
    startedAt: Date.now(),
    row,
    copy: copy.querySelector("small"),
    duration,
  });
  startStep(name, "tool", id);
  if (/ornn_search_skills|use_skill/i.test(name)) {
    dom.routeOrnnState.textContent = "active";
    dom.routeOrnnState.className = "route-state active";
  }
  refreshIcons(row);
  scrollThread();
}

function finishTool(event) {
  const id = event.toolCallId || "";
  const tool = state.run.tools.get(id);
  if (!tool) {
    addTool({ ...event, toolName: event.toolName || "tool" });
  }
  const resolved = state.run.tools.get(id) || Array.from(state.run.tools.values()).at(-1);
  if (!resolved) return;
  const status = String(event.status || "").toUpperCase();
  const succeeded = event.success !== false && !/(ERROR|DENIED)/.test(status);
  resolved.status = succeeded ? "done" : "error";
  resolved.completedAt = Date.now();
  resolved.row.classList.remove("done", "error");
  resolved.row.classList.add(resolved.status);
  resolved.row.querySelector(".tool-state-icon").replaceChildren(iconNode(succeeded ? "check" : "x"));
  resolved.copy.textContent = summarizeToolResult(event.result || event.error);
  const authorizationFailure = findServiceAuthorizationFailure(event.result || event.error);
  if (authorizationFailure && !state.run.authorizationPrompted) {
    state.run.authorizationPrompted = true;
    const service = state.services.find((item) => item.slug === authorizationFailure.serviceSlug);
    addServiceAuthorizationPrompt(authorizationFailure.message, { serviceId: service?.id || "" });
  }
  resolved.duration.textContent = formatDuration(resolved.completedAt - resolved.startedAt);
  finishStep(resolved.name, "tool", resolved.status, resolved.id);
  if (/ornn_search_skills|use_skill/i.test(resolved.name)) {
    applyHealthRouteState();
  }
  refreshIcons(resolved.row);
}

function findServiceAuthorizationFailure(value) {
  if (!value) return null;
  const text = safeJson(value, 0).toLowerCase();
  const matched = [
    "authorization_required",
    "service_not_authorized",
    "not authorized for this service",
    "not authorized for service",
    "does not have access to this service",
    "does not have access to service",
    "service access is not granted",
    "scoped api keys must use configured services",
    "invalid_target",
  ].some((marker) => text.includes(marker));
  if (!matched) return null;
  const slug = text.match(/(?:service|slug)[\s"':=]+([a-z0-9][a-z0-9-]{1,80})/)?.[1] || "";
  return {
    serviceSlug: slug,
    message: slug
      ? `Aevatar 需要 ${slug} 的权限。授权后请重试这条消息。`
      : "Aevatar 需要新的 NyxID service 权限。授权后请重试这条消息。",
  };
}

function finalizeRunningExecution(status, detail) {
  const completedAt = Date.now();
  for (const tool of state.run.tools.values()) {
    if (tool.status !== "running") continue;
    tool.status = status;
    tool.completedAt = completedAt;
    tool.row.classList.remove("done", "error");
    tool.row.classList.add(status);
    tool.row.querySelector(".tool-state-icon")?.replaceChildren(
      iconNode(status === "done" ? "check" : "x"),
    );
    tool.copy.textContent = detail;
    tool.duration.textContent = formatDuration(completedAt - tool.startedAt);
    finishStep(tool.name, "tool", status, tool.id);
    refreshIcons(tool.row);
  }
  for (const step of state.run.steps.values()) {
    if (step.status !== "running") continue;
    step.status = status;
    step.completedAt = completedAt;
  }
  if (state.run.activityStatus) {
    state.run.activityStatus.textContent = status === "done" ? "Complete" : "Ended";
  }
  applyHealthRouteState();
}

function applyRoleChatCompletion(event) {
  state.run.context.sessionId = event.sessionId || state.run.context.sessionId;
  const calls = Array.isArray(event.toolCalls) ? event.toolCalls : [];
  const receipts = Array.isArray(event.toolReceipts) ? event.toolReceipts : [];
  const receiptsById = new Map(receipts.map((receipt) => [receipt.callId, receipt]));

  for (const call of calls) {
    const receipt = receiptsById.get(call.callId);
    addTool({
      toolCallId: call.callId,
      toolName: call.toolName,
      argumentsJson: call.argumentsJson,
    });
    finishTool({
      toolCallId: call.callId,
      toolName: call.toolName,
      result: receipt?.resultJson,
      error: receipt?.errorMessage || receipt?.errorCode,
      status: receipt?.status,
      success: receipt ? !/(ERROR|DENIED)/i.test(String(receipt.status || "")) : true,
    });
  }

  for (const receipt of receipts) {
    if (calls.some((call) => call.callId === receipt.callId)) continue;
    addTool({ toolCallId: receipt.callId, toolName: receipt.toolName });
    finishTool({
      toolCallId: receipt.callId,
      toolName: receipt.toolName,
      result: receipt.resultJson,
      error: receipt.errorMessage || receipt.errorCode,
      status: receipt.status,
      success: !/(ERROR|DENIED)/i.test(String(receipt.status || "")),
    });
  }

  appendFallbackText(event.content);
  state.run.usage = mergeUsage(state.run.usage, {
    ...(event.usage || {}),
    model: event.model,
  });
}

function appendFallbackText(content) {
  if (!content || state.run.assistantText.trim()) return;
  appendText(content);
}

function summarizeToolResult(result) {
  if (result === undefined || result === null || result === "") return "Completed";
  const parsed = parseArguments(result);
  if (parsed && typeof parsed === "object") {
    const candidate = parsed.detail || parsed.message || parsed.error || parsed.status || parsed.result;
    if (candidate) return String(candidate).slice(0, 100);
  }
  const text = typeof parsed?.value === "string" ? parsed.value : String(result);
  return text.replace(/\s+/g, " ").slice(0, 100) || "Completed";
}

function startStep(name, kind, explicitId) {
  const key = explicitId || `${kind}:${name}`;
  if (state.run.steps.has(key)) return;
  state.run.steps.set(key, {
    key,
    name,
    kind,
    status: "running",
    startedAt: Date.now(),
  });
}

function finishStep(name, kind, status = "done", explicitId) {
  const key = explicitId || `${kind}:${name}`;
  const step = state.run.steps.get(key) || Array.from(state.run.steps.values()).find((item) => item.name === name && item.kind === kind);
  if (!step) {
    state.run.steps.set(key, {
      key,
      name,
      kind,
      status,
      startedAt: Date.now(),
      completedAt: Date.now(),
    });
    return;
  }
  step.status = status;
  step.completedAt = Date.now();
}

function startText() {
  if (state.run.textElement?.isConnected) return;
  state.run.textElement = el("div", "message-text markdown-body", "");
  ensureAssistantBody().append(state.run.textElement);
  scrollThread();
}

function appendText(delta) {
  if (!delta) return;
  startText();
  state.run.assistantText += String(delta);
  renderMarkdown(state.run.textElement, state.run.assistantText);
  scrollThread();
}

function finishText() {
  if (state.run.textElement && !state.run.assistantText.trim()) {
    state.run.textElement.remove();
    state.run.textElement = null;
  }
}

function renderMarkdown(target, source) {
  const text = String(source || "");
  if (!globalThis.marked?.parse || !globalThis.DOMPurify?.sanitize) {
    target.textContent = text;
    return;
  }
  const rendered = globalThis.marked.parse(text);
  target.innerHTML = globalThis.DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    FORBID_ATTR: ["style"],
  });
  for (const link of target.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
}

function renderApproval(event) {
  state.run.pendingApproval = event;
  state.run.context.runId = event.runId || state.run.context.runId;
  const card = el("section", "approval-card");
  const header = el("div", "approval-header");
  header.append(iconNode("shield-alert"), el("span", "", "需要确认"));
  const toolName = event.toolName || "workflow continuation";
  const description = event.prompt || `Agent 请求执行 ${toolName}`;
  const paragraph = el("p", "", description);
  const args = event.argumentsJson ? parseArguments(event.argumentsJson) : null;
  card.append(header, paragraph);
  if (args && Object.keys(args).length) card.append(el("pre", "", safeJson(args)));
  const actions = el("div", "approval-actions");
  const approve = el("button", "approve-button", "批准");
  approve.type = "button";
  const deny = el("button", "deny-button", "拒绝");
  deny.type = "button";
  const status = el("span", "approval-state", "Waiting");
  actions.append(approve, deny, status);
  card.append(actions);
  ensureAssistantBody().append(card);
  state.run.approvalCard = { card, approve, deny, status };
  approve.addEventListener("click", () => void submitApproval(true));
  deny.addEventListener("click", () => void submitApproval(false));
  setRunStatus("running", "Approval");
  dom.sidebarSessionMeta.textContent = "Waiting for approval";
  refreshIcons(card);
  scrollThread();
}

async function submitApproval(approved) {
  const conversation = state.activeConversation;
  const pending = state.run.pendingApproval;
  const card = state.run.approvalCard;
  if (!pending || !card) return;
  const controller = new AbortController();
  const requestConfig = state.run.config || configPayload(state.config);
  const request = {
    sessionId: state.sessionId,
    actorId: state.run.context.actorId || state.actorId,
    runId: pending.runId || state.run.context.runId,
    stepId: pending.stepId,
    commandId: pending.commandId || state.run.context.commandId,
    requestId: pending.requestId || pending.approvalRequestId,
    toolApproval: pending.toolApproval || null,
  };
  conversation.controllers.add(controller);
  if (!conversation.controller) {
    conversation.controller = controller;
    state.activeController = controller;
    setRunningUi(true);
  }
  card.approve.disabled = true;
  card.deny.disabled = true;
  card.status.textContent = "Submitting";
  try {
    const response = await fetch("/api/demo/approve", {
      method: "POST",
      headers: demoHeaders(),
      signal: controller.signal,
      body: JSON.stringify({
        ...requestConfig,
        ...request,
        approved,
        reason: approved ? "Approved by user" : "Denied by user",
      }),
    });
    if (!response.ok) throw await responseError(response);
    withConversationState(conversation, () => {
      card.status.textContent = approved ? "Approved" : "Denied";
      card.card.classList.add(approved ? "approved" : "denied");
      state.run.pendingApproval = null;
    });
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/event-stream")) {
      await consumeSse(response, async (raw) => {
        withConversationState(conversation, () => handleFrame(raw));
      });
    } else {
      await response.json().catch(() => null);
    }
  } catch (error) {
    withConversationState(conversation, () => {
      card.status.textContent = error.name === "AbortError" ? "Stopped" : "Failed";
      card.approve.disabled = false;
      card.deny.disabled = false;
      if (error.name !== "AbortError") addError(error.message || "审批提交失败");
    });
  } finally {
    withConversationState(conversation, () => {
      releaseConversationController(conversation, controller);
      setRunningUi(Boolean(state.activeController));
    });
    renderHistoryList();
  }
}

function renderMedia(event) {
  if (event.kind === "image") {
    const src = event.dataBase64
      ? `data:${event.mediaType || "image/png"};base64,${event.dataBase64}`
      : event.uri;
    if (src && /^(data:image\/|https:\/\/)/i.test(src)) {
      const image = el("img", "media-output");
      image.src = src;
      image.alt = event.name || event.text || "Agent output";
      ensureAssistantBody().append(image);
      scrollThread();
      return;
    }
  }
  addInfo(event.name ? `收到媒体输出：${event.name}` : "收到媒体输出。");
}

function addError(message) {
  const callout = el("div", "error-callout");
  callout.append(iconNode("circle-alert"), el("span", "", String(message).slice(0, 1000)));
  ensureAssistantBody().append(callout);
  refreshIcons(callout);
  scrollThread();
}

function addInfo(message) {
  const callout = el("div", "info-callout");
  callout.append(iconNode("info"), el("span", "", message));
  ensureAssistantBody().append(callout);
  refreshIcons(callout);
  scrollThread();
}

function addServiceAuthorizationPrompt(message, { login = false, serviceId = "" } = {}) {
  const callout = el("div", "authorization-callout");
  const copy = el("div", "authorization-callout-copy");
  copy.append(
    el("strong", "", login ? "需要 NyxID 登录" : "需要新的 Service 权限"),
    el("span", "", String(message).slice(0, 600)),
  );
  const action = el("button", "service-authorize-button", login ? "登录" : "查看 Services");
  action.type = "button";
  action.prepend(iconNode(login ? "log-in" : "shield-plus"));
  action.addEventListener("click", () => {
    if (login) beginOAuth("/api/auth/login");
    else if (serviceId) beginOAuth(`/api/auth/authorize?serviceId=${encodeURIComponent(serviceId)}`);
    else openSettings();
  });
  callout.append(iconNode("key-round"), copy, action);
  ensureAssistantBody().append(callout);
  refreshIcons(callout);
  scrollThread();
}

function completeRun() {
  state.run.status = "complete";
  state.run.completedAt = Date.now();
  state.run.pendingApproval = null;
  removeRunProgress();
  finalizeRunningExecution("done", "Completed with run");
  if (!state.run.assistantBody?.childElementCount) {
    addInfo("运行已完成，但 Aevatar 没有返回可展示的文本或工具结果。");
  }
  setRunStatus("complete", "Complete");
  dom.sidebarSessionMeta.textContent = "Completed";
  setRouteState(dom.routeUpstreamState, "complete", "ok");
}

function renderInspector() {
  if (!isActiveConversationContext()) return;
  const context = state.run.context;
  dom.actorFact.textContent = context.actorId || state.actorId || "—";
  dom.runFact.textContent = context.runId || "—";
  dom.commandFact.textContent = context.commandId || "—";
  dom.sessionFact.textContent = context.sessionId || state.sessionId;
  dom.usageTokens.textContent = state.run.usage?.totalTokens ?? "—";
  const model = state.run.usage?.model || state.currentConversationMeta?.llmModel;
  const hasConversationData = Boolean(state.run.startedAt || state.currentConversationMeta);
  dom.usageModel.textContent = model || (hasConversationData ? "not reported" : "—");
  renderSteps();
  updateElapsed();
}

function renderSteps() {
  dom.stepList.replaceChildren();
  const steps = Array.from(state.run.steps.values());
  dom.stepCount.textContent = String(steps.length);
  if (!steps.length) {
    dom.stepList.className = "step-list empty-list";
    if (state.config.surface === "nyxid-chat") {
      const labels = {
        idle: state.currentConversationMeta
          ? "已加载历史；发送消息可继续此会话"
          : "发送消息后显示真实工具调用",
        running: "Agent 正在处理，尚未调用可展示工具",
        complete: "本次运行未调用可展示工具",
        error: "运行失败前没有收到工具事件",
        stopped: "停止接收前没有收到工具事件",
        closed: "流关闭前没有收到工具事件",
      };
      dom.stepList.textContent = labels[state.run.status] || "没有可展示的工具步骤";
    } else {
      dom.stepList.textContent = state.run.status === "idle"
        ? "发送消息后显示 Workflow 步骤"
        : "尚未收到 Workflow 步骤事件";
    }
    return;
  }
  dom.stepList.className = "step-list";
  for (const step of steps) {
    const row = el("div", `inspector-step ${step.status}`);
    const dot = el("span", "step-dot");
    dot.append(iconNode(step.status === "done" ? "check" : step.status === "error" ? "x" : "loader-circle"));
    const name = el("strong", "", step.name);
    const elapsed = step.completedAt
      ? step.completedAt - step.startedAt
      : Date.now() - step.startedAt;
    row.append(dot, name, el("small", "", formatDuration(elapsed)));
    dom.stepList.append(row);
  }
  refreshIcons(dom.stepList);
}

function renderEventLog() {
  if (!isActiveConversationContext()) return;
  dom.eventCount.textContent = String(state.run.events.length);
  dom.eventList.replaceChildren();
  if (!state.run.events.length) {
    dom.eventList.append(el("div", "event-empty", "尚无事件"));
    return;
  }
  for (const event of [...state.run.events].reverse()) {
    const details = el("details", "event-row");
    const summary = document.createElement("summary");
    summary.append(
      el("span", "mono", `#${String(event.id).padStart(3, "0")}`),
      el("span", "event-kind", event.type),
      el("span", "mono", event.at.toLocaleTimeString("zh-CN", { hour12: false })),
    );
    details.append(summary, el("pre", "", safeJson(event.raw)));
    dom.eventList.append(details);
  }
}

function clearEvents() {
  state.run.events = [];
  renderEventLog();
}

function updateElapsed() {
  const start = state.run.startedAt;
  if (!start) {
    dom.usageElapsed.textContent = "00:00";
    return;
  }
  const end = state.run.completedAt || Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  dom.usageElapsed.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function setRunStatus(status, label) {
  if (!isActiveConversationContext()) return;
  dom.runStatus.className = `run-status ${status}`;
  dom.runStatus.querySelector("strong").textContent = label;
}

function setRunningUi(running) {
  if (!isActiveConversationContext()) return;
  const canCompose = state.auth.authenticated && !running;
  dom.sendButton.classList.toggle("hidden", running);
  dom.stopButton.classList.toggle("hidden", !running);
  dom.promptInput.disabled = !canCompose;
  dom.attachButton.disabled = !canCompose;
  dom.sendButton.disabled = !canCompose;
  dom.newChatButton.disabled = !state.auth.authenticated;
  dom.settingsButton.disabled = false;
  dom.openSettingsNav.disabled = false;
  dom.servicesButton.disabled = false;
  dom.connectionButton.disabled = false;
  if (!running) dom.stopButton.disabled = false;
  dom.composerStatus.textContent = running
    ? "正在接收生产 Agent 输出 · 停止接收不会撤销已提交操作"
    : state.auth.authenticated
      ? "生产环境 · 仅可使用已授权 services，高风险操作需要确认"
      : "登录后，Aevatar 仅能使用你授权的 services";
}

function cancelRun() {
  if (!state.activeController) return;
  dom.stopButton.disabled = true;
  dom.composerStatus.textContent = "正在停止当前页面接收…";
  abortConversationRun(state.activeConversation);
}

function abortConversationRun(entry) {
  if (!entry) return;
  for (const controller of entry.controllers) controller.abort();
  if (entry.controller && !entry.controllers.has(entry.controller)) entry.controller.abort();
}

function releaseConversationController(entry, controller) {
  entry.controllers.delete(controller);
  if (entry.controller !== controller) return;
  entry.controller = entry.controllers.values().next().value || null;
  state.activeController = entry.controller;
}

function abortAllRuns() {
  persistConversationState();
  for (const entry of state.conversationStates.values()) abortConversationRun(entry);
}

function newChat(options) {
  state.conversationLoadSequence += 1;
  const refreshHistory = options?.refreshHistory !== false;
  const previous = state.activeConversation;
  const discardPrevious = previous && !previous.actorId && !previous.controller && !previous.run.startedAt;
  const entry = createConversationState();
  entry.thread.append(dom.emptyState);
  activateConversationState(entry);
  if (discardPrevious) removeConversationState(previous);
  for (const candidate of Array.from(state.conversationStates.values())) {
    if (candidate === entry || candidate.actorId || candidate.controller || candidate.run.startedAt) continue;
    removeConversationState(candidate);
  }
  dom.emptyState.classList.remove("hidden");
  dom.promptInput.value = "";
  renderActiveConversationState();
  refreshIcons(dom.thread);
  closeMobilePanels();
  dom.promptInput.focus();
  if (refreshHistory) void loadConversations({ silent: true });
}

function setConversationTitle(value) {
  const normalized = String(value).replace(/\s+/g, " ").trim();
  const title = normalized.length > 32 ? `${normalized.slice(0, 32)}…` : normalized || "新会话";
  const entry = conversationContext || state.activeConversation;
  if (entry) entry.title = title;
  if (!isActiveConversationContext()) return;
  dom.conversationTitle.textContent = title;
  dom.sidebarSessionTitle.textContent = title;
}

async function selectAttachment() {
  const conversation = state.activeConversation;
  const file = dom.fileInput.files?.[0];
  if (!file) return;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    showToast("附件不能超过 5 MB。");
    dom.fileInput.value = "";
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  const attachment = {
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    dataBase64: btoa(binary),
  };
  withConversationState(conversation, () => {
    state.attachment = attachment;
    renderAttachment();
  });
}

function clearAttachment() {
  state.attachment = null;
  if (conversationContext || state.activeConversation) {
    (conversationContext || state.activeConversation).attachment = null;
  }
  dom.fileInput.value = "";
  dom.attachmentChip.classList.add("hidden");
}

function renderAttachment() {
  if (!isActiveConversationContext()) return;
  dom.fileInput.value = "";
  if (!state.attachment) {
    dom.attachmentChip.classList.add("hidden");
    return;
  }
  dom.attachmentName.textContent = `${state.attachment.name} · ${formatBytes(state.attachment.sizeBytes)}`;
  dom.attachmentChip.classList.remove("hidden");
  refreshIcons(dom.attachmentChip);
}

function setInspectorTab(tab) {
  const events = tab === "events";
  dom.runPanel.classList.toggle("hidden", events);
  dom.eventsPanel.classList.toggle("hidden", !events);
  dom.runTabButton.classList.toggle("active", !events);
  dom.eventsTabButton.classList.toggle("active", events);
  dom.runTabButton.setAttribute("aria-selected", String(!events));
  dom.eventsTabButton.setAttribute("aria-selected", String(events));
}

function openMobilePanel(panel) {
  dom.sidebar.classList.toggle("open", panel === "sidebar");
  dom.inspector.classList.toggle("open", panel === "inspector");
  dom.mobileBackdrop.classList.remove("hidden");
}

function closeMobilePanels() {
  dom.sidebar.classList.remove("open");
  dom.inspector.classList.remove("open");
  dom.mobileBackdrop.classList.add("hidden");
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applyTheme(next);
  writeStorage(THEME_KEY, next);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}

function iconNode(name) {
  const icon = document.createElement("i");
  icon.dataset.lucide = name;
  return icon;
}

function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${Math.max(0, milliseconds)}ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function scrollThread() {
  if (!isActiveConversationContext()) return;
  const viewport = dom.threadViewport;
  requestAnimationFrame(() => {
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  });
}

function showToast(message) {
  dom.toastText.textContent = message;
  dom.toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => dom.toast.classList.remove("show"), 3200);
}

void init();
