#!/usr/bin/env node
/**
 * Dispatch Server — VM-side WebSocket server for remote computer control.
 *
 * Bridges agent commands (via Unix socket) to the user's local relay (via WebSocket).
 * The local relay executes commands via usecomputer on the user's machine and returns results.
 *
 * Architecture:
 *   Agent script → Unix socket (/tmp/dispatch.sock) → this server → WSS → local relay → usecomputer
 *
 * Auth: Bearer gateway token validated during WebSocket upgrade handshake.
 * Protocol: JSON text frames for commands, binary frames for screenshots.
 */

const { WebSocketServer, WebSocket } = require("ws");
const https = require("https");
const http = require("http");
const fs = require("fs");
const net = require("net");
const path = require("path");
const crypto = require("crypto");

// ── Config ──
const WS_PORT = parseInt(process.env.DISPATCH_PORT || "8765", 10);
const UNIX_SOCKET = process.env.DISPATCH_SOCKET || "/tmp/dispatch.sock";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || fs.readFileSync(
  path.join(process.env.HOME, ".openclaw/.env"), "utf-8"
).match(/^GATEWAY_TOKEN=(.+)$/m)?.[1]?.trim();

if (!GATEWAY_TOKEN) {
  console.error("[dispatch-server] FATAL: No GATEWAY_TOKEN found");
  process.exit(1);
}

// ── Audit Log ──
const AUDIT_LOG = path.join(process.env.HOME, ".openclaw/workspace/dispatch-audit.log");

function auditLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  fs.appendFile(AUDIT_LOG, line, () => {}); // fire-and-forget
}

// Rotate audit log on startup: keep last 1000 lines, max 1MB
try {
  if (fs.existsSync(AUDIT_LOG)) {
    const stat = fs.statSync(AUDIT_LOG);
    if (stat.size > 1024 * 1024) { // > 1MB
      const lines = fs.readFileSync(AUDIT_LOG, "utf-8").split("\n");
      fs.writeFileSync(AUDIT_LOG, lines.slice(-1000).join("\n") + "\n");
      console.log(`[dispatch-server] Rotated audit log (was ${(stat.size / 1024).toFixed(0)}KB, kept last 1000 lines)`);
    }
  }
} catch {}

// ── Rate Limiting ──
const RATE_LIMIT_INTERVAL_MS = 100; // 10 commands per second (was 1/sec — too slow for batching)
const RATE_LIMIT_MAX_PER_SESSION = 500; // max 500 commands per relay session (was 100 — too low for complex tasks)
const RATE_LIMIT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min idle → disconnect

let sessionCommandCount = 0;
let lastCommandTime = 0;
let idleTimer = null;

function resetRateLimits() {
  sessionCommandCount = 0;
  lastCommandTime = 0;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function checkRateLimit() {
  const now = Date.now();

  // Max commands per session
  if (sessionCommandCount >= RATE_LIMIT_MAX_PER_SESSION) {
    return { allowed: false, error: `Session limit exceeded (${RATE_LIMIT_MAX_PER_SESSION} commands). Reconnect to reset.` };
  }

  // 1 command per second
  if (lastCommandTime && (now - lastCommandTime) < RATE_LIMIT_INTERVAL_MS) {
    return { allowed: false, error: "Rate limited — max 1 command per second" };
  }

  sessionCommandCount++;
  lastCommandTime = now;
  return { allowed: true };
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (activeRelay && activeRelay.readyState === WebSocket.OPEN) {
      console.log("[dispatch-server] Idle timeout (5 min) — disconnecting relay");
      auditLog({ event: "idle_timeout" });
      activeRelay.close(4002, "Idle timeout");
    }
  }, RATE_LIMIT_IDLE_TIMEOUT_MS);
}

// ── TLS: Self-signed cert (TOFU) ──
const CERT_DIR = path.join(process.env.HOME, ".dispatch-server-certs");
let tlsOptions = null;

