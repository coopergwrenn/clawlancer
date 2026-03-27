#!/usr/bin/env node
/**
 * @instaclaw/dispatch — Local relay for InstaClaw agents to control your computer.
 *
 * Usage:
 *   npx @instaclaw/dispatch                          # Interactive (pairing code)
 *   npx @instaclaw/dispatch --pair ABCD-1234         # Pair with code
 *   npx @instaclaw/dispatch --token XXX --vm HOST    # Direct connect (advanced)
 */
import { loadConfig, saveConfig, getConfigPath } from "./config.js";
import { checkPermissions, printPermissionGuide, runPermissionTest } from "./permissions.js";
import { connect, disconnect } from "./connection.js";
import { closeSupervisor, setMode } from "./supervisor.js";
import chalk from "chalk";
import readline from "readline";
import os from "os";
import fs from "fs";
import path from "path";
import type { DispatchConfig } from "./types.js";

const API_BASE = "https://instaclaw.io";

// Temp file to persist pairing code + args across Terminal restarts
const RETRY_FILE = path.join(os.tmpdir(), "instaclaw-dispatch-retry.json");
const RETRY_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

async function main() {
  console.log(`
  ${chalk.bold("InstaClaw Dispatch")} ${chalk.dim("— Remote Computer Control")}
  ${chalk.dim("─────────────────────────────────────────────")}
  `);

  const args = parseArgs();

  // ── Auto-retry: check if we're resuming after a Terminal restart ──
  const retry = loadRetryState();
  if (!args.pair && !args.token && retry) {
    console.log(`  ${chalk.cyan("↻")} Resuming after Terminal restart...`);
    console.log(`  ${chalk.dim("Pairing code:")} ${chalk.bold(retry.pair)}\n`);
    args.pair = retry.pair;
    if (retry.autonomous) args.autonomous = true;
    clearRetryState();
  }

  // ── 1. Check permissions FIRST (before consuming pairing code) ──
  if (os.platform() === "darwin") {
    console.log("  Checking permissions...");
    const perms = checkPermissions();

    if (perms.accessibility === false || perms.screenRecording === false) {
      const terminal = getTerminalName();

      // Save state so we can auto-resume after Terminal restart
      if (args.pair) {
        saveRetryState({ pair: args.pair, autonomous: args.autonomous });
      }

      console.log("");

      if (perms.accessibility === false) {
        console.log(`  ${chalk.red("✗")} Accessibility: ${chalk.bold("NOT GRANTED")}`);
        console.log(`    → System Settings → Privacy & Security → Accessibility`);
        console.log(`    → Enable "${terminal}"`);
        console.log("");
        console.log(chalk.yellow(`  ⚠  Enabling Accessibility will close ${terminal}.`));
        console.log(chalk.yellow(`     Don't worry — just reopen ${terminal} and run the same command.`));
        if (args.pair) {
          console.log(chalk.green(`     Your pairing code ${chalk.bold(args.pair)} will still work.`));
        }
        console.log("");
      }

      if (perms.screenRecording === false) {
        console.log(`  ${chalk.red("✗")} Screen Recording: ${chalk.bold("NOT GRANTED")}`);
        console.log(`    → System Settings → Privacy & Security → Screen Recording`);
        console.log(`    → Enable "${terminal}"`);
        console.log("");
      }

      if (perms.accessibility === true && perms.screenRecording === false) {
        // Only Screen Recording is missing — Terminal won't be killed
        console.log(`  Grant Screen Recording, then press ${chalk.bold("Enter")} to continue...`);
        await waitForEnter();
        // Re-check
        const recheck = checkPermissions();
        if (recheck.screenRecording === false) {
          console.log(`  ${chalk.yellow("⚠")} Screen Recording still not granted. Screenshots may not work.\n`);
        } else {
          console.log(`  ${chalk.green("✓")} Screen Recording: OK\n`);
        }
      } else if (perms.accessibility === false) {
        // Accessibility is missing — Terminal WILL be killed
        console.log(`  After granting permissions and reopening ${terminal}, run:`);
        console.log("");
        if (args.pair) {
          console.log(`  ${chalk.cyan(`npx @instaclaw/dispatch@0.5.0 --pair ${args.pair}`)}`);
        } else {
          console.log(`  ${chalk.cyan("npx @instaclaw/dispatch")}`);
        }
        console.log("");
        console.log(`  ${chalk.dim("Or just reopen Terminal — we'll auto-resume if possible.")}`);
        console.log("");
        console.log(`  Press ${chalk.bold("Enter")} when ready (or grant Accessibility and Terminal will restart)...`);
        await waitForEnter();

        // If we get here, user pressed Enter without Terminal being killed
        const recheck = checkPermissions();
        if (recheck.accessibility === false) {
          console.log(`\n  ${chalk.yellow("⚠")} Accessibility still not granted. Click/type commands will fail.`);
          console.log(`  ${chalk.dim("Continuing anyway — screenshots may still work.\n")}`);
        } else {
          console.log(`\n  ${chalk.green("✓")} Permissions: all OK\n`);
          clearRetryState();
        }
      }
    } else {
      // All permissions OK — run functional test
      console.log("  Running permission test...");
      const test = await runPermissionTest();
      if (test.ok) {
        console.log(`  ${chalk.green("✓")} Permissions: all OK\n`);
      } else {
        console.log(`  ${chalk.yellow("⚠")} ${test.error}`);
        console.log("  Continuing anyway — some commands may fail.\n");
      }
      clearRetryState();
    }
  }

  // ── 2. Resolve config: --pair, --token+--vm, saved config, or interactive ──
  let config = loadConfig();

  // Path A: Pairing code (simplest)
  if (args.pair) {
    console.log(`  Redeeming pairing code ${chalk.bold(args.pair)}...`);
    const result = await redeemPairingCode(args.pair);
    if (result) {
      config = { gatewayToken: result.token, vmAddress: result.vmAddress, port: 8765, mode: "supervised" };
      saveConfig(config);
      console.log(`  ${chalk.green("✓")} Paired successfully\n`);
      clearRetryState();
    } else {
      process.exit(1);
    }
  }
  // Path B: Direct token + VM (advanced)
  else if (args.token && args.vm) {
    config = {
      gatewayToken: args.token,
      vmAddress: args.vm,
      port: args.port || 8765,
      mode: args.autonomous ? "autonomous" : "supervised",
    };
    saveConfig(config);
  }
  // Path C: No args — interactive setup
  else if (!config?.gatewayToken || !config?.vmAddress) {
    config = await interactiveSetup(config);
    saveConfig(config);
    console.log(`  Config saved to ${getConfigPath()}\n`);
  }

  // Set supervisor mode
  if (config.mode === "autonomous" || args.autonomous) {
    config.mode = "autonomous";
    setMode("autonomous");
  }

  console.log(`  ${chalk.dim("VM:")}   ${config.vmAddress}:${config.port}`);
  console.log(`  ${chalk.dim("Mode:")} ${config.mode}`);
  console.log(`  ${chalk.dim("Token:")} ${config.gatewayToken.substring(0, 8)}...\n`);

  // ── 3. Connect to VM ──
  connect({
    vmAddress: config.vmAddress,
    port: config.port,
    gatewayToken: config.gatewayToken,
    mode: config.mode,
    rejectUnauthorized: false,
    certFingerprint: config.certFingerprint,
    onConnect: () => {
      console.log("");
      console.log(`  ${chalk.green("✓")} ${chalk.bold("Connected to your agent!")}`);
      console.log(`  ${chalk.dim("Mode:")} ${config!.mode === "autonomous" ? chalk.yellow("Autonomous") : chalk.green("Supervised")}`);
      console.log(`  ${chalk.dim("Your agent can now control this computer.")}`);
      console.log("");
      console.log(`  ${chalk.dim("Press 'a' to toggle mode. Ctrl+C to disconnect.")}`);
      console.log("");

      // Runtime mode switching
      if (process.stdin.isTTY) {
        process.stdin.setRawMode?.(false);
        process.stdin.on("data", (chunk) => {
          const key = chunk.toString().trim().toLowerCase();
          if (key === "a") {
            const newMode = config!.mode === "supervised" ? "autonomous" : "supervised";
            config!.mode = newMode;
            setMode(newMode);
            saveConfig(config!);
            console.log(`\n  Mode: ${newMode === "autonomous" ? chalk.yellow("AUTONOMOUS") : chalk.green("SUPERVISED")}\n`);
          }
        });
      }
    },
    onDisconnect: () => {},
    onCertFingerprint: (fp) => {
      if (config && !config.certFingerprint) {
        config.certFingerprint = fp;
        saveConfig(config);
      }
    },
  });

  // ── 4. Ctrl+C ──
  process.on("SIGINT", () => {
    console.log(`\n  ${chalk.dim("Disconnecting...")}`);
    disconnect();
    closeSupervisor();
    process.exit(0);
  });
}

