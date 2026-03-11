/**
 * Fleet-patch: deploy push-heartbeat.sh to all assigned VMs.
 *
 * For each VM:
 * 1. Write ~/.openclaw/scripts/push-heartbeat.sh
 * 2. chmod +x
 * 3. Install crontab entry (idempotent — checks marker first)
 * 4. Run once immediately, expect HTTP 200
 * 5. Verify heartbeat_last_at updated in DB
 *
 * Supports --dry-run, --canary (2 VMs), --all per CLAUDE.md rules.
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.join(__dirname, "../.env.local") });
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

const DRY_RUN = process.argv.includes("--dry-run");
const CANARY = process.argv.includes("--canary");
const ALL = process.argv.includes("--all");

if (!DRY_RUN && !CANARY && !ALL) {
  console.log("Usage: npx ts-node _fleet-patch-push-heartbeat.ts [--dry-run | --canary | --all]");
  console.log("  --dry-run  Show what would be done");
  console.log("  --canary   Patch first 2 VMs only");
  console.log("  --all      Patch all assigned VMs");
  process.exit(1);
}

const SCRIPT_CONTENT = `#!/bin/bash
# Push-based heartbeat — POSTs to instaclaw.io every hour via crontab
TOKEN=$(grep '^GATEWAY_TOKEN=' ~/.openclaw/.env | cut -d= -f2)
LOGFILE=~/.openclaw/logs/heartbeat.log
mkdir -p ~/.openclaw/logs
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST \\
  -H "Authorization: Bearer $TOKEN" \\
  https://instaclaw.io/api/vm/heartbeat 2>/dev/null)
echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') status=$STATUS" >> "$LOGFILE"
# Keep log from growing forever — last 500 lines
tail -500 "$LOGFILE" > "$LOGFILE.tmp" && mv "$LOGFILE.tmp" "$LOGFILE"
`;

const CRON_LINE = "0 * * * * bash ~/.openclaw/scripts/push-heartbeat.sh";
const CRON_MARKER = "push-heartbeat.sh";

interface VM {
  id: string;
  name: string;
  ip_address: string;
  assigned_to: string | null;
  heartbeat_last_at: string | null;
}

async function patchVM(vm: VM): Promise<{ success: boolean; msg: string }> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: vm.ip_address, username: "openclaw", privateKey: sshKey, readyTimeout: 15000 });

    if (DRY_RUN) {
      const hasScript = await ssh.execCommand("test -f ~/.openclaw/scripts/push-heartbeat.sh && echo YES || echo NO");
      const hasCron = await ssh.execCommand(`crontab -l 2>/dev/null | grep -q '${CRON_MARKER}' && echo YES || echo NO`);
      ssh.dispose();
      return {
        success: true,
        msg: `DRY-RUN: script=${hasScript.stdout.trim() === "YES" ? "EXISTS" : "MISSING"}, cron=${hasCron.stdout.trim() === "YES" ? "INSTALLED" : "MISSING"}, last_hb=${vm.heartbeat_last_at || "NULL"}`,
      };
    }

    // 1. Write the script
    await ssh.execCommand("mkdir -p ~/.openclaw/scripts");
    await ssh.execCommand(`cat > ~/.openclaw/scripts/push-heartbeat.sh << 'HEARTBEATEOF'\n${SCRIPT_CONTENT}\nHEARTBEATEOF`);

    // 2. chmod +x
    await ssh.execCommand("chmod +x ~/.openclaw/scripts/push-heartbeat.sh");

    // 3. Install cron (idempotent)
    const hasCron = await ssh.execCommand(`crontab -l 2>/dev/null | grep -q '${CRON_MARKER}' && echo YES || echo NO`);
    if (hasCron.stdout.trim() !== "YES") {
      await ssh.execCommand(`(crontab -l 2>/dev/null; echo '${CRON_LINE}') | crontab -`);
    }

    // 4. Run immediately
    const run = await ssh.execCommand("bash ~/.openclaw/scripts/push-heartbeat.sh && tail -1 ~/.openclaw/logs/heartbeat.log");
    ssh.dispose();

    const lastLine = run.stdout.trim().split("\n").pop() || "";
    const gotStatus = lastLine.includes("status=200");

    if (!gotStatus) {
      return { success: false, msg: `FAIL - heartbeat response: ${lastLine}` };
    }

    // 5. Verify DB updated
    const { data: updated } = await sb
      .from("instaclaw_vms")
      .select("heartbeat_last_at")
      .eq("id", vm.id)
      .single();

    return {
      success: true,
      msg: `PATCHED - cron=${hasCron.stdout.trim() === "YES" ? "existed" : "installed"}, hb_at=${updated?.heartbeat_last_at ?? "?"}`,
    };
  } catch (e: unknown) {
    ssh.dispose();
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, msg: `SSH ERROR: ${msg.slice(0, 80)}` };
  }
}

async function main() {
  const mode = DRY_RUN ? "DRY RUN" : CANARY ? "CANARY (2 VMs)" : "ALL";
  console.log(`Fleet Push-Heartbeat Patch (${mode})\n`);

  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, assigned_to, heartbeat_last_at")
    .eq("status", "assigned")
    .not("ip_address", "is", null)
    .order("name");

  if (error || !vms) {
    console.error("Failed to fetch VMs:", error);
    process.exit(1);
  }

  console.log(`Found ${vms.length} assigned VMs\n`);

  const targets = CANARY ? vms.slice(0, 2) : vms;

  let patched = 0, failed = 0;
  for (const vm of targets) {
    const result = await patchVM(vm);
    const icon = result.success ? " OK " : "FAIL";
    console.log(`[${icon}] ${vm.name} (${vm.ip_address}) — ${result.msg}`);
    if (result.success) patched++;
    else failed++;
  }

  console.log(`\n--- Summary ---`);
  console.log(`Patched: ${patched} | Failed: ${failed} | Total: ${targets.length}`);
  if (CANARY) console.log(`\nCanary done. If OK, run again with --all`);
}

main().catch(e => { console.error(e); process.exit(1); });