function ensureSelfSignedCert() {
  const keyPath = path.join(CERT_DIR, "key.pem");
  const certPath = path.join(CERT_DIR, "cert.pem");

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  // Generate self-signed cert via openssl
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const { execSync } = require("child_process");
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" ` +
    `-days 365 -nodes -subj "/CN=dispatch-server" 2>/dev/null`
  );
  console.log("[dispatch-server] Generated self-signed TLS certificate");
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

try {
  tlsOptions = ensureSelfSignedCert();
} catch (err) {
  console.warn("[dispatch-server] TLS cert generation failed, falling back to plain WS:", err.message);
}

// ── State ──
let activeRelay = null; // The one connected local relay WebSocket
let pendingRequests = new Map(); // id → { resolve, reject, timer }
let commandCounter = 0;

// ── HMAC Auth: nonce tracking ──
const seenNonces = new Map(); // nonce → timestamp
const HANDSHAKE_MAX_AGE_MS = 30000; // 30 seconds
const NONCE_EXPIRY_MS = 60000; // 60 seconds

// Clean up expired nonces every 30s
setInterval(() => {
  const cutoff = Date.now() - NONCE_EXPIRY_MS;
  for (const [nonce, ts] of seenNonces) {
    if (ts < cutoff) seenNonces.delete(nonce);
  }
}, 30000);

function verifyHmacHandshake(url) {
  const params = new URL(url, "http://localhost");
  const hmac = params.searchParams.get("hmac");
  const ts = params.searchParams.get("ts");
  const nonce = params.searchParams.get("nonce");

  // Also accept legacy plain token for backwards compatibility during rollout
  const plainToken = params.searchParams.get("token");
  if (plainToken === GATEWAY_TOKEN) {
    return { ok: true, legacy: true };
  }

  if (!hmac || !ts || !nonce) {
    return { ok: false, error: "Missing auth params (hmac, ts, nonce)" };
  }

  // Timestamp check
  const tsMs = parseInt(ts, 10);
  if (isNaN(tsMs) || Math.abs(Date.now() - tsMs) > HANDSHAKE_MAX_AGE_MS) {
    return { ok: false, error: "Handshake expired (timestamp > 30s old)" };
  }

  // Nonce replay check
  if (seenNonces.has(nonce)) {
    return { ok: false, error: "Nonce already used (replay attack)" };
  }

  // HMAC verification
  const expected = crypto.createHmac("sha256", GATEWAY_TOKEN)
    .update(ts + ":" + nonce)
    .digest("hex");

  if (hmac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(expected, "hex"))) {
    return { ok: false, error: "HMAC verification failed" };
  }

  // Record nonce
  seenNonces.set(nonce, Date.now());
  return { ok: true, legacy: false };
}

// ── WebSocket Server ──
const server = tlsOptions
  ? https.createServer(tlsOptions)
  : http.createServer();

const wss = new WebSocketServer({
  server,
  verifyClient: (info, cb) => {
    const result = verifyHmacHandshake(info.req.url);

    if (result.ok) {
      if (result.legacy) {
        console.log("[dispatch-server] Connection accepted (legacy token auth — upgrade client)");
      }
      cb(true);
    } else {
      console.warn(`[dispatch-server] Rejected connection: ${result.error}`);
      auditLog({ event: "auth_rejected", error: result.error });
      cb(false, 401, "Unauthorized");
    }
  },
});

