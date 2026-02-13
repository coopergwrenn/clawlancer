/**
 * Clean aGDP from ALL existing VMs
 *
 * For every VM with an IP address in Supabase, SSHes in and:
 *   1. Removes ~/virtuals-protocol-acp/ directory
 *   2. Clears skills.load.extraDirs config
 *   3. Removes "## Marketplace Priority" block from system-prompt.md
 *   4. Restarts the gateway
 *
 * Run with: node scripts/clean-agdp-all-vms.mjs
 *
 * Requires .env.local with:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SSH_PRIVATE_KEY_B64
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dirname, "..", "instaclaw", "node_modules", "_placeholder.js"));

const { createClient } = require("@supabase/supabase-js");
const { Client } = require("ssh2");
const dotenv = require("dotenv");

dotenv.config({ path: join(__dirname, "..", "instaclaw", ".env.local") });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SSH_KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64, "base64").toString(
  "utf-8"
);

const NVM =
  'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"';

function sshExec(host, port, user, command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";

    conn
      .on("ready", () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          stream
            .on("close", (code) => {
              conn.end();
              resolve({ code, stdout, stderr });
            })
            .on("data", (data) => {
              stdout += data.toString();
            })
            .stderr.on("data", (data) => {
              stderr += data.toString();
            });
        });
      })
      .on("error", (err) => {
        reject(err);
      })
      .connect({
        host,
        port,
        username: user,
        privateKey: SSH_KEY,
        readyTimeout: 15000,
      });
  });
}

async function cleanVM(vm) {
  const label = `${vm.id} (${vm.ip_address})`;
  const host = vm.ip_address;
  const port = vm.ssh_port || 22;
  const user = vm.ssh_user || "openclaw";

  try {
    // Build cleanup script
    const script = [
      "#!/bin/bash",
      "set -eo pipefail",
      NVM,
      "",
      "RESULTS=''",
      "",
      '# 1. Remove aGDP repo directory',
      'if [ -d "$HOME/virtuals-protocol-acp" ]; then',
      '  rm -rf "$HOME/virtuals-protocol-acp"',
      '  RESULTS="${RESULTS}REMOVED_DIR "',
      "else",
      '  RESULTS="${RESULTS}NO_DIR "',
      "fi",
      "",
      '# 2. Clear extraDirs config (reset to empty array)',
      "openclaw config set skills.load.extraDirs '[]' 2>/dev/null && RESULTS=\"${RESULTS}CLEARED_EXTRADIRS \" || RESULTS=\"${RESULTS}NO_EXTRADIRS \"",
      "",
      '# 3. Remove Marketplace Priority block from system-prompt.md',
      'PROMPT_FILE="$HOME/.openclaw/agents/main/agent/system-prompt.md"',
      'if [ -f "$PROMPT_FILE" ] && grep -qF "## Marketplace Priority" "$PROMPT_FILE" 2>/dev/null; then',
      "  sed -i '/^## Marketplace Priority$/,/^$/d' \"$PROMPT_FILE\"",
      '  RESULTS="${RESULTS}REMOVED_PROMPT "',
      "else",
      '  RESULTS="${RESULTS}NO_PROMPT "',
      "fi",
      "",
      '# 4. Restart gateway',
      'pkill -f "openclaw gateway" 2>/dev/null || true',
      "sleep 2",
      'nohup openclaw gateway run --bind lan --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &',
      "sleep 3",
      "",
      'echo "CLEAN_DONE ${RESULTS}"',
    ].join("\n");

    // Write script to temp file and execute
    await sshExec(
      host,
      port,
      user,
      `cat > /tmp/ic-clean-agdp.sh << 'ICEOF'\n${script}\nICEOF`
    );
    const result = await sshExec(
      host,
      port,
      user,
      "bash /tmp/ic-clean-agdp.sh; EC=$?; rm -f /tmp/ic-clean-agdp.sh; exit $EC"
    );

    if (result.stdout.includes("CLEAN_DONE")) {
      const wasContaminated =
        result.stdout.includes("REMOVED_DIR") ||
        result.stdout.includes("REMOVED_PROMPT");
      const status = wasContaminated ? "CLEANED" : "ALREADY_CLEAN";
      const details = result.stdout
        .replace("CLEAN_DONE", "")
        .trim();
      console.log(`  ${status}  ${label}  [${details}]`);
      return { vm: label, status, details };
    } else {
      console.log(`  FAILED   ${label}  stderr: ${result.stderr.slice(0, 200)}`);
      return { vm: label, status: "FAILED", details: result.stderr.slice(0, 200) };
    }
  } catch (err) {
    const msg = err.message || String(err);
    console.log(`  ERROR    ${label}  ${msg.slice(0, 120)}`);
    return { vm: label, status: "ERROR", details: msg.slice(0, 120) };
  }
}

async function main() {
  console.log("=== aGDP Cleanup — All VMs ===\n");

  // Query ALL VMs with an IP address
  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, status, assigned_to, agdp_enabled")
    .not("ip_address", "is", null)
    .order("id");

  if (error) {
    console.error("Failed to query VMs:", error);
    process.exit(1);
  }

  console.log(`Found ${vms.length} VMs with IP addresses\n`);

  const results = [];
  for (const vm of vms) {
    const r = await cleanVM(vm);
    results.push(r);

    // Also reset agdp_enabled to false in Supabase
    await supabase
      .from("instaclaw_vms")
      .update({ agdp_enabled: false })
      .eq("id", vm.id);
  }

  // Summary
  console.log("\n=== Summary ===");
  const cleaned = results.filter((r) => r.status === "CLEANED").length;
  const alreadyClean = results.filter((r) => r.status === "ALREADY_CLEAN").length;
  const failed = results.filter(
    (r) => r.status === "FAILED" || r.status === "ERROR"
  ).length;
  console.log(`Total VMs:      ${results.length}`);
  console.log(`Cleaned:        ${cleaned}`);
  console.log(`Already clean:  ${alreadyClean}`);
  console.log(`Failed/Error:   ${failed}`);

  if (failed > 0) {
    console.log("\nFailed VMs:");
    results
      .filter((r) => r.status === "FAILED" || r.status === "ERROR")
      .forEach((r) => console.log(`  ${r.vm}: ${r.details}`));
  }

  console.log("\nAll agdp_enabled flags reset to false in Supabase.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
