/**
 * Supervisor — controls whether commands need user approval.
 *
 * Modes:
 *   supervised (default) — all non-passive commands require Enter to approve
 *   autonomous — auto-approves most commands, but ALWAYS prompts for dangerous ones
 */
import readline from "readline";
import type { DispatchCommand } from "./types.js";

const AUTO_APPROVE_TYPES = new Set(["screenshot", "windows", "status"]);

// Patterns that indicate dangerous actions — always require confirmation even in autonomous mode
const DANGEROUS_TEXT_PATTERNS = [
  // Authentication
  /password/i, /passwd/i, /secret/i, /credential/i,
  /\b2fa\b/i, /\bmfa\b/i, /authenticat/i, /verification.?code/i, /one.?time.?pass/i,
  // Destructive
  /delete/i, /remove/i, /destroy/i, /format/i, /erase/i, /empty.?trash/i,
  // Financial
  /purchase/i, /submit.*order/i, /confirm.*payment/i, /buy\s/i,
  /transfer.*fund/i, /send.*money/i, /withdraw/i,
  // System
  /sudo\s/i, /rm\s+-rf/i, /shutdown/i, /reboot/i, /restart/i,
  /\binstall\b/i, /\bapt\b/i, /\bbrew\b/i, /\bnpm\s+i/i, /pip\s+install/i,
];

const DANGEROUS_KEY_COMBOS = new Set([
  "cmd+delete", "cmd+shift+delete", "ctrl+delete",
  "cmd+q", "alt+f4",
  "cmd+shift+backspace", // Empty Trash on macOS
]);

let mode: "supervised" | "autonomous" = "supervised";
const isTTY = process.stdin.isTTY ?? false;

let rl: readline.Interface | null = null;
if (isTTY) {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

export function setMode(m: "supervised" | "autonomous"): void {
  mode = m;
}

export async function requestApproval(command: DispatchCommand): Promise<boolean> {
  // Always auto-approve passive commands
  if (AUTO_APPROVE_TYPES.has(command.type)) {
    return true;
  }

  const desc = formatCommand(command);
  const dangerous = isDangerous(command);

  // Non-interactive (no TTY) — auto-approve everything (can't prompt)
  if (!rl) {
    if (dangerous) {
      console.log(`\n  BLOCKED (dangerous, no TTY): ${desc}`);
      return false;
    }
    console.log(`\n  Agent wants to: ${desc}`);
    console.log("  Auto-approved (non-interactive mode)");
    return true;
  }

  // Autonomous mode — auto-approve non-dangerous actions
  if (mode === "autonomous" && !dangerous) {
    console.log(`\n  Agent: ${desc}`);
    return true;
  }

  // Supervised mode OR dangerous action in autonomous mode — prompt user
  console.log(`\n  Agent wants to: ${desc}`);
  if (dangerous) {
    console.log("  ⚠️  DANGEROUS ACTION — requires confirmation");
  }

  return new Promise((resolve) => {
    rl!.question("  [Enter] to approve, [n] to deny: ", (answer) => {
      const denied = answer.trim().toLowerCase() === "n";
      if (denied) {
        console.log("  Denied.");
      }
      resolve(!denied);
    });
  });
}

function isDangerous(cmd: DispatchCommand): boolean {
  const p = cmd.params;

  if (cmd.type === "type") {
    const text = String(p.text || "");
    return DANGEROUS_TEXT_PATTERNS.some((pat) => pat.test(text));
  }

  if (cmd.type === "press") {
    const key = String(p.key || "").toLowerCase();
    return DANGEROUS_KEY_COMBOS.has(key);
  }

  return false;
}

function formatCommand(cmd: DispatchCommand): string {
  const p = cmd.params;
  switch (cmd.type) {
    case "click":
      return `Click at (${p.x}, ${p.y})${cmd.description ? ` — "${cmd.description}"` : ""}`;
    case "type":
      return `Type: "${String(p.text).substring(0, 50)}${String(p.text).length > 50 ? "..." : ""}"`;
    case "press":
      return `Press key: ${p.key}`;
    case "scroll":
      return `Scroll ${p.direction} by ${p.amount || 3}`;
    case "drag":
      return `Drag from (${p.fromX}, ${p.fromY}) to (${p.toX}, ${p.toY})`;
    default:
      return `${cmd.type}: ${JSON.stringify(p).substring(0, 80)}`;
  }
}

export function closeSupervisor(): void {
  rl?.close();
}
