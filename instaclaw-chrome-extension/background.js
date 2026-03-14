/**
 * InstaClaw Browser Relay — Service Worker (background.js)
 *
 * Forked from OpenClaw chrome-extension (2026.2.24).
 * Modified for remote VM access via Caddy WSS tunnel + auto-attach all tabs.
 *
 * Protocol: matches official OpenClaw relay exactly —
 *   - connect.challenge / connect handshake (type: 'req'/'res'/'event' envelope)
 *   - Target.attachedToTarget with real targetId from Target.getTargetInfo
 *   - Target.detachedFromTarget for cleanup
 *   - forwardCDPCommand / forwardCDPEvent for CDP forwarding
 *   - cb-tab-{N} session ID format
 */

// --- Constants ---
const RELAY_PORT = 18792;
const RELAY_MESSAGE_PREFIX = "openclaw-extension-relay-v1";
const MAX_RECONNECT_DELAY_MS = 30000;
const NAV_REATTACH_DELAYS = [200, 500, 1000, 2000, 4000];

// --- State ---
/** @type {WebSocket|null} */
let relayWs = null;
/** @type {Promise<void>|null} */
let relayConnectPromise = null;
let relayGatewayToken = "";
/** @type {string|null} */
let relayConnectRequestId = null;
let nextSession = 1;
let reconnectAttempt = 0;
let reconnectTimer = null;

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string}>} */
const tabs = new Map();
/** @type {Map<string, number>} */
const tabBySession = new Map();
/** @type {Map<string, number>} */
const childSessionToTab = new Map();
/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map();
/** @type {Set<number>} */
const tabOperationLocks = new Set();
/** @type {Set<number>} */
const reattachPending = new Set();

// --- HMAC Token Derivation ---
async function deriveRelayToken(gatewayToken) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(gatewayToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const message = `${RELAY_MESSAGE_PREFIX}:${RELAY_PORT}`;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- Settings ---
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["gatewayUrl", "gatewayToken"], (data) => {
      resolve(data);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingTabError(err) {
  const message = (err instanceof Error ? err.message : String(err || "")).toLowerCase();
  return (
    message.includes("no tab with id") ||
    message.includes("no tab with given id") ||
    message.includes("tab not found")
  );
}

function isLastRemainingTab(allTabs, tabIdToClose) {
  if (!Array.isArray(allTabs)) return true;
  return allTabs.filter((tab) => tab && tab.id !== tabIdToClose).length === 0;
}

function reconnectDelayMs(attempt) {
  const backoff = Math.min(1000 * Math.pow(2, Math.max(0, attempt)), MAX_RECONNECT_DELAY_MS);
  return backoff + 1000 * Math.random();
}

// --- Badge ---
const BADGE = {
  on: { text: "ON", color: "#FF5A36" },
  off: { text: "", color: "#000000" },
  connecting: { text: "…", color: "#F59E0B" },
  error: { text: "!", color: "#B91C1C" },
};

function setBadge(tabId, kind) {
  const cfg = BADGE[kind];
  void chrome.action.setBadgeText({ tabId, text: cfg.text });
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color });
  void chrome.action.setBadgeTextColor({ tabId, color: "#FFFFFF" }).catch(() => {});
}

// --- Relay Send ---
function sendToRelay(payload) {
  const ws = relayWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("Relay not connected");
  }
  ws.send(JSON.stringify(payload));
}

// --- State Persistence (MV3) ---
async function persistState() {
  try {
    const tabEntries = [];
    for (const [tabId, tab] of tabs.entries()) {
      if (tab.state === "connected" && tab.sessionId && tab.targetId) {
        tabEntries.push({ tabId, sessionId: tab.sessionId, targetId: tab.targetId });
      }
    }
    await chrome.storage.session.set({ persistedTabs: tabEntries, nextSession });
  } catch {
    // chrome.storage.session may not be available
  }
}

