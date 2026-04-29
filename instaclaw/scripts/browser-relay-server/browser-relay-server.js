#!/usr/bin/env node
/**
 * Browser Relay Server — VM-side WebSocket server for the InstaClaw Browser
 * Relay Chrome extension.
 *
 * Replaces the OpenClaw extension relay subsystem that was removed upstream
 * (see CHANGELOG: "Browser/Chrome MCP: remove the legacy Chrome extension
 * relay path, bundled extension assets, driver: 'extension', and
 * browser.relayBindHost"). The chrome extension still expects the protocol
 * defined by `instaclaw-chrome-extension/background.js`; this server speaks
 * the server side of that protocol.
 *
 * Architecture:
 *   Extension (Chrome on user's machine)
 *       │ wss://<vm>.vm.instaclaw.io/relay/extension?token=<HMAC>
 *       ▼
 *   Caddy (TLS termination, strip /relay prefix)
 *       │ ws://localhost:18792/extension?token=<HMAC>
 *       ▼
 *   THIS SERVER on 127.0.0.1:18792
 *       │
 *       ├─ extension WS at /extension/connect  ← this file
 *       └─ CDP HTTP+WS endpoints for gateway integration:
 *             /json/version    — CDP banner
 *             /json/list       — list of attached targets (one per extension tab)
 *             /devtools/page/<targetId>  — per-target CDP WS
 *
 * Auth:
 *   - Extension URL token: HMAC-SHA256(gatewayToken, "openclaw-extension-relay-v1:18792"), hex
 *   - In-protocol: extension's `connect` request also includes auth.token = gatewayToken (plain)
 *
 * Protocol (matches background.js):
 *   server → extension:
 *     { type: "event", event: "connect.challenge", payload: { nonce } }
 *     { type: "res",   id, ok: true|false, error?: { message } }
 *     { method: "ping" }
 *     { id: <number>, method: "forwardCDPCommand", params: { method, params, sessionId? } }
 *   extension → server:
 *     { type: "req", id, method: "connect", params: { ..., nonce, auth: { token } } }
 *     { method: "pong" }
 *     { method: "forwardCDPEvent", params: { method, params, sessionId? } }
 *     { id: <number>, result } | { id: <number>, error }
 *
 * Status: P0 patch shipped to fix fleet-wide outage. CDP bridge to gateway
 * (the /devtools/page/<targetId> WS path) is implemented but the gateway-side
 * configuration to point its browser plugin at us is left as a follow-up
 * (see scripts/browser-relay-server/README.md).
 */

const { WebSocketServer, WebSocket } = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ── Config ─────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.RELAY_PORT || "18792", 10);
const BIND = process.env.RELAY_BIND || "127.0.0.1";
const RELAY_MESSAGE_PREFIX = "openclaw-extension-relay-v1";
const PROTOCOL_VERSION = 3;

// Load gateway token (same pattern as dispatch-server.js)
const GATEWAY_TOKEN =
  process.env.GATEWAY_TOKEN ||
  (() => {
    try {
      return fs
        .readFileSync(path.join(process.env.HOME, ".openclaw/.env"), "utf-8")
        .match(/^GATEWAY_TOKEN=(.+)$/m)?.[1]
        ?.trim();
    } catch {
      return null;
    }
  })();

if (!GATEWAY_TOKEN) {
  console.error("[browser-relay] FATAL: GATEWAY_TOKEN not found (env or ~/.openclaw/.env)");
  process.exit(1);
}

// Pre-compute the expected HMAC token the extension will send
const EXPECTED_HMAC_TOKEN = crypto
  .createHmac("sha256", GATEWAY_TOKEN)
  .update(`${RELAY_MESSAGE_PREFIX}:${PORT}`)
  .digest("hex");

// Heartbeat / connect timing
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 90_000;
const CONNECT_HANDSHAKE_TIMEOUT_MS = 30_000;

