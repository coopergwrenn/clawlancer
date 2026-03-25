import { execSync } from "child_process";
import os from "os";

interface PermissionStatus {
  accessibility: boolean;
  screenRecording: boolean;
  platform: string;
}

export function checkPermissions(): PermissionStatus {
  const platform = os.platform();

  if (platform === "darwin") {
    return checkMacPermissions();
  }

  // Linux/Windows — no special permissions needed for X11
  return { accessibility: true, screenRecording: true, platform };
}

function checkMacPermissions(): PermissionStatus {
  let accessibility = false;
  let screenRecording = false;

  // Check accessibility: try to create a CGEvent (will fail without permission)
  // We can't check directly from Node — usecomputer will fail at runtime if missing
  // For now, assume true and catch errors at execution time
  accessibility = true; // Will validate on first command

  // Screen recording: same — can't check from Node without native module
  screenRecording = true;

  return { accessibility, screenRecording, platform: "darwin" };
}

export function printPermissionGuide(): void {
  const platform = os.platform();

  if (platform === "darwin") {
    console.log(`
  To grant permissions (macOS):
    1. System Settings → Privacy & Security → Accessibility
       → Add your terminal app (Terminal, iTerm, Warp, etc.)
    2. System Settings → Privacy & Security → Screen Recording
       → Add your terminal app

  Press Enter after granting permissions...`);
  } else if (platform === "linux") {
    console.log(`
  Linux: No special permissions needed.
  Ensure DISPLAY is set if using X11.`);
  } else {
    console.log(`
  Windows: No special permissions needed.
  Run as administrator if controlling elevated apps.`);
  }
}