async function rehydrateState() {
  try {
    const stored = await chrome.storage.session.get(["persistedTabs", "nextSession"]);
    if (stored.nextSession) {
      nextSession = Math.max(nextSession, stored.nextSession);
    }
    const entries = stored.persistedTabs || [];
    for (const entry of entries) {
      tabs.set(entry.tabId, {
        state: "connected",
        sessionId: entry.sessionId,
        targetId: entry.targetId,
      });
      tabBySession.set(entry.sessionId, entry.tabId);
      setBadge(entry.tabId, "on");
    }
    // Validate tabs are still alive
    for (const entry of entries) {
      try {
        await chrome.tabs.get(entry.tabId);
        // Also verify debugger is still attached
        await chrome.debugger.sendCommand({ tabId: entry.tabId }, "Runtime.evaluate", {
          expression: "1",
          returnByValue: true,
        });
      } catch {
        tabs.delete(entry.tabId);
        tabBySession.delete(entry.sessionId);
        setBadge(entry.tabId, "off");
      }
    }
  } catch {
    // Fresh start
  }
}

// --- WebSocket Connection ---
async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return;
  if (relayConnectPromise) return await relayConnectPromise;

  relayConnectPromise = (async () => {
    const { gatewayUrl, gatewayToken } = await getSettings();
    if (!gatewayUrl || !gatewayToken) {
      throw new Error("No gateway URL/token configured. Open extension options.");
    }

    const relayToken = await deriveRelayToken(gatewayToken);
    // Remote WSS via Caddy tunnel (not localhost)
    const wsUrl = `${gatewayUrl.replace(/^http/, "ws")}/relay/extension?token=${relayToken}`;

    // Preflight check
    try {
      await fetch(`${gatewayUrl}/relay/`, { method: "HEAD", signal: AbortSignal.timeout(3000) });
    } catch (err) {
      throw new Error(`Relay not reachable at ${gatewayUrl}/relay/ (${String(err)})`);
    }

    const ws = new WebSocket(wsUrl);
    relayWs = ws;
    relayGatewayToken = gatewayToken;

    // Bind message handler before open so connect.challenge isn't missed
    ws.onmessage = (event) => {
      if (ws !== relayWs) return;
      void whenReady(() => onRelayMessage(String(event.data || "")));
    };

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error("WebSocket connect failed")); };
      ws.onclose = (ev) => { clearTimeout(t); reject(new Error(`WebSocket closed (${ev.code})`)); };
    });

    // Permanent handlers — guard against stale socket
    ws.onclose = () => { if (ws === relayWs) onRelayClosed("closed"); };
    ws.onerror = () => { if (ws === relayWs) onRelayClosed("error"); };

    console.log("[InstaClaw Relay] WebSocket connected to", gatewayUrl);
  })();

  try {
    await relayConnectPromise;
    reconnectAttempt = 0;
  } finally {
    relayConnectPromise = null;
  }
}

function onRelayClosed(reason) {
  relayWs = null;
  relayGatewayToken = "";
  relayConnectRequestId = null;

  for (const [id, p] of pending.entries()) {
    pending.delete(id);
    p.reject(new Error(`Relay disconnected (${reason})`));
  }
  reattachPending.clear();

  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === "connected") {
      setBadge(tabId, "connecting");
    }
  }

  console.log(`[InstaClaw Relay] Disconnected (${reason}), scheduling reconnect`);
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const delay = reconnectDelayMs(reconnectAttempt);
  reconnectAttempt++;
  console.log(`[InstaClaw Relay] Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await ensureRelayConnection();
      reconnectAttempt = 0;
      await reannounceAttachedTabs();
    } catch (err) {
      console.warn(`[InstaClaw Relay] Reconnect failed:`, err instanceof Error ? err.message : String(err));
      scheduleReconnect();
    }
  }, delay);
}

// --- Gateway Handshake (matches official protocol exactly) ---
function ensureGatewayHandshakeStarted(payload) {
  if (relayConnectRequestId) return;
  const nonce = typeof payload?.nonce === "string" ? payload.nonce.trim() : "";
  relayConnectRequestId = `ext-connect-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  sendToRelay({
    type: "req",
    id: relayConnectRequestId,
    method: "connect",
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "chrome-relay-extension",
        version: "1.0.0",
        platform: "chrome-extension",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      caps: [],
      commands: [],
      nonce: nonce || undefined,
      auth: relayGatewayToken ? { token: relayGatewayToken } : undefined,
    },
  });
}

