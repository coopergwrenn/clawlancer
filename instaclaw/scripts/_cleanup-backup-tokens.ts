/**
 * Fleet-wide scan for stale Telegram bot tokens in OpenClaw backup config files.
 *
 * Usage:
 *   npx tsx scripts/_cleanup-backup-tokens.ts           # dry-run (default)
 *   npx tsx scripts/_cleanup-backup-tokens.ts --fix      # delete backup files
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.join(__dirname, "../.env.local") });
dotenv.config({ path: path.join(__dirname, "../.env.ssh-key") });

import { createClient } from "@supabase/supabase-js";
import { connectSSH } from "../lib/ssh";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const FIX_MODE = process.argv.includes("--fix");

async function main() {
  console.log(`Mode: ${FIX_MODE ? "FIX (will delete backup files)" : "DRY-RUN (read-only scan)"}`);
  console.log();

  const { data: vms } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, status")
    .in("status", ["ready", "assigned"])
    .not("ip_address", "is", null)
    .order("name");

  console.log(`Found ${vms?.length ?? 0} VMs to scan (ready + assigned)`);
  console.log();

  let scanned = 0;
  let stale = 0;
  let cleaned = 0;
  let sshFailed = 0;

  for (const vm of vms ?? []) {
    try {
      const ssh = await connectSSH(vm);
      try {
        // Check for botToken in any openclaw.json backup files
        const grepResult = await ssh.execCommand(
          `grep -l "botToken" ~/.openclaw/openclaw.json.bak* /tmp/openclaw-backup.json 2>/dev/null || true`,
        );
        const filesWithToken = (grepResult.stdout ?? "").trim();

        if (filesWithToken) {
          stale++;
          const files = filesWithToken.split("\n");
          console.log(`  ${vm.name} (${vm.status}): STALE TOKEN in ${files.length} file(s)`);
          for (const f of files) {
            console.log(`    - ${f}`);
          }

          if (FIX_MODE) {
            await ssh.execCommand(
              `rm -f ~/.openclaw/openclaw.json.bak* /tmp/openclaw-backup.json 2>/dev/null || true`,
            );
            cleaned++;
            console.log(`    -> CLEANED`);
          }
        }

        scanned++;
      } finally {
        ssh.dispose();
      }
    } catch (err) {
      sshFailed++;
      console.log(`  ${vm.name}: SSH FAILED (${String(err).slice(0, 80)})`);
    }
  }

  console.log();
  console.log("=== SUMMARY ===");
  console.log(`Scanned:    ${scanned}`);
  console.log(`SSH failed: ${sshFailed}`);
  console.log(`Stale:      ${stale}`);
  if (FIX_MODE) {
    console.log(`Cleaned:    ${cleaned}`);
  } else if (stale > 0) {
    console.log();
    console.log(`Run with --fix to delete backup files on ${stale} VM(s).`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