// Audit log (best-effort)
const AUDIT_LOG = path.join(
  process.env.HOME || "/tmp",
  ".openclaw/workspace/browser-relay-audit.log",
);

function log(...args) {
  console.log(`[browser-relay] ${new Date().toISOString()}`, ...args);
}

function audit(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  fs.appendFile(AUDIT_LOG, line, () => {});
}

// ── State ──────────────────────────────────────────────────────────────────
/** @type {WebSocket | null} the single active extension WS */
let extensionWs = null;
/** has the extension completed its connect handshake? */
let extensionReady = false;
/** the connect.challenge nonce we sent (for replay sanity) */
let extensionChallengeNonce = null;
/** when the extension connected */
let extensionConnectedAt = 0;

/**
 * Attached targets, keyed by sessionId. sessionId is "cb-tab-<n>" from the
 * extension. Each target maps to a CDP-protocol client (the gateway-side WS)
 * if one is connected.
 *
 * @type {Map<string, {
 *   sessionId: string,
 *   targetId: string,
 *   targetInfo: any,
 *   cdpClient: WebSocket | null,
 *   pendingCommands: Map<number, { gatewayId: number|string, ts: number }>
 * }>}
 */
const targetsBySessionId = new Map();
/** @type {Map<string, string>} targetId → sessionId for /json/list */
const sessionIdByTargetId = new Map();

/**
 * Pending CDP commands sent from CDP clients (gateway) to the extension.
 * Maps relay command id → originating CDP client info.
 *
 * @type {Map<number, { cdpClient: WebSocket, gatewayId: number|string, sessionId?: string }>}
 */
const pendingExtensionCommands = new Map();
let nextRelayCommandId = 1;

// ── Helpers ────────────────────────────────────────────────────────────────
function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
    return true;
  } catch (err) {
    log("send failed:", err.message);
    return false;
  }
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function tearDownExtension(reason) {
  if (extensionWs) {
    try { extensionWs.close(1000, reason); } catch {}
  }
  extensionWs = null;
  extensionReady = false;
  extensionChallengeNonce = null;

  // Reject pending commands and tear down attached CDP clients
  for (const [, pending] of pendingExtensionCommands) {
    safeSend(pending.cdpClient, {
      id: pending.gatewayId,
      error: { code: -32000, message: `relay disconnected: ${reason}` },
    });
  }
  pendingExtensionCommands.clear();

  // Notify each CDP client of detach
  for (const [, target] of targetsBySessionId) {
    if (target.cdpClient && target.cdpClient.readyState === WebSocket.OPEN) {
      safeSend(target.cdpClient, {
        method: "Inspector.detached",
        params: { reason: "Browser Relay disconnected" },
      });
      try { target.cdpClient.close(1011, "extension gone"); } catch {}
    }
    target.cdpClient = null;
  }
  targetsBySessionId.clear();
  sessionIdByTargetId.clear();
}

// ── HTTP server ────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // Health check
  if (pathname === "/" || pathname === "") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
    return;
  }

  // Dashboard polling endpoint
  if (pathname === "/extension/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        connected: !!extensionReady,
        connectedAt: extensionConnectedAt || null,
        targets: targetsBySessionId.size,
      }) + "\n",
    );
    return;
  }

  // CDP banner — gateway hits this to discover the relay as a CDP server
  if (pathname === "/json/version") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        Browser: "InstaClaw-Browser-Relay/1.0",
        "Protocol-Version": "1.3",
        "User-Agent": "InstaClawBrowserRelay/1.0",
        "V8-Version": "n/a",
        "WebKit-Version": "n/a",
        webSocketDebuggerUrl: `ws://${req.headers.host || "localhost"}/devtools/browser`,
      }) + "\n",
    );
    return;
  }

  // CDP target list — one entry per attached extension tab
  if (pathname === "/json/list" || pathname === "/json") {
    const list = [];
    for (const target of targetsBySessionId.values()) {
      const info = target.targetInfo || {};
      list.push({
        id: target.targetId,
        type: info.type || "page",
        title: info.title || "",
        url: info.url || "",
        webSocketDebuggerUrl: `ws://${req.headers.host || "localhost"}/devtools/page/${encodeURIComponent(target.targetId)}`,
        description: "InstaClaw Browser Relay target",
      });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list, null, 2) + "\n");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found\n");
});