wss.on("connection", (ws, req) => {
  // Only allow 1 concurrent relay connection
  if (activeRelay && activeRelay.readyState === WebSocket.OPEN) {
    console.warn("[dispatch-server] Rejected second relay connection (only 1 allowed)");
    ws.close(4001, "Another relay is already connected");
    return;
  }

  activeRelay = ws;
  const clientIP = req.socket.remoteAddress;
  console.log(`[dispatch-server] Relay connected from ${clientIP}`);
  auditLog({ event: "relay_connected", ip: clientIP });
  resetRateLimits();
  resetIdleTimer();

  // Enable TCP keepalive to prevent NAT/firewall from killing idle connections
  const rawSocket = req.socket;
  if (rawSocket.setKeepAlive) {
    rawSocket.setKeepAlive(true, 30000); // Send TCP keepalive every 30s
    console.log("[dispatch-server] TCP keepalive enabled (30s interval)");
  }

  // Heartbeat
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; missedPongs.set(ws, 0); });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // Binary frame = screenshot data, find the pending request waiting for binary
      for (const [id, req] of pendingRequests) {
        if (req.awaitingBinary) {
          req.binaryData = data;
          finishRequest(id);
          return;
        }
      }
      return;
    }

    // Text frame = JSON response
    try {
      const msg = JSON.parse(data.toString());
      const id = msg.id;

      if (!id || !pendingRequests.has(id)) {
        console.warn("[dispatch-server] Unknown response id:", id);
        return;
      }

      if (msg.type === "screenshot_result") {
        // Next binary frame will contain the image data
        pendingRequests.get(id).metadata = msg;
        pendingRequests.get(id).awaitingBinary = true;
      } else {
        // Action result — resolve immediately
        pendingRequests.get(id).result = msg;
        finishRequest(id);
      }
    } catch (err) {
      console.warn("[dispatch-server] Failed to parse relay message:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("[dispatch-server] Relay disconnected");
    auditLog({ event: "relay_disconnected", commandsThisSession: sessionCommandCount });
    if (activeRelay === ws) activeRelay = null;
    resetRateLimits();
    // Reject all pending requests
    for (const [id, req] of pendingRequests) {
      req.reject(new Error("Relay disconnected"));
    }
    pendingRequests.clear();
  });

  ws.on("error", (err) => {
    console.error("[dispatch-server] Relay error:", err.message);
  });
});

function finishRequest(id) {
  const req = pendingRequests.get(id);
  if (!req) return;
  clearTimeout(req.timer);
  pendingRequests.delete(id);

  if (req.binaryData) {
    // Screenshot response: combine metadata + binary
    const meta = req.metadata || {};
    req.resolve({
      ...meta,
      image_base64: req.binaryData.toString("base64"),
    });
  } else {
    req.resolve(req.result);
  }
}

// ── Screenshot Queue (prevent concurrent screenshot race condition) ──
let screenshotInFlight = false;
let screenshotQueue = [];

function sendToRelayQueued(command, timeoutMs = 30000) {
  if (command.type === "screenshot" && screenshotInFlight) {
    // Queue the screenshot request
    return new Promise((resolve, reject) => {
      screenshotQueue.push({ command, timeoutMs, resolve, reject });
    });
  }
  if (command.type === "screenshot") {
    screenshotInFlight = true;
  }
  return sendToRelay(command, timeoutMs).finally(() => {
    if (command.type === "screenshot") {
      screenshotInFlight = false;
      // Process next queued screenshot if any
      if (screenshotQueue.length > 0) {
        const next = screenshotQueue.shift();
        sendToRelayQueued(next.command, next.timeoutMs).then(next.resolve, next.reject);
      }
    }
  });
}

// Send command to relay and wait for response
function sendToRelay(command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!activeRelay || activeRelay.readyState !== WebSocket.OPEN) {
      reject(new Error("No relay connected"));
      return;
    }

    const id = `cmd_${++commandCounter}_${Date.now()}`;
    command.id = id;

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Command timed out"));
    }, timeoutMs);

    pendingRequests.set(id, { resolve, reject, timer });
    activeRelay.send(JSON.stringify(command));
  });
}

