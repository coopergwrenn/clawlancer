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
      default:
        return { success: false, error: `Unknown command type: ${type}` };
    }
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

async function takeScreenshot(params: Record<string, unknown>): Promise<ExecutionResult> {
  const capture = await captureScreenshot({
    format: (params.format as "jpeg" | "png") || "jpeg",
    quality: Number(params.quality) || 80,
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
