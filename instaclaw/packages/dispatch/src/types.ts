/** Command sent from VM agent → dispatch server → local relay */
export interface DispatchCommand {
  id: string;
  type: "screenshot" | "click" | "type" | "press" | "scroll" | "drag" | "windows" | "status";
  params: Record<string, unknown>;
  description?: string; // For supervised mode — what the agent wants to do
}

/** Result sent from local relay → dispatch server → agent */
export interface DispatchResult {
  id: string;
  type: "result" | "screenshot_result" | "error";
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/** Screenshot metadata (sent as text frame before binary frame) */
export interface ScreenshotMeta {
  id: string;
  type: "screenshot_result";
  width: number;
  height: number;
  format: "jpeg" | "png";
  size: number;
  coordMap: string;
}

/** Relay config persisted to disk */
export interface DispatchConfig {
  gatewayToken: string;
  vmAddress: string;
  port: number;
  mode: "supervised" | "autonomous";
  /** TLS cert fingerprint for TOFU (trust on first use) */
  certFingerprint?: string;
}
