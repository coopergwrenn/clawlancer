/**
 * InstaClaw Browser Relay — Service Worker (background.js)
 *
 * Forked from chengyixu/openclaw-browser-relay extension.
 * Modified for remote VM access via Caddy WSS tunnel.
 *
 * Key change: WebSocket connects to wss://{gatewayUrl}/relay/extension
 * instead of ws://127.0.0.1:{port}/extension (loopback).
 */

// --- Constants ---
const RELAY_PORT = 18792;
const RELAY_MESSAGE_PREFIX = "openclaw-extension-relay-v1";
const PING_INTERVAL_MS = 5000;
const KEEPALIVE_ALARM_NAME = "instaclaw-relay-keepalive";
const KEEPALIVE_INTERVAL_MINUTES = 0.5; // 30s
const MAX_RECONNECT_DELAY_MS = 30000;
const NAV_REATTACH_DELAYS = [200, 500, 1000, 2000, 4000];

// --- State ---
let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let attachedTabs = new Map(); // tabId -> sessionId
let sessionToTab = new Map(); // sessionId -> tabId
let pendingCommands = new Map(); // id -> { resolve, reject }
let nextSessionId = 1;

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

// --- WebSocket Connection ---
async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const { gatewayUrl, gatewayToken } = await getSettings();
  if (!gatewayUrl || !gatewayToken) {
    console.log("[InstaClaw Relay] No gateway URL/token configured. Open extension options to set up.");
    return;
  }

  try {
    const relayToken = await deriveRelayToken(gatewayToken);
    const wsUrl = `${gatewayUrl.replace(/^http/, "ws")}/relay/extension?token=${relayToken}`;

    console.log("[InstaClaw Relay] Connecting to", gatewayUrl);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("[InstaClaw Relay] WebSocket connected");
      reconnectAttempt = 0;
      autoAttachAllTabs();
    };

    ws.onmessage = (event) => {
      handleMessage(JSON.parse(event.data));
    };

    ws.onclose = (event) => {
      console.log("[InstaClaw Relay] WebSocket closed:", event.code, event.reason);
      ws = null;
      scheduleReconnect();
    };

    ws.onerror = (error) => {
      console.error("[InstaClaw Relay] WebSocket error:", error);
    };
  } catch (err) {
    console.error("[InstaClaw Relay] Connection failed:", err);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), MAX_RECONNECT_DELAY_MS) + Math.random() * 1000;
  reconnectAttempt++;
  console.log(`[InstaClaw Relay] Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(connect, delay);
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// --- Message Handling ---
function handleMessage(msg) {
  // Keepalive ping
  if (msg.method === "ping") {
    send({ method: "pong" });
    return;
  }

  // CDP command forwarding from relay
  if (msg.method === "forwardCDPCommand") {
    handleCDPCommand(msg.id, msg.params);
    return;
  }

  // Connect challenge
  if (msg.method === "connect.challenge") {
    handleConnectChallenge(msg);
    return;
  }
}

async function handleConnectChallenge(msg) {
  const { gatewayToken } = await getSettings();
  send({
    id: msg.id,
    method: "connect",
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "instaclaw-chrome-relay", version: "1.0.0" },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      auth: { token: gatewayToken },
    },
  });
}

async function handleCDPCommand(id, params) {
  const { method, params: cdpParams, sessionId } = params;

  // Special: Target.createTarget — open a new tab
  if (method === "Target.createTarget") {
    try {
      const tab = await chrome.tabs.create({ url: cdpParams.url || "about:blank" });
      const sid = `instaclaw-tab-${tab.id}`;
      attachedTabs.set(tab.id, sid);
      sessionToTab.set(sid, tab.id);
      saveAttachedTabs();
      send({ id, result: { targetId: sid } });
    } catch (err) {
      send({ id, error: { message: err.message } });
    }
    return;
  }

  // Special: Target.closeTarget
  if (method === "Target.closeTarget") {
    try {
      const tabId = sessionToTab.get(cdpParams.targetId);
      if (tabId) await chrome.tabs.remove(tabId);
      send({ id, result: {} });
    } catch (err) {
      send({ id, error: { message: err.message } });
    }
    return;
  }

  // Regular CDP command — forward to the right tab
  const tabId = sessionToTab.get(sessionId);
  if (!tabId) {
    send({ id, error: { message: `No tab found for session ${sessionId}` } });
    return;
  }

  try {
    // For Runtime.enable, disable first to avoid stale state
    if (method === "Runtime.enable") {
      try {
        await chrome.debugger.sendCommand({ tabId }, "Runtime.disable");
      } catch {
        // Ignore — may not be enabled yet
      }
    }

    const result = await chrome.debugger.sendCommand({ tabId }, method, cdpParams || {});
    send({ id, result: result || {} });
  } catch (err) {
    send({ id, error: { message: err.message } });
  }
}

// --- Tab Management ---
async function autoAttachAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.url && !tab.url.startsWith("chrome://") && !tab.url.startsWith("chrome-extension://")) {
        await attachTab(tab.id);
      }
    }
  } catch (err) {
    console.error("[InstaClaw Relay] Auto-attach failed:", err);
  }
}

async function attachTab(tabId) {
  if (attachedTabs.has(tabId)) return;

  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");

    const sessionId = `instaclaw-tab-${tabId}`;
    attachedTabs.set(tabId, sessionId);
    sessionToTab.set(sessionId, tabId);
    saveAttachedTabs();

    console.log(`[InstaClaw Relay] Attached to tab ${tabId} (session: ${sessionId})`);
  } catch (err) {
    // Tab may already be attached or is a restricted page
    if (!err.message?.includes("Already attached")) {
      console.warn(`[InstaClaw Relay] Cannot attach to tab ${tabId}:`, err.message);
    }
  }
}

function detachTab(tabId) {
  const sessionId = attachedTabs.get(tabId);
  if (sessionId) {
    attachedTabs.delete(tabId);
    sessionToTab.delete(sessionId);
    saveAttachedTabs();
  }
}

// --- CDP Event Forwarding ---
chrome.debugger.onEvent.addListener((source, method, params) => {
  const sessionId = attachedTabs.get(source.tabId);
  if (sessionId) {
    send({
      method: "forwardCDPEvent",
      params: { method, params, sessionId },
    });
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  console.log(`[InstaClaw Relay] Debugger detached from tab ${source.tabId}: ${reason}`);
  if (reason === "canceled_by_user") {
    detachTab(source.tabId);
  }
});

// --- Navigation Re-attach ---
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return; // Only main frame
  const tabId = details.tabId;

  if (!attachedTabs.has(tabId)) return;

  // Debugger may detach during navigation — retry re-attach
  for (const delay of NAV_REATTACH_DELAYS) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      // Check if still attached
      const targets = await chrome.debugger.getTargets();
      const isAttached = targets.some((t) => t.tabId === tabId && t.attached);
      if (isAttached) return; // Still attached, no action needed

      await chrome.debugger.attach({ tabId }, "1.3");
      await chrome.debugger.sendCommand({ tabId }, "Page.enable");
      console.log(`[InstaClaw Relay] Re-attached to tab ${tabId} after navigation`);
      return;
    } catch {
      // Retry on next delay
    }
  }
  console.warn(`[InstaClaw Relay] Failed to re-attach to tab ${tabId} after navigation`);
  detachTab(tabId);
});

// --- New Tab Auto-Attach ---
chrome.tabs.onCreated.addListener((tab) => {
  // Delay slightly for the URL to be set
  setTimeout(() => attachTab(tab.id), 500);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  detachTab(tabId);
});

// --- State Persistence (MV3) ---
function saveAttachedTabs() {
  const data = {};
  for (const [tabId, sessionId] of attachedTabs) {
    data[tabId] = sessionId;
  }
  chrome.storage.session.set({ attachedTabs: data });
}

async function restoreAttachedTabs() {
  try {
    const result = await chrome.storage.session.get("attachedTabs");
    if (result.attachedTabs) {
      for (const [tabIdStr, sessionId] of Object.entries(result.attachedTabs)) {
        const tabId = parseInt(tabIdStr, 10);
        attachedTabs.set(tabId, sessionId);
        sessionToTab.set(sessionId, tabId);
      }
    }
  } catch {
    // Fresh start
  }
}

// --- Keepalive Alarm (MV3 service worker persistence) ---
chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: KEEPALIVE_INTERVAL_MINUTES });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM_NAME) return;

  // Check if WS is still alive, reconnect if not
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connect();
    return;
  }

  // Health check the relay
  const { gatewayUrl } = await getSettings();
  if (gatewayUrl) {
    try {
      await fetch(`${gatewayUrl}/relay/`, { signal: AbortSignal.timeout(5000) });
    } catch {
      // Relay unreachable — reconnect
      if (ws) ws.close();
    }
  }
});

// --- Settings Change Listener ---
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.gatewayUrl || changes.gatewayToken)) {
    console.log("[InstaClaw Relay] Settings changed, reconnecting...");
    if (ws) ws.close();
    reconnectAttempt = 0;
    connect();
  }
});

// --- Startup ---
restoreAttachedTabs().then(connect);