// ── Heartbeat interval ──
// Relaxed: 45s interval, 2 missed pongs before terminating.
// The relay may block on screenshot capture (usecomputer N-API is synchronous)
// which delays pong responses. One missed pong is normal during screenshots.
let missedPongs = new Map(); // ws → count
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      const missed = (missedPongs.get(ws) || 0) + 1;
      missedPongs.set(ws, missed);
      if (missed >= 2) {
        console.log(`[dispatch-server] Terminating stale relay (${missed} missed pongs)`);
        missedPongs.delete(ws);
        ws.terminate();
        return;
      }
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 45000);

wss.on("close", () => clearInterval(heartbeatInterval));

// ── Unix Socket Server (agent interface) ──
// Agent scripts connect here to send commands to the user's machine

function cleanupSocket() {
  try { fs.unlinkSync(UNIX_SOCKET); } catch {}
}
cleanupSocket();

const unixServer = net.createServer((conn) => {
  let data = "";
  let handled = false;

  async function handleCommand(raw) {
    if (handled) return;
    handled = true;

    try {
      const command = JSON.parse(raw.trim());

      // Special: status command
      if (command.type === "status") {
        const status = {
          connected: !!(activeRelay && activeRelay.readyState === WebSocket.OPEN),
          pendingCommands: pendingRequests.size,
          uptime: process.uptime(),
        };
        conn.write(JSON.stringify(status) + "\n");
        conn.end();
        return;
      }

      // Rate limit check
      const rl = checkRateLimit();
      if (!rl.allowed) {
        console.log(`[dispatch-server] Rate limited: ${rl.error}`);
        auditLog({ event: "rate_limited", type: command.type });
        conn.write(JSON.stringify({ error: rl.error }) + "\n");
        conn.end();
        return;
      }
      resetIdleTimer();

      // Forward to relay (screenshots are queued to prevent race conditions)
      console.log(`[dispatch-server] Forwarding ${command.type} command to relay`);
      const logParams = command.type === "type" ? { text: "***" } :
        command.type === "batch" ? { actions: (command.params?.actions || []).length } : command.params;
      auditLog({ event: "command", type: command.type, params: logParams });

      // Batch commands get a longer timeout (60s) since they execute multiple actions + screenshot
      const timeout = command.type === "batch" ? 60000 : 30000;
      const result = await sendToRelayQueued(command, timeout);
      console.log(`[dispatch-server] Got result for ${command.type}: ${JSON.stringify(result).substring(0, 200)}`);
      auditLog({ event: "result", type: command.type, success: !!result && !result.error });
      conn.write(JSON.stringify(result) + "\n");
      conn.end();
    } catch (err) {
      console.log(`[dispatch-server] Command error: ${err.message}`);
      conn.write(JSON.stringify({ error: err.message }) + "\n");
      conn.end();
    }
  }

  conn.on("data", (chunk) => {
    data += chunk.toString();
    // Try to parse as soon as we have a complete JSON object
    try {
      JSON.parse(data.trim());
      handleCommand(data);
    } catch {
      // Not complete yet, wait for more data
    }
  });

  // Also handle end in case data comes all at once
  conn.on("end", () => {
    if (!handled && data.trim()) {
      handleCommand(data);
    }
  });

  conn.on("error", () => {});
});

unixServer.listen(UNIX_SOCKET, () => {
  // Make socket world-writable so agent (openclaw user) can connect
  fs.chmodSync(UNIX_SOCKET, 0o777);
  console.log(`[dispatch-server] Unix socket listening on ${UNIX_SOCKET}`);
});

// ── Start ──
server.listen(WS_PORT, "0.0.0.0", () => {
  const proto = tlsOptions ? "wss" : "ws";
  console.log(`[dispatch-server] ${proto}://0.0.0.0:${WS_PORT} (auth=bearer)`);
  console.log(`[dispatch-server] Gateway token: ${GATEWAY_TOKEN.substring(0, 8)}...`);
});

// ── Graceful shutdown ──
process.on("SIGTERM", () => {
  console.log("[dispatch-server] Shutting down...");
  cleanupSocket();
  wss.close();
  server.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  cleanupSocket();
  process.exit(0);
});
