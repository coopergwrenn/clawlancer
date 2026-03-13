/**
 * Fleet-wide: detect and clear cached billing failure state from auth-profiles.json.
 *
 * When Anthropic returns a billing error (402 / "credit balance too low"), the OpenClaw
 * SDK caches it in auth-profiles.json under usageStats/failureState, disabling the
 * provider until manual intervention. This script detects and clears that state.
 *
 * Usage:
 *   npx tsx scripts/fleet-clear-billing-cache.ts           # dry-run (default)
 *   npx tsx scripts/fleet-clear-billing-cache.ts --dry-run  # explicit dry-run
 *   npx tsx scripts/fleet-clear-billing-cache.ts --fix       # clear caches + restart gateways
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.join(__dirname, "../.env.local") });

import { createClient } from "@supabase/supabase-js";
import { connectSSH } from "../lib/ssh";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DBUS = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';
const AUTH_PROFILES_PATH = "~/.openclaw/agents/main/agent/auth-profiles.json";

const FIX_MODE = process.argv.includes("--fix");
const DRY_RUN = !FIX_MODE; // default is dry-run

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY-RUN (pass --fix to apply)" : "FIX (will clear caches + restart gateways)"}\n`);

  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, telegram_bot_username")
    .not("gateway_token", "is", null)
    .neq("status", "terminated")
    .order("name");

  if (!vms?.length) { console.log("No VMs"); return; }

  console.log(`Checking ${vms.length} VMs for cached billing state...\n`);

  let clean = 0;
  let affected = 0;
  let fixed = 0;
  let sshFail = 0;
  const affectedVMs: string[] = [];
  const fixedVMs: string[] = [];
  const failedVMs: string[] = [];

  for (const vm of vms) {
    const label = vm.name?.replace("instaclaw-", "") ?? vm.id.slice(0, 8);
    try {
      const ssh = await connectSSH(vm, { skipDuplicateIPCheck: true });
      try {
        // Check auth-profiles for failureState or disabledUntil (actual problems).
        // Benign usageStats with errorCount: 0 are NOT flagged.
        const check = await ssh.execCommand(
          `grep -c 'failureState\\|disabledUntil' ${AUTH_PROFILES_PATH} 2>/dev/null || echo 0`
        );
        const hasPoisonedCache = parseInt(check.stdout?.trim() || "0") > 0;

        if (!hasPoisonedCache) {
          clean++;
          continue;
        }

        affected++;
        affectedVMs.push(`${label} (${vm.telegram_bot_username || "no bot"})`);

        if (DRY_RUN) {
          // Show what we'd fix
          const peek = await ssh.execCommand(
            `grep -n 'failureState\\|disabledUntil\\|billing' ${AUTH_PROFILES_PATH} 2>/dev/null | head -5`
          );
          console.log(`  ⚠️  ${label} (${vm.telegram_bot_username || "no bot"}): BILLING CACHE DETECTED`);
          if (peek.stdout?.trim()) {
            console.log(`      ${peek.stdout.trim().split("\n").join("\n      ")}`);
          }
          continue;
        }

        // --- FIX MODE: clear failureState + usageStats and restart ---
        const fix = await ssh.execCommand(`python3 -c "
import json, os
p = os.path.expanduser('${AUTH_PROFILES_PATH.replace("~", "~")}')
with open(p) as f: c = json.load(f)
changed = False
for key in list(c.get('profiles', {})):
    if 'failureState' in c['profiles'][key]:
        del c['profiles'][key]['failureState']
        changed = True
    if 'disabledUntil' in c['profiles'][key]:
        del c['profiles'][key]['disabledUntil']
        changed = True
if 'usageStats' in c:
    del c['usageStats']
    changed = True
if changed:
    with open(p, 'w') as f: json.dump(c, f, indent=2)
    print('FIXED')
else:
    print('CLEAN')
"`);

        if (fix.stdout?.includes("FIXED")) {
          // Clear degraded flag
          await ssh.execCommand(
            "rm -f ~/.openclaw/agents/main/sessions/.session-degraded"
          );
          // Restart gateway
          await ssh.execCommand(`${DBUS} && systemctl --user restart openclaw-gateway`);
          await new Promise(r => setTimeout(r, 3000));
          const s = await ssh.execCommand(`${DBUS} && systemctl --user is-active openclaw-gateway`);
          const active = s.stdout?.trim() === "active";
          console.log(`  ✅ ${label} (${vm.telegram_bot_username || "no bot"}): cleared billing cache → gateway ${active ? "active" : "FAILED ❌"}`);
          if (!active) {
            failedVMs.push(label);
          } else {
            fixed++;
            fixedVMs.push(label);
          }
        } else {
          clean++;
        }
      } finally {
        ssh.dispose();
      }
    } catch {
      sshFail++;
      failedVMs.push(label);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Clean (no cached billing state): ${clean}`);
  if (DRY_RUN) {
    console.log(`Affected (need clearing):        ${affected}${affectedVMs.length ? " — " + affectedVMs.join(", ") : ""}`);
    if (affected > 0) {
      console.log(`\nRun with --fix to clear billing caches and restart gateways.`);
    }
  } else {
    console.log(`Fixed (cleared + restarted):     ${fixed}${fixedVMs.length ? " — " + fixedVMs.join(", ") : ""}`);
  }
  console.log(`SSH failed:                      ${sshFail}${failedVMs.length ? " — " + failedVMs.join(", ") : ""}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