// --- Relay Message Handling ---
async function onRelayMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }

  // Gateway connect challenge
  if (msg && msg.type === "event" && msg.event === "connect.challenge") {
    try {
      ensureGatewayHandshakeStarted(msg.payload);
    } catch (err) {
      console.warn("[InstaClaw Relay] Handshake start failed:", err instanceof Error ? err.message : String(err));
      relayConnectRequestId = null;
      if (relayWs && relayWs.readyState === WebSocket.OPEN) {
        relayWs.close(1008, "gateway connect failed");
      }
    }
    return;
  }

  // Gateway connect response
  if (msg && msg.type === "res" && relayConnectRequestId && msg.id === relayConnectRequestId) {
    relayConnectRequestId = null;
    if (!msg.ok) {
      const detail = msg?.error?.message || msg?.error || "gateway connect failed";
      console.warn("[InstaClaw Relay] Handshake rejected:", String(detail));
      if (relayWs && relayWs.readyState === WebSocket.OPEN) {
        relayWs.close(1008, "gateway connect failed");
      }
    }
    return;
  }

  // Ping/pong
  if (msg && msg.method === "ping") {
    try { sendToRelay({ method: "pong" }); } catch { /* ignore */ }
    return;
  }

  // Response to our pending requests
  if (msg && typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(String(msg.error)));
    else p.resolve(msg.result);
    return;
  }

  // CDP command forwarding from relay
  if (msg && typeof msg.id === "number" && msg.method === "forwardCDPCommand") {
    try {
      const result = await handleForwardCdpCommand(msg);
      sendToRelay({ id: msg.id, result });
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// --- Tab Lookup ---
function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId);
  if (direct) return { tabId: direct, kind: "main" };
  const child = childSessionToTab.get(sessionId);
  if (child) return { tabId: child, kind: "child" };
  return null;
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId;
  }
  return null;
}

// --- Attach / Detach (matches official protocol) ---
async function attachTab(tabId, opts = {}) {
  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, "1.3");
  await chrome.debugger.sendCommand(debuggee, "Page.enable").catch(() => {});

  // Get real targetId from Chrome — this is what the relay expects
  const info = /** @type {any} */ (await chrome.debugger.sendCommand(debuggee, "Target.getTargetInfo"));
  const targetInfo = info?.targetInfo;
  const targetId = String(targetInfo?.targetId || "").trim();
  if (!targetId) {
    throw new Error("Target.getTargetInfo returned no targetId");
  }

  const sid = nextSession++;
  const sessionId = `cb-tab-${sid}`;

  tabs.set(tabId, { state: "connected", sessionId, targetId });
  tabBySession.set(sessionId, tabId);

  // Send Target.attachedToTarget to relay — this registers the target in /json/list
  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: "forwardCDPEvent",
      params: {
        method: "Target.attachedToTarget",
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    });
  }

  setBadge(tabId, "on");
  await persistState();

  console.log(`[InstaClaw Relay] Attached tab ${tabId} (session: ${sessionId}, target: ${targetId})`);
  return { sessionId, targetId };
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId);

  // Detach child sessions first
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) {
      try {
        sendToRelay({
          method: "forwardCDPEvent",
          params: {
            method: "Target.detachedFromTarget",
            params: { sessionId: childSessionId, reason: "parent_detached" },
          },
        });
      } catch { /* relay may be down */ }
      childSessionToTab.delete(childSessionId);
    }
  }

  // Send Target.detachedFromTarget for main session
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: "forwardCDPEvent",
        params: {
          method: "Target.detachedFromTarget",
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      });
    } catch { /* relay may be down */ }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId);
  tabs.delete(tabId);

  try { await chrome.debugger.detach({ tabId }); } catch { /* may already be detached */ }

  setBadge(tabId, "off");
  await persistState();
}

