/**
 * One-time cleanup: clear telegram tokens from terminated/destroyed/failed VMs.
 * These dangling tokens block the unique constraint and prevent re-assignment.
 *
 * Usage:
 *   npx tsx scripts/_cleanup-terminated-tokens.ts          # dry-run (default)
 *   npx tsx scripts/_cleanup-terminated-tokens.ts --fix     # actually clear tokens
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

for (const f of [".env.ssh-key", ".env.local"]) {
  try {
    const c = readFileSync(resolve(".", f), "utf-8");
    for (const l of c.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m) {
        const k = m[1].trim();
        const v = m[2].trim().replace(/^["']|["']$/g, "");
        if (!process.env[k]) process.env[k] = v;
      }
    }
  } catch {}
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const dryRun = !process.argv.includes("--fix");

async function main() {
  console.log(`Mode: ${dryRun ? "DRY-RUN (pass --fix to apply)" : "LIVE — will clear tokens"}\n`);

  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("id, name, status, telegram_bot_token, telegram_bot_username, telegram_chat_id, last_assigned_to")
    .in("status", ["terminated", "destroyed", "failed"])
    .or("telegram_bot_token.not.is.null,telegram_bot_username.not.is.null");

  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }

  if (!vms?.length) {
    console.log("No terminated VMs holding telegram tokens. Nothing to do.");
    return;
  }

  console.log(`Found ${vms.length} terminated/destroyed/failed VM(s) with telegram data:\n`);

  for (const vm of vms) {
    const tokenPreview = vm.telegram_bot_token
      ? `${vm.telegram_bot_token.slice(0, 10)}...`
      : "(null)";
    console.log(
      `  ${vm.name ?? vm.id} [${vm.status}] — token: ${tokenPreview}, username: ${vm.telegram_bot_username ?? "(null)"}, chat_id: ${vm.telegram_chat_id ?? "(null)"}, last_user: ${vm.last_assigned_to ?? "(null)"}`
    );

    if (!dryRun) {
      const { error: updateErr } = await sb
        .from("instaclaw_vms")
        .update({
          telegram_bot_token: null,
          telegram_bot_username: null,
          telegram_chat_id: null,
        })
        .eq("id", vm.id);

      if (updateErr) {
        console.error(`  ❌ Failed to clear ${vm.name ?? vm.id}: ${updateErr.message}`);
      } else {
        console.log(`  ✅ Cleared`);
      }
    }
  }

  if (dryRun) {
    console.log(`\nDry-run complete. Run with --fix to clear these tokens.`);
  } else {
    console.log(`\nDone. Cleared telegram data from ${vms.length} VM(s).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
