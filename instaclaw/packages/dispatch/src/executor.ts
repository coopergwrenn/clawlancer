/**
 * Executor — receives dispatch commands and executes them via usecomputer.
 * Returns results (action confirmations or screenshot data).
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { DispatchCommand } from "./types.js";
import { captureScreenshot } from "./screenshot.js";

// Dynamic import for usecomputer (ESM)
let uc: typeof import("usecomputer") | null = null;

// Track the most recent coordMap from screenshots for click mapping
let lastCoordMap: string | null = null;

async function getUC() {
  if (!uc) {
    uc = await import("usecomputer");
  }
  return uc;
}

export interface ExecutionResult {
  success: boolean;
  data?: Record<string, unknown>;
  /** For screenshots: raw JPEG buffer */
  screenshotBuffer?: Buffer;
  screenshotMeta?: {
    width: number;
    height: number;
    format: string;
    coordMap: string;
  };
  error?: string;
}

export async function executeCommand(command: DispatchCommand): Promise<ExecutionResult> {
  const { type, params } = command;

  try {
    switch (type) {
      case "screenshot":
        return await takeScreenshot(params);
      case "click":
        return await doClick(params);
      case "type":
        return await doType(params);
      case "press":
        return await doPress(params);
      case "scroll":
        return await doScroll(params);
      case "drag":
        return await doDrag(params);
      case "windows":
        return await listWindows();
      case "batch":
        return await executeBatch(params);
      default:
        return { success: false, error: `Unknown command type: ${type}` };
    }
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Execute multiple actions sequentially with optional per-action wait times.
 * Returns results for all actions; stops on first failure.
 * Optionally takes a screenshot after the batch completes.
 */
async function executeBatch(params: Record<string, unknown>): Promise<ExecutionResult> {
  const actions = params.actions as Array<{
    type: string;
    params: Record<string, unknown>;
    waitAfterMs?: number;
  }>;

  if (!Array.isArray(actions) || actions.length === 0) {
    return { success: false, error: "batch requires a non-empty 'actions' array" };
  }

  if (actions.length > 20) {
    return { success: false, error: "batch limited to 20 actions max" };
  }

  const results: Array<{ type: string; success: boolean; data?: Record<string, unknown>; error?: string }> = [];

  for (const action of actions) {
    const cmd: DispatchCommand = {
      id: `batch_${Date.now()}`,
      type: action.type as DispatchCommand["type"],
      params: action.params || {},
    };

    // Don't allow nested batches or screenshots inside a batch
    if (cmd.type === "batch") {
      results.push({ type: "batch", success: false, error: "nested batches not allowed" });
      break;
    }
    if (cmd.type === "screenshot") {
      results.push({ type: "screenshot", success: false, error: "use screenshotAfter param instead of screenshot in batch" });
      break;
    }

    const result = await executeCommand(cmd);
    results.push({
      type: action.type,
      success: result.success,
      data: result.data,
      error: result.error,
    });

    if (!result.success) break; // Stop batch on first failure

    // Per-action wait time (default: 50ms between actions)
    const waitMs = action.waitAfterMs ?? 50;
    if (waitMs > 0) {
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  // Optionally take a screenshot after the batch completes
  const screenshotAfter = params.screenshotAfter !== false; // default true
  let screenshotResult: ExecutionResult | undefined;

  if (screenshotAfter) {
    // Wait for screen to settle before capturing
    const settleMs = typeof params.settleMs === "number" ? params.settleMs : 300;
    if (settleMs > 0) {
      await new Promise((r) => setTimeout(r, settleMs));
    }
    screenshotResult = await takeScreenshot({
      format: (params.screenshotFormat as string) || "webp",
      quality: Number(params.screenshotQuality) || 55,
    });
  }

  const batchResult: ExecutionResult = {
    success: results.every((r) => r.success),
    data: {
      action: "batch",
      actionsExecuted: results.length,
      actionsTotal: actions.length,
      results,
    },
  };

  // If we took a screenshot, attach it
  if (screenshotResult?.screenshotBuffer && screenshotResult.screenshotMeta) {
    batchResult.screenshotBuffer = screenshotResult.screenshotBuffer;
    batchResult.screenshotMeta = screenshotResult.screenshotMeta;
    // Also include batch results in the screenshot meta so the agent gets both
    batchResult.data!.screenshotIncluded = true;
  }

  return batchResult;
}

async function takeScreenshot(params: Record<string, unknown>): Promise<ExecutionResult> {
  const capture = await captureScreenshot({
    format: (params.format as "jpeg" | "png" | "webp") || "webp",
    quality: Number(params.quality) || 55,
    maxWidth: Number(params.maxWidth) || 1280,
  });

  // Cache coordMap for subsequent click/hover/drag commands
  lastCoordMap = capture.coordMap;

  return {
    success: true,
    screenshotBuffer: capture.buffer,
    screenshotMeta: {
      width: capture.width,
      height: capture.height,
      format: capture.format,
      coordMap: capture.coordMap,
    },
  };
}

async function doClick(params: Record<string, unknown>): Promise<ExecutionResult> {
  const usecomputer = await getUC();
  const x = Number(params.x);
  const y = Number(params.y);

  if (isNaN(x) || isNaN(y) || x < 0 || y < 0) {
    return { success: false, error: `Invalid coordinates: (${params.x}, ${params.y}). Must be non-negative numbers.` };
  }

  const coordMap = params.coordMap ? String(params.coordMap) : lastCoordMap;

  let point = { x, y };
  if (coordMap) {
    // Map screenshot-space coordinates to desktop-space (critical for Retina/HiDPI)
    try {
      const parsed = usecomputer.parseCoordMapOrThrow(coordMap);
      point = usecomputer.mapPointFromCoordMap({ point: { x, y }, coordMap: parsed });
    } catch {
      // If mapping fails, fall back to raw coords
    }
  }

  await usecomputer.click({ point, button: "left", count: 1 });
  return { success: true, data: { action: "click", x, y, mappedX: point.x, mappedY: point.y, coordMap: coordMap || "none" } };
}

async function doType(params: Record<string, unknown>): Promise<ExecutionResult> {
  const usecomputer = await getUC();
  const text = String(params.text);
  try {
    await usecomputer.typeText({ text, delayMs: null });
  } catch {
    // Fallback: use xdotool on Linux if usecomputer fails (space character bug)
    if (process.platform === "linux") {
      execSync(`xdotool type --delay 12 -- ${JSON.stringify(text)}`, { env: { ...process.env, DISPLAY: process.env.DISPLAY || ":0" } });
    } else {
      throw new Error("typeText failed");
    }
  }
  return { success: true, data: { action: "type" } };
}

async function doPress(params: Record<string, unknown>): Promise<ExecutionResult> {
  const usecomputer = await getUC();
  const key = String(params.key);
  await usecomputer.press({ key, count: null, delayMs: null });
  return { success: true, data: { action: "press", key } };
}

async function doScroll(params: Record<string, unknown>): Promise<ExecutionResult> {
  const usecomputer = await getUC();
  const direction = String(params.direction) as "up" | "down" | "left" | "right";
  const amount = Number(params.amount || 3);
  await usecomputer.scroll({ direction, amount, at: null });
  return { success: true, data: { action: "scroll", direction, amount } };
}

async function doDrag(params: Record<string, unknown>): Promise<ExecutionResult> {
  const usecomputer = await getUC();
  const coordMap = params.coordMap ? String(params.coordMap) : lastCoordMap;

  let from = { x: Number(params.fromX), y: Number(params.fromY) };
  let to = { x: Number(params.toX), y: Number(params.toY) };

  if (coordMap) {
    try {
      const parsed = usecomputer.parseCoordMapOrThrow(coordMap);
      from = usecomputer.mapPointFromCoordMap({ point: from, coordMap: parsed });
      to = usecomputer.mapPointFromCoordMap({ point: to, coordMap: parsed });
    } catch {}
  }

  await usecomputer.drag({ from, to, durationMs: null, button: null });
  return { success: true, data: { action: "drag" } };
}

async function listWindows(): Promise<ExecutionResult> {
  const usecomputer = await getUC();
  const windows = await usecomputer.windowList();
  return { success: true, data: { windows } };
}