// --- Re-announce after reconnect ---
async function reannounceAttachedTabs() {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state !== "connected" || !tab.sessionId || !tab.targetId) continue;

    // Validate tab is still alive
    try {
      await chrome.tabs.get(tabId);
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: "1", returnByValue: true,
      });
    } catch {
      tabs.delete(tabId);
      if (tab.sessionId) tabBySession.delete(tab.sessionId);
      setBadge(tabId, "off");
      continue;
    }

    // Get fresh targetInfo
    let targetInfo;
    try {
      const info = /** @type {any} */ (await chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo"));
      targetInfo = info?.targetInfo;
    } catch {
      targetInfo = tab.targetId ? { targetId: tab.targetId } : undefined;
    }

    try {
      sendToRelay({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: tab.sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      });
      setBadge(tabId, "on");
    } catch {
      setBadge(tabId, "connecting");
    }
  }
  await persistState();
}

// --- CDP Command Handling ---
async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || "").trim();
  const params = msg?.params?.params || undefined;
  const sessionId = typeof msg?.params?.sessionId === "string" ? msg.params.sessionId : undefined;

  const bySession = sessionId ? getTabBySessionId(sessionId) : null;
  const targetId = typeof params?.targetId === "string" ? params.targetId : undefined;
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      // Fallback: use first connected tab
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === "connected") return id;
      }
      return null;
    })();

  if (!tabId) throw new Error(`No attached tab for method ${method}`);

  const debuggee = { tabId };

  // Runtime.enable needs disable-first to avoid stale state
  if (method === "Runtime.enable") {
    try {
      await chrome.debugger.sendCommand(debuggee, "Runtime.disable");
      await sleep(50);
    } catch { /* ignore */ }
    return await chrome.debugger.sendCommand(debuggee, "Runtime.enable", params);
  }

  // Target.createTarget — open a new tab and attach
  if (method === "Target.createTarget") {
    const url = typeof params?.url === "string" ? params.url : "about:blank";
    const newTab = await chrome.tabs.create({ url, active: false });
    if (!newTab.id) throw new Error("Failed to create tab");
    await sleep(100);
    const attached = await attachTab(newTab.id);
    return { targetId: attached.targetId };
  }

  // Target.closeTarget
  if (method === "Target.closeTarget") {
    const target = typeof params?.targetId === "string" ? params.targetId : "";
    const toClose = target ? getTabByTargetId(target) : tabId;
    if (!toClose) return { success: false };
    try {
      const allTabs = await chrome.tabs.query({});
      if (isLastRemainingTab(allTabs, toClose)) {
        return { success: false, error: "Cannot close the last tab" };
      }
      await chrome.tabs.remove(toClose);
    } catch {
      return { success: false };
    }
    return { success: true };
  }

  // Target.activateTarget
  if (method === "Target.activateTarget") {
    const target = typeof params?.targetId === "string" ? params.targetId : "";
    const toActivate = target ? getTabByTargetId(target) : tabId;
    if (!toActivate) return {};
    const tab = await chrome.tabs.get(toActivate).catch(() => null);
    if (!tab) return {};
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {});
    return {};
  }

  // Regular CDP command — forward to the right tab with session routing
  const tabState = tabs.get(tabId);
  const mainSessionId = tabState?.sessionId;
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee;

  return await chrome.debugger.sendCommand(debuggerSession, method, params);
}

// --- Debugger Event Forwarding ---
function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId;
  if (!tabId) return;
  const tab = tabs.get(tabId);
  if (!tab?.sessionId) return;

  // Track child sessions
  if (method === "Target.attachedToTarget" && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId);
  }
  if (method === "Target.detachedFromTarget" && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId));
  }

  try {
    sendToRelay({
      method: "forwardCDPEvent",
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    });
  } catch { /* relay may be down */ }
}

