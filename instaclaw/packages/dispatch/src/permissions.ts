import { execSync } from "child_process";
import os from "os";
import fs from "fs";
import path from "path";

interface PermissionStatus {
  accessibility: boolean | "unknown";
  screenRecording: boolean | "unknown";
  platform: string;
}

export function checkPermissions(): PermissionStatus {
  const platform = os.platform();

  if (platform === "darwin") {
    return checkMacPermissions();
  }

  // Linux/Windows — no special permissions needed
  return { accessibility: true, screenRecording: true, platform };
}

function checkMacPermissions(): PermissionStatus {
  let accessibility: boolean | "unknown" = "unknown";
  let screenRecording: boolean | "unknown" = "unknown";

  // Check Accessibility via TCC database
  // macOS stores permission grants in ~/Library/Application Support/com.apple.TCC/TCC.db
  // and /Library/Application Support/com.apple.TCC/TCC.db (system)
  // We can try a quick test: usecomputer mouse position (fails without accessibility)
  try {
    const result = execSync(
      'osascript -e \'tell application "System Events" to get name of first process\'',
      { timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }
    );
    accessibility = true;
  } catch {
    // AppleScript fails without Accessibility permission
    accessibility = false;
  }

  // Check Screen Recording by attempting a tiny screenshot
  // CGWindowListCreateImage returns a null/empty image without Screen Recording permission
  try {
    const tmpFile = path.join(os.tmpdir(), `dispatch-perm-check-${Date.now()}.png`);
    execSync(`screencapture -x -t png "${tmpFile}" 2>/dev/null`, { timeout: 5000 });
    if (fs.existsSync(tmpFile)) {
      const size = fs.statSync(tmpFile).size;
      fs.unlinkSync(tmpFile);
      // A valid screenshot is at least a few KB. A blocked capture may produce a tiny or empty file.
      screenRecording = size > 500;
    } else {
      screenRecording = false;
    }
  } catch {
    screenRecording = false;
  }

  return { accessibility, screenRecording, platform: "darwin" };
}

/**
 * Run a quick functional test: take a screenshot via usecomputer.
 * If it fails, permissions are likely missing.
 */
export async function runPermissionTest(): Promise<{ ok: boolean; error?: string }> {
  try {
    const uc = await import("usecomputer");
    const tmpPath = path.join(os.tmpdir(), `dispatch-test-${Date.now()}.png`);
    await uc.screenshot({ path: tmpPath, display: null, window: null, region: null, annotate: null });

    if (fs.existsSync(tmpPath)) {
      const size = fs.statSync(tmpPath).size;
      fs.unlinkSync(tmpPath);
      if (size > 500) return { ok: true };
      return { ok: false, error: "Screenshot captured but empty — Screen Recording permission may be missing" };
    }
    return { ok: false, error: "Screenshot file not created" };
  } catch (err) {
    const msg = String(err);
    if (msg.includes("EVENT_POST_FAILED") || msg.includes("CGEvent")) {
      return { ok: false, error: "Accessibility permission not granted" };
    }
    if (msg.includes("CAPTURE_FAILED")) {
      return { ok: false, error: "Screen Recording permission not granted" };
    }
    return { ok: false, error: msg.slice(0, 100) };
  }
}

export function printPermissionGuide(status: PermissionStatus): void {
  const platform = status.platform;

  if (platform === "darwin") {
    const terminal = process.env.TERM_PROGRAM || "your terminal app";
    const terminalName = ({
      "Apple_Terminal": "Terminal",
      "iTerm.app": "iTerm2",
      "vscode": "Visual Studio Code",
      "WarpTerminal": "Warp",
    } as Record<string, string>)[terminal] || terminal;

    console.log("");

    if (status.screenRecording === false) {
      console.log(`  Screen Recording: NOT GRANTED`);
      console.log(`    → System Settings → Privacy & Security → Screen Recording`);
      console.log(`    → Enable "${terminalName}"`);
      console.log(`    → You may need to restart ${terminalName} after granting`);
      console.log("");
    } else {
      console.log(`  Screen Recording: OK`);
    }

    if (status.accessibility === false) {
      console.log(`  Accessibility: NOT GRANTED`);
      console.log(`    → System Settings → Privacy & Security → Accessibility`);
      console.log(`    → Enable "${terminalName}"`);
      console.log("");
    } else {
      console.log(`  Accessibility: OK`);
    }

    if (status.screenRecording === false || status.accessibility === false) {
      console.log(`  After granting permissions, press Enter to continue...`);
    }
  } else if (platform === "linux") {
    console.log(`  Linux: No special permissions needed.`);
  } else {
    console.log(`  Windows: No special permissions needed.`);
  }
}