// ── Retry State (persists across Terminal restarts) ──

function saveRetryState(state: { pair: string; autonomous?: boolean }) {
  try {
    fs.writeFileSync(RETRY_FILE, JSON.stringify({ ...state, ts: Date.now() }));
  } catch {}
}

function loadRetryState(): { pair: string; autonomous?: boolean } | null {
  try {
    if (!fs.existsSync(RETRY_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(RETRY_FILE, "utf-8"));
    // Only use if recent (within 10 min)
    if (Date.now() - data.ts > RETRY_MAX_AGE_MS) {
      clearRetryState();
      return null;
    }
    if (!data.pair) return null;
    return { pair: data.pair, autonomous: data.autonomous };
  } catch {
    return null;
  }
}

function clearRetryState() {
  try { fs.unlinkSync(RETRY_FILE); } catch {}
}

function getTerminalName(): string {
  const terminal = process.env.TERM_PROGRAM || "your terminal app";
  return ({
    "Apple_Terminal": "Terminal",
    "iTerm.app": "iTerm2",
    "vscode": "Visual Studio Code",
    "WarpTerminal": "Warp",
  } as Record<string, string>)[terminal] || terminal;
}

// ── Pairing Code ──

async function redeemPairingCode(code: string): Promise<{ token: string; vmAddress: string } | null> {
  try {
    const res = await fetch(`${API_BASE}/api/vm/dispatch-pair/${encodeURIComponent(code)}`);
    const data = await res.json();
    if (data.error) {
      console.log(`  ${chalk.red("✗")} ${data.error}`);
      return null;
    }
    return { token: data.token, vmAddress: data.vmAddress };
  } catch (err) {
    console.log(`  ${chalk.red("✗")} Failed to redeem pairing code: ${err}`);
    return null;
  }
}

// ── Interactive Setup ──

async function interactiveSetup(existing: DispatchConfig | null): Promise<DispatchConfig> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (q: string, def?: string): Promise<string> =>
    new Promise((resolve) => {
      const prompt = def ? `${q} [${def}]: ` : `${q}: `;
      rl.question(`  ${prompt}`, (ans) => resolve(ans.trim() || def || ""));
    });

  console.log(`  ${chalk.bold("Welcome!")} Let's connect to your agent.\n`);
  console.log(`  Got a pairing code from ${chalk.underline("instaclaw.io/settings")}?`);

  const input = await ask("Enter pairing code (or 'a' for advanced setup)");

  // Check if it's a pairing code (format: XXXX-YYYY)
  if (input.toLowerCase() === "a") {
    // Advanced: manual token + IP
    console.log("");
    let token = await ask("Gateway token", existing?.gatewayToken);
    let vm = await ask("VM address (IP)", existing?.vmAddress);

    // Swap detection
    const isHexLong = (s: string) => /^[0-9a-f]{32,}$/i.test(s);
    const isIPish = (s: string) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s);

    if (isHexLong(vm)) {
      console.log(chalk.yellow("\n  That looks like a gateway token, not an IP address."));
      const swap = await ask("Enter your VM IP");
      if (swap) { token = vm; vm = swap; }
    } else if (isIPish(token)) {
      console.log(chalk.yellow("\n  That looks like an IP, not a gateway token."));
      const swap = await ask("Enter your gateway token");
      if (swap) { vm = token; token = swap; }
    }

    rl.close();
    return { gatewayToken: token, vmAddress: vm, port: 8765, mode: "supervised" };
  }

  // It's a pairing code or something else
  const isHexLong = (s: string) => /^[0-9a-f]{32,}$/i.test(s);
  if (isHexLong(input)) {
    console.log(chalk.yellow("\n  That looks like a gateway token, not a pairing code."));
    console.log(`  Get your pairing code at ${chalk.underline("instaclaw.io/settings")}`);
    console.log(`  Or press 'a' for advanced setup.\n`);
    rl.close();
    return interactiveSetup(existing); // Retry
  }

  // Try to redeem as pairing code
  rl.close();
  const result = await redeemPairingCode(input);
  if (result) {
    return { gatewayToken: result.token, vmAddress: result.vmAddress, port: 8765, mode: "supervised" };
  }

  // Failed — fall back to advanced
  console.log("  Falling back to advanced setup...\n");
  return interactiveSetup(existing);
}

// ── Arg Parsing ──

function parseArgs(): { token?: string; vm?: string; port?: number; autonomous?: boolean; pair?: string } {
  const args = process.argv.slice(2);
  const result: { token?: string; vm?: string; port?: number; autonomous?: boolean; pair?: string } = {};

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--token" || args[i] === "-t") && args[i + 1]) {
      result.token = args[++i];
    } else if ((args[i] === "--vm" || args[i] === "-v") && args[i + 1]) {
      result.vm = args[++i];
    } else if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
      result.port = parseInt(args[++i], 10);
    } else if (args[i] === "--autonomous" || args[i] === "--auto") {
      result.autonomous = true;
    } else if ((args[i] === "--pair" || args[i] === "--code") && args[i + 1]) {
      result.pair = args[++i];
    }
  }
  return result;
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("", () => { rl.close(); resolve(); });
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