async function onDebuggerDetach(source, reason) {
  const tabId = source.tabId;
  if (!tabId) return;
  if (!tabs.has(tabId)) return;

  // User cancelled or DevTools replaced — respect intent
  if (reason === "canceled_by_user" || reason === "replaced_with_devtools") {
    void detachTab(tabId, reason);
    return;
  }

  // Check if tab still exists
  let tabInfo;
  try { tabInfo = await chrome.tabs.get(tabId); } catch {
    void detachTab(tabId, reason);
    return;
  }

  if (tabInfo.url?.startsWith("chrome://") || tabInfo.url?.startsWith("chrome-extension://")) {
    void detachTab(tabId, reason);
    return;
  }

  if (reattachPending.has(tabId)) return;

  // Navigation detach — send Target.detachedFromTarget then try to re-attach
  const oldTab = tabs.get(tabId);
  const oldSessionId = oldTab?.sessionId;
  const oldTargetId = oldTab?.targetId;

  if (oldSessionId) tabBySession.delete(oldSessionId);
  tabs.delete(tabId);
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId);
  }

  if (oldSessionId && oldTargetId) {
    try {
      sendToRelay({
        method: "forwardCDPEvent",
        params: {
          method: "Target.detachedFromTarget",
          params: { sessionId: oldSessionId, targetId: oldTargetId, reason: "navigation-reattach" },
        },
      });
    } catch { /* relay may be down */ }
  }

  reattachPending.add(tabId);
  setBadge(tabId, "connecting");

  for (let attempt = 0; attempt < NAV_REATTACH_DELAYS.length; attempt++) {
    await sleep(NAV_REATTACH_DELAYS[attempt]);
    if (!reattachPending.has(tabId)) return;
    try { await chrome.tabs.get(tabId); } catch {
      reattachPending.delete(tabId);
      setBadge(tabId, "off");
      return;
    }
    const relayUp = relayWs && relayWs.readyState === WebSocket.OPEN;
    try {
      await attachTab(tabId, { skipAttachedEvent: !relayUp });
      reattachPending.delete(tabId);
      if (!relayUp) setBadge(tabId, "connecting");
      return;
    } catch { /* continue retries */ }
  }

  reattachPending.delete(tabId);
  setBadge(tabId, "off");
  console.warn(`[InstaClaw Relay] Re-attach failed for tab ${tabId}`);
}

// --- Auto-Attach All Tabs ---
async function autoAttachAllTabs() {
  try {
    const allTabs = await chrome.tabs.query({});
    for (const tab of allTabs) {
      if (!tab.id) continue;
      if (tabs.has(tab.id)) continue; // Already attached
      if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) continue;
      if (tabOperationLocks.has(tab.id)) continue;

      tabOperationLocks.add(tab.id);
      try {
        await attachTab(tab.id);
      } catch (err) {
        if (!err.message?.includes("Already attached")) {
          console.warn(`[InstaClaw Relay] Cannot attach tab ${tab.id}:`, err.message);
        }
      } finally {
        tabOperationLocks.delete(tab.id);
      }
    }
  } catch (err) {
    console.error("[InstaClaw Relay] Auto-attach failed:", err);
  }
}

// --- Tab Lifecycle Listeners ---
chrome.tabs.onRemoved.addListener((tabId) => void whenReady(() => {
  reattachPending.delete(tabId);
  if (!tabs.has(tabId)) return;
  const tab = tabs.get(tabId);
  if (tab?.sessionId) tabBySession.delete(tab.sessionId);
  tabs.delete(tabId);
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId);
  }
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: "forwardCDPEvent",
        params: {
          method: "Target.detachedFromTarget",
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason: "tab_closed" },
        },
      });
    } catch { /* relay may be down */ }
  }
  void persistState();
}));

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => void whenReady(() => {
  const tab = tabs.get(removedTabId);
  if (!tab) return;
  tabs.delete(removedTabId);
  tabs.set(addedTabId, tab);
  if (tab.sessionId) tabBySession.set(tab.sessionId, addedTabId);
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === removedTabId) childSessionToTab.set(childSessionId, addedTabId);
  }
  setBadge(addedTabId, "on");
  void persistState();
}));

