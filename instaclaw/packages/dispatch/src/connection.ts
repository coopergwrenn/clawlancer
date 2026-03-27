/**
 * Connection — WebSocket client that connects to the VM's dispatch server.
 * Handles reconnection, heartbeat, and message routing.
 */
import WebSocket from "ws";
import type { DispatchCommand } from "./types.js";
import { executeCommand } from "./executor.js";
import { requestApproval } from "./supervisor.js";
import { buildAuthUrl } from "./auth.js";

interface ConnectionOptions {
  vmAddress: string;
  port: number;
  gatewayToken: string;
  mode: "supervised" | "autonomous";
  /** Accept self-signed certs (TOFU) */
  rejectUnauthorized: boolean;
  certFingerprint?: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onCertFingerprint?: (fingerprint: string) => void;
}

let ws: WebSocket | null = null;
let reconnectDelay = 1000;
let shouldReconnect = true;
let commandsExecuted = 0;

export function connect(opts: ConnectionOptions): void {
  // HMAC-authenticated URL (token + timestamp + nonce)
  const url = buildAuthUrl(opts.vmAddress, opts.port, opts.gatewayToken);

  console.log(`  Connecting to ${opts.vmAddress}:${opts.port}...`);

  ws = new WebSocket(url, {
    rejectUnauthorized: false, // Accept self-signed certs (TOFU model)
    handshakeTimeout: 10000,
  });

  ws.on("open", () => {
    reconnectDelay = 1000; // Reset backoff
    console.log(`  Connected to agent on ${opts.vmAddress}`);

    // Enable TCP keepalive to prevent NAT/firewall/router from killing idle connections
    // Without this, home routers typically drop idle TCP after 2-5 minutes
    const socket = (ws as any)?._socket;
    if (socket?.setKeepAlive) {
      socket.setKeepAlive(true, 30000); // Send TCP keepalive every 30s
    }

    opts.onConnect?.();
  });

  ws.on("message", async (data, isBinary) => {
    if (isBinary) return; // We don't expect binary from the server

    try {
      const command: DispatchCommand = JSON.parse(data.toString());

      // Check approval (supervisor handles mode logic — prompts in supervised, auto-approves in autonomous, blocks dangerous)
      const approved = await requestApproval(command);
      if (!approved) {
        sendResult(command.id, { success: false, error: "User denied the action" });
        return;
      }

      // Execute the command
      const result = await executeCommand(command);
      commandsExecuted++;

      if (result.screenshotBuffer && result.screenshotMeta) {
        // Screenshot (or batch with screenshot): send metadata text frame, then binary frame
        const meta: Record<string, unknown> = {
          id: command.id,
          type: "screenshot_result" as const,
          ...result.screenshotMeta,
          size: result.screenshotBuffer.length,
        };
        // For batch commands, include action results in the metadata frame
        if (result.data) {
          meta.data = result.data;
        }
        ws?.send(JSON.stringify(meta));
        ws?.send(result.screenshotBuffer);
      } else {
        // Normal result
        sendResult(command.id, {
          success: result.success,
          data: result.data,
          error: result.error,
        });
      }
    } catch (err) {
      console.error("  Error processing command:", err);
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`  Disconnected (code=${code}${reason.length ? `, reason=${reason}` : ""})`);
    ws = null;
    opts.onDisconnect?.();

    if (shouldReconnect) {
      console.log(`  Reconnecting in ${reconnectDelay / 1000}s...`);
      setTimeout(() => connect(opts), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    }
  });

  ws.on("error", (err) => {
    // Suppress ECONNREFUSED noise — close handler will reconnect
    if ((err as NodeJS.ErrnoException).code !== "ECONNREFUSED") {
      console.error("  WebSocket error:", err.message);
    }
  });

  ws.on("ping", () => { ws?.pong(); });
}

function sendResult(id: string, result: { success: boolean; data?: unknown; error?: string }) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id, type: "result", ...result }));
  }
}

export function disconnect(): void {
  shouldReconnect = false;
  ws?.close();
}

export function getStats() {
  return {
    connected: ws?.readyState === WebSocket.OPEN,
    commandsExecuted,
  };
}