// ── WebSocket upgrade routing ─────────────────────────────────────────────
const extensionWss = new WebSocketServer({ noServer: true });
const cdpWss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/extension/connect") {
    handleExtensionUpgrade(req, socket, head, url);
    return;
  }

  if (url.pathname.startsWith("/devtools/page/")) {
    handleCdpPageUpgrade(req, socket, head, url);
    return;
  }

  if (url.pathname === "/devtools/browser") {
    // Browser-level CDP WS — we don't fully implement these; close cleanly
    // so the gateway falls back to per-page targets.
    socket.write("HTTP/1.1 501 Not Implemented\r\n\r\n");
    socket.destroy();
    return;
  }

  socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
  socket.destroy();
});

// ── Extension WS handler ──────────────────────────────────────────────────
function handleExtensionUpgrade(req, socket, head, url) {
  const token = url.searchParams.get("token") || "";
  if (!timingSafeEqualHex(token, EXPECTED_HMAC_TOKEN)) {
    log("rejected extension connection: bad HMAC token");
    audit({ event: "extension_auth_rejected", reason: "bad_hmac" });
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  if (extensionWs && extensionWs.readyState === WebSocket.OPEN) {
    log("rejecting second extension connection (only 1 allowed)");
    audit({ event: "extension_rejected", reason: "duplicate" });
    socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
    socket.destroy();
    return;
  }

  extensionWss.handleUpgrade(req, socket, head, (ws) => {
    onExtensionConnected(ws, req);
  });
}

function onExtensionConnected(ws, req) {
  extensionWs = ws;
  extensionReady = false;
  extensionConnectedAt = Date.now();
  const ip = req.socket.remoteAddress;
  log(`extension connected from ${ip}`);
  audit({ event: "extension_connected", ip });

  // TCP keepalive
  if (req.socket.setKeepAlive) req.socket.setKeepAlive(true, 30000);

  // Heartbeat
  ws.isAlive = true;
  ws.lastPongAt = Date.now();
  ws.on("pong", () => {
    ws.isAlive = true;
    ws.lastPongAt = Date.now();
  });

  // Send connect.challenge to start the handshake
  extensionChallengeNonce = crypto.randomBytes(16).toString("hex");
  safeSend(ws, {
    type: "event",
    event: "connect.challenge",
    payload: { nonce: extensionChallengeNonce },
  });

  // Reject if handshake doesn't complete in time
  const handshakeTimer = setTimeout(() => {
    if (!extensionReady && extensionWs === ws) {
      log("extension handshake timed out");
      audit({ event: "extension_handshake_timeout" });
      try { ws.close(1008, "handshake timeout"); } catch {}
    }
  }, CONNECT_HANDSHAKE_TIMEOUT_MS);

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      log("extension sent binary frame; ignoring (protocol uses text JSON)");
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString("utf-8"));
    } catch {
      log("extension sent invalid JSON");
      return;
    }
    handleExtensionMessage(msg);
  });

  ws.on("close", (code, reason) => {
    clearTimeout(handshakeTimer);
    log(`extension disconnected (${code} ${reason})`);
    audit({ event: "extension_disconnected", code, reason: String(reason || "") });
    if (extensionWs === ws) {
      tearDownExtension(`close-${code}`);
    }
  });

  ws.on("error", (err) => {
    log("extension ws error:", err.message);
  });
}