// Auto-attach new tabs
chrome.tabs.onCreated.addListener((tab) => void whenReady(async () => {
  if (!tab.id) return;
  await sleep(500); // Wait for URL to be set
  if (tabs.has(tab.id)) return;
  try {
    const t = await chrome.tabs.get(tab.id);
    if (t.url?.startsWith("chrome://") || t.url?.startsWith("chrome-extension://")) return;
  } catch { return; }
  if (relayWs && relayWs.readyState === WebSocket.OPEN) {
    try { await attachTab(tab.id); } catch { /* ignore */ }
  }
}));

// Register debugger listeners at module scope
chrome.debugger.onEvent.addListener((...args) => void whenReady(() => onDebuggerEvent(...args)));
chrome.debugger.onDetach.addListener((...args) => void whenReady(() => onDebuggerDetach(...args)));

// Toolbar click — toggle attach on active tab (also triggers connect if needed)
chrome.action.onClicked.addListener(() => void whenReady(async () => {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = active?.id;
  if (!tabId) return;
  if (tabOperationLocks.has(tabId)) return;
  tabOperationLocks.add(tabId);
  try {
    const existing = tabs.get(tabId);
    if (existing?.state === "connected") {
      await detachTab(tabId, "toggle");
    } else {
      tabs.set(tabId, { state: "connecting" });
      setBadge(tabId, "connecting");
      try {
        await ensureRelayConnection();
        await attachTab(tabId);
      } catch (err) {
        tabs.delete(tabId);
        setBadge(tabId, "error");
        console.warn("[InstaClaw Relay] Manual attach failed:", err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    tabOperationLocks.delete(tabId);
  }
}));

// Refresh badge after navigation
chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => void whenReady(() => {
  if (frameId !== 0) return;
  const tab = tabs.get(tabId);
  if (tab?.state === "connected") {
    setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? "on" : "connecting");
  }
}));

chrome.tabs.onActivated.addListener(({ tabId }) => void whenReady(() => {
  const tab = tabs.get(tabId);
  if (tab?.state === "connected") {
    setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? "on" : "connecting");
  }
}));

// --- Settings Change Listener ---
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.gatewayUrl || changes.gatewayToken)) {
    console.log("[InstaClaw Relay] Settings changed, reconnecting...");
    if (relayWs) relayWs.close();
    reconnectAttempt = 0;
  }
});

// Open options on first install
chrome.runtime.onInstalled.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

// --- Keepalive Alarm ---
chrome.alarms.create("instaclaw-relay-keepalive", { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "instaclaw-relay-keepalive") return;
  await initPromise;

  // Refresh badges
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === "connected") {
      setBadge(tabId, relayWs && relayWs.readyState === WebSocket.OPEN ? "on" : "connecting");
    }
  }

  // If relay is down and no reconnect in progress, trigger one
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
    if (!relayConnectPromise && !reconnectTimer) {
      console.log("[InstaClaw Relay] Keepalive: triggering reconnect");
      await ensureRelayConnection().catch(() => {
        if (!reconnectTimer) scheduleReconnect();
      });
    }
  }
});

// --- Relay check handler for options page ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "relayCheck") return false;
  const { url, token } = msg;
  const headers = token ? { "x-openclaw-relay-token": token } : {};
  fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(2000) })
    .then(async (res) => {
      const contentType = String(res.headers.get("content-type") || "");
      let json = null;
      if (contentType.includes("application/json")) {
        try { json = await res.json(); } catch { json = null; }
      }
      sendResponse({ status: res.status, ok: res.ok, contentType, json });
    })
    .catch((err) => sendResponse({ status: 0, ok: false, error: String(err) }));
  return true;
});

// --- Startup ---
const initPromise = rehydrateState();

initPromise.then(async () => {
  // Always try to connect and auto-attach on startup
  try {
    await ensureRelayConnection();
    reconnectAttempt = 0;
    if (tabs.size > 0) {
      await reannounceAttachedTabs();
    }
    // Auto-attach all tabs after successful connection
    await autoAttachAllTabs();
  } catch {
    scheduleReconnect();
  }
});

// Shared gate for all state-dependent handlers
async function whenReady(fn) {
  await initPromise;
  return fn();
}
