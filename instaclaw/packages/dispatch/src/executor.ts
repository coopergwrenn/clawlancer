/**
 * Executor — receives dispatch commands and executes them via usecomputer.
 * Returns results (action confirmations or screenshot data).
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import type { DispatchCommand } from "./types.js";

// Dynamic import for usecomputer (ESM)
let uc: typeof import("usecomputer") | null = null;

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
  const usecomputer = await getUC();
  const tmpPath = path.join("/tmp", `dispatch-ss-${Date.now()}.png`);

  try {
    const result = await usecomputer.screenshot({ path: tmpPath, display: null, window: null, region: null, annotate: null });

    // Read the PNG and convert to JPEG via sharp
    const pngBuffer = fs.readFileSync(tmpPath);
    let jpegBuffer: Buffer;

    try {
      const sharp = (await import("sharp")).default;
      jpegBuffer = await sharp(pngBuffer).jpeg({ quality: 80 }).toBuffer();
    } catch {
      // sharp not available — send PNG
      jpegBuffer = pngBuffer;
    }

    return {
      success: true,
      screenshotBuffer: jpegBuffer,
      screenshotMeta: {
        width: result.imageWidth,
        height: result.imageHeight,
        format: "jpeg",
        coordMap: result.coordMap,
      },
    };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

async function doClick(params: Record<string, unknown>): Promise<ExecutionResult> {
  const usecomputer = await getUC();
  const x = Number(params.x);
  const y = Number(params.y);
  await usecomputer.click({ point: { x, y }, button: "left", count: 1 });
  return { success: true, data: { action: "click", x, y } };
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

async function listWindows(): Promise<ExecutionResult> {
  const usecomputer = await getUC();
  const windows = await usecomputer.windowList();
  return { success: true, data: { windows } };
}