function handleExtensionMessage(msg) {
  // Connect handshake response
  if (msg.type === "req" && msg.method === "connect" && msg.id) {
    const params = msg.params || {};
    const echoedNonce = params.nonce;
    const innerToken = params?.auth?.token;
    const protoOk =
      typeof params.minProtocol === "number" &&
      typeof params.maxProtocol === "number" &&
      params.minProtocol <= PROTOCOL_VERSION &&
      params.maxProtocol >= PROTOCOL_VERSION;

    if (echoedNonce !== extensionChallengeNonce) {
      log("connect rejected: nonce mismatch");
      audit({ event: "connect_rejected", reason: "nonce_mismatch" });
      safeSend(extensionWs, {
        type: "res",
        id: msg.id,
        ok: false,
        error: { message: "nonce mismatch" },
      });
      tearDownExtension("nonce mismatch");
      return;
    }

    if (innerToken !== GATEWAY_TOKEN) {
      log("connect rejected: inner auth token mismatch");
      audit({ event: "connect_rejected", reason: "token_mismatch" });
      safeSend(extensionWs, {
        type: "res",
        id: msg.id,
        ok: false,
        error: { message: "auth token mismatch" },
      });
      tearDownExtension("token mismatch");
      return;
    }

    if (!protoOk) {
      log("connect rejected: protocol version mismatch", params.minProtocol, params.maxProtocol);
      audit({ event: "connect_rejected", reason: "proto_mismatch" });
      safeSend(extensionWs, {
        type: "res",
        id: msg.id,
        ok: false,
        error: { message: `protocol mismatch (server speaks ${PROTOCOL_VERSION})` },
      });
      tearDownExtension("protocol mismatch");
      return;
    }

    extensionReady = true;
    log(`extension handshake complete (client=${params?.client?.id || "?"})`);
    audit({ event: "extension_ready", client: params?.client });
    safeSend(extensionWs, {
      type: "res",
      id: msg.id,
      ok: true,
    });
    return;
  }

  // Pong
  if (msg.method === "pong") {
    if (extensionWs) {
      extensionWs.isAlive = true;
      extensionWs.lastPongAt = Date.now();
    }
    return;
  }

  // CDP event from extension (target attached/detached, page events, etc.)
  if (msg.method === "forwardCDPEvent" && msg.params) {
    handleForwardCdpEvent(msg.params);
    return;
  }

  // Response to a forwardCDPCommand we sent
  if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
    const pending = pendingExtensionCommands.get(msg.id);
    if (!pending) return;
    pendingExtensionCommands.delete(msg.id);
    if (msg.error) {
      safeSend(pending.cdpClient, {
        id: pending.gatewayId,
        error: { code: -32000, message: String(msg.error) },
      });
    } else {
      safeSend(pending.cdpClient, {
        id: pending.gatewayId,
        result: msg.result,
      });
    }
    return;
  }

  // Anything else: log and ignore
  log("extension sent unknown message:", JSON.stringify(msg).slice(0, 200));
}

function handleForwardCdpEvent({ method, params, sessionId }) {
  // Track target attach/detach
  if (method === "Target.attachedToTarget" && params?.sessionId && params?.targetInfo) {
    const newSessionId = String(params.sessionId);
    const targetInfo = params.targetInfo;
    const targetId = String(targetInfo.targetId || "");
    if (!targetId) return;

    targetsBySessionId.set(newSessionId, {
      sessionId: newSessionId,
      targetId,
      targetInfo,
      cdpClient: null,
      pendingCommands: new Map(),
    });
    sessionIdByTargetId.set(targetId, newSessionId);
    log(`target attached: ${targetId} (session ${newSessionId}) ${targetInfo.url || ""}`);
    return;
  }

  if (method === "Target.detachedFromTarget" && params?.sessionId) {
    const sid = String(params.sessionId);
    const target = targetsBySessionId.get(sid);
    if (target) {
      sessionIdByTargetId.delete(target.targetId);
      targetsBySessionId.delete(sid);
      if (target.cdpClient && target.cdpClient.readyState === WebSocket.OPEN) {
        try { target.cdpClient.close(1000, "target detached"); } catch {}
      }
      log(`target detached: ${target.targetId} (session ${sid})`);
    }
    return;
  }

  // Generic CDP event for an attached target — forward to the matching CDP client
  if (sessionId) {
    const sid = String(sessionId);
    const target = targetsBySessionId.get(sid);
    if (target?.cdpClient && target.cdpClient.readyState === WebSocket.OPEN) {
      safeSend(target.cdpClient, { method, params });
    }
  }
}

