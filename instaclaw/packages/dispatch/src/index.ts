#!/usr/bin/env node
/**
 * @instaclaw/dispatch — Local relay for InstaClaw agents to control your computer.
 *
 * Usage:
 *   npx @instaclaw/dispatch                    # Interactive setup
 *   npx @instaclaw/dispatch --token XXX --vm HOST  # Direct connect
 */
import { loadConfig, saveConfig, getConfigPath } from "./config.js";
import { checkPermissions, printPermissionGuide, runPermissionTest } from "./permissions.js";
import { connect, disconnect } from "./connection.js";
import { closeSupervisor, setMode } from "./supervisor.js";
import readline from "readline";
import os from "os";
import type { DispatchConfig } from "./types.js";

async function main() {
  console.log(`
  InstaClaw Dispatch — Remote Computer Control
  ─────────────────────────────────────────────
  `);

  // 1. Check permissions (macOS only)
  if (os.platform() === "darwin") {
    console.log("  Checking permissions...");
    const perms = checkPermissions();
    printPermissionGuide(perms);

    if (perms.screenRecording === false || perms.accessibility === false) {
      await waitForEnter();
      // Re-check after user grants
      const recheck = checkPermissions();
      if (recheck.screenRecording === false) {
        console.log("  Warning: Screen Recording still not granted. Screenshots may fail.\n");
      }
      if (recheck.accessibility === false) {
        console.log("  Warning: Accessibility still not granted. Click/type may fail.\n");
      }
    } else {
      // Run a functional test to be sure
      console.log("  Running permission test...");
      const test = await runPermissionTest();
      if (test.ok) {
        console.log("  Permissions: all OK\n");
      } else {
        console.log(`  Warning: ${test.error}`);
        console.log("  Continuing anyway — some commands may fail.\n");
      }
    }
  }

  // 2. Load or create config
  let config = loadConfig();
  const args = parseArgs();

  if (args.token && args.vm) {
    // CLI args override config
    config = {
      gatewayToken: args.token,
      vmAddress: args.vm,
      port: args.port || 8765,
      mode: args.autonomous ? "autonomous" : "supervised",
    };
    saveConfig(config);
  }

  if (!config?.gatewayToken || !config?.vmAddress) {
    // Interactive setup
    config = await interactiveSetup(config);
    saveConfig(config);
    console.log(`  Config saved to ${getConfigPath()}\n`);
  }

  // Set supervisor mode
  if (config.mode === "autonomous") {
    setMode("autonomous");
  }

  console.log(`  VM:   ${config.vmAddress}:${config.port}`);
  console.log(`  Mode: ${config.mode}`);
  console.log(`  Token: ${config.gatewayToken.substring(0, 8)}...\n`);

  // 3. Connect to VM
  connect({
    vmAddress: config.vmAddress,
    port: config.port,
    gatewayToken: config.gatewayToken,
    mode: config.mode,
    rejectUnauthorized: false, // Accept self-signed (TOFU)
    certFingerprint: config.certFingerprint,
    onConnect: () => {
      if (config!.mode === "autonomous") {
        console.log(`\n  Dispatch mode: AUTONOMOUS`);
        console.log(`  All actions auto-approved (dangerous actions still require confirmation).`);
      } else {
        console.log(`\n  Dispatch mode: SUPERVISED`);
        console.log(`  Screenshots auto-approved. Actions require [Enter] to confirm.`);
      }
      console.log(`  Press Ctrl+C to disconnect.\n`);
    },
    onDisconnect: () => {
      // Will auto-reconnect
    },
    onCertFingerprint: (fp) => {
      // TOFU: save fingerprint on first connection
      if (config && !config.certFingerprint) {
        config.certFingerprint = fp;
        saveConfig(config);
        console.log(`  TLS fingerprint saved (TOFU): ${fp.substring(0, 20)}...`);
      }
    },
  });

  // 4. Handle Ctrl+C
  process.on("SIGINT", () => {
    console.log("\n  Disconnecting...");
    disconnect();
    closeSupervisor();
    process.exit(0);
  });
}

async function interactiveSetup(existing: DispatchConfig | null): Promise<DispatchConfig> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (q: string, def?: string): Promise<string> =>
    new Promise((resolve) => {
      const prompt = def ? `${q} [${def}]: ` : `${q}: `;
      rl.question(`  ${prompt}`, (ans) => resolve(ans.trim() || def || ""));
    });

  console.log("  First-time setup:\n");

  const token = await ask("Gateway token", existing?.gatewayToken);
  const vm = await ask("VM address (IP or hostname)", existing?.vmAddress);
  const portStr = await ask("Port", String(existing?.port || 8765));

  rl.close();

  return {
    gatewayToken: token,
    vmAddress: vm,
    port: parseInt(portStr, 10) || 8765,
    mode: "supervised",
    certFingerprint: existing?.certFingerprint,
  };
}

function parseArgs(): { token?: string; vm?: string; port?: number; autonomous?: boolean } {
  const args = process.argv.slice(2);
  const result: { token?: string; vm?: string; port?: number; autonomous?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--token" || args[i] === "-t") && args[i + 1]) {
      result.token = args[++i];
    } else if ((args[i] === "--vm" || args[i] === "-v") && args[i + 1]) {
      result.vm = args[++i];
    } else if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
      result.port = parseInt(args[++i], 10);
    } else if (args[i] === "--autonomous" || args[i] === "--auto") {
      result.autonomous = true;
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
