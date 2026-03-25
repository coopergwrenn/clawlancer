/**
 * Supervisor — prompts user for approval before executing commands.
 * Screenshots are auto-approved. All other actions require Enter to proceed.
 */
import readline from "readline";
import type { DispatchCommand } from "./types.js";

const AUTO_APPROVE_TYPES = new Set(["screenshot", "windows", "status"]);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

export async function requestApproval(command: DispatchCommand): Promise<boolean> {
  // Auto-approve passive commands
  if (AUTO_APPROVE_TYPES.has(command.type)) {
    return true;
  }

  const desc = formatCommand(command);
  console.log(`\n  Agent wants to: ${desc}`);

  return new Promise((resolve) => {
    rl.question("  [Enter] to approve, [n] to deny: ", (answer) => {
      const denied = answer.trim().toLowerCase() === "n";
      if (denied) {
        console.log("  Denied.");
      }
      resolve(!denied);
    });
  });
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
  rl.close();
}