// ── CDP-side WebSocket (gateway connects here per-target) ────────────────
function handleCdpPageUpgrade(req, socket, head, url) {
  const targetId = decodeURIComponent(url.pathname.slice("/devtools/page/".length));
  const sessionId = sessionIdByTargetId.get(targetId);
  const target = sessionId ? targetsBySessionId.get(sessionId) : null;
  if (!target) {
    log(`CDP upgrade for unknown targetId ${targetId}`);
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  if (target.cdpClient && target.cdpClient.readyState === WebSocket.OPEN) {
    log(`CDP upgrade rejected for ${targetId}: already attached`);
    socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
    socket.destroy();
    return;
  }

  cdpWss.handleUpgrade(req, socket, head, (ws) => {
    target.cdpClient = ws;
    log(`CDP client connected for ${targetId}`);
    audit({ event: "cdp_attached", targetId });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let cmd;
      try { cmd = JSON.parse(data.toString("utf-8")); } catch { return; }
      if (typeof cmd.id === "undefined" || typeof cmd.method !== "string") return;

      // Forward to extension as forwardCDPCommand
      if (!extensionReady || !extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
        safeSend(ws, {
          id: cmd.id,
          error: { code: -32000, message: "extension not connected" },
        });
        return;
      }

      const relayCommandId = nextRelayCommandId++;
      pendingExtensionCommands.set(relayCommandId, {
        cdpClient: ws,
        gatewayId: cmd.id,
        sessionId: target.sessionId,
      });
      safeSend(extensionWs, {
        id: relayCommandId,
        method: "forwardCDPCommand",
        params: {
          method: cmd.method,
          params: cmd.params,
          sessionId: target.sessionId,
        },
      });
    });

    ws.on("close", (code, reason) => {
      log(`CDP client disconnected for ${targetId} (${code} ${reason})`);
      audit({ event: "cdp_detached", targetId, code });
      if (target.cdpClient === ws) target.cdpClient = null;
      // Reject any pending commands from this client
      for (const [id, pending] of pendingExtensionCommands) {
        if (pending.cdpClient === ws) pendingExtensionCommands.delete(id);
      }
    });

    ws.on("error", (err) => log(`cdp client error for ${targetId}:`, err.message));
  });
}

// ── Heartbeat (pings extension) ────────────────────────────────────────────
const heartbeatTimer = setInterval(() => {
  const ws = extensionWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (Date.now() - (ws.lastPongAt || 0) > PONG_TIMEOUT_MS) {
    log("extension pong timeout, terminating");
    audit({ event: "extension_pong_timeout" });
    try { ws.terminate(); } catch {}
    return;
  }
  // The protocol uses an in-band ping/pong via JSON method:"ping"; we also do
  // WS-level ping for TCP keepalive.
  safeSend(ws, { method: "ping" });
  try { ws.ping(); } catch {}
}, PING_INTERVAL_MS);

// ── Startup ────────────────────────────────────────────────────────────────
httpServer.listen(PORT, BIND, () => {
  log(`browser-relay listening on http://${BIND}:${PORT}`);
  log(`expected extension HMAC: ${EXPECTED_HMAC_TOKEN.slice(0, 8)}...`);
  log(`audit log: ${AUDIT_LOG}`);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────
function shutdown(signal) {
  log(`received ${signal}, shutting down`);
  clearInterval(heartbeatTimer);
  tearDownExtension(`signal-${signal}`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Don't crash on unhandled extension protocol weirdness
process.on("uncaughtException", (err) => {
  log("uncaughtException:", err.stack || err);
});
process.on("unhandledRejection", (reason) => {
  log("unhandledRejection:", reason);
});
