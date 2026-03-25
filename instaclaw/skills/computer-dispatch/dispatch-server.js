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

// ── WebSocket Server ──
const server = tlsOptions
  ? https.createServer(tlsOptions)
  : http.createServer();

const wss = new WebSocketServer({
  server,
  verifyClient: (info, cb) => {
    // Auth: validate gateway token from query string
    const url = new URL(info.req.url, `http://${info.req.headers.host}`);
    const token = url.searchParams.get("token");

    if (token === GATEWAY_TOKEN) {
      cb(true);
    } else {
      console.warn("[dispatch-server] Rejected connection: invalid token");
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

  // Heartbeat
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

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
    auditLog({ event: "relay_disconnected" });
    if (activeRelay === ws) activeRelay = null;
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
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log("[dispatch-server] Terminating stale relay connection");
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

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

      // Forward to relay
      console.log(`[dispatch-server] Forwarding ${command.type} command to relay`);
      auditLog({ event: "command", type: command.type, params: command.type === "type" ? { text: "***" } : command.params });
      const result = await sendToRelay(command);
      console.log(`[dispatch-server] Got result for ${command.type}: ${JSON.stringify(result).substring(0, 100)}`);
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
