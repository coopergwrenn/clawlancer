/**
 * fleet-trigger-agentbook-registration.ts
 *
 * One-time script to send Telegram prompts to eligible VMs about AgentBook registration.
 * NOT a cron job — run manually once after deploying the agentbook skill.
 *
 * Usage:
 *   npx tsx scripts/fleet-trigger-agentbook-registration.ts --dry-run
 *   npx tsx scripts/fleet-trigger-agentbook-registration.ts --send
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

const TELEGRAM_API = "https://api.telegram.org";

const MESSAGE = `🌐 New feature: Your agent can now register in the World AgentBook — an on-chain registry that proves a real human operates this agent.

This gives your agent a verified trust signal that other agents and services can check. Registration is free (no gas fees).

Type "register agentbook" to get started.`;

async function main() {
  const mode = process.argv[2];

  if (!mode || !["--dry-run", "--send"].includes(mode)) {
    console.log("Usage:");
    console.log("  npx tsx scripts/fleet-trigger-agentbook-registration.ts --dry-run");
    console.log("  npx tsx scripts/fleet-trigger-agentbook-registration.ts --send");
    process.exit(1);
  }

  const isDryRun = mode === "--dry-run";

  // Find eligible VMs: active, has Telegram, not yet registered, not yet prompted
  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, name, telegram_bot_token, telegram_chat_id, agentbook_registered, agentbook_prompt_sent")
    .not("telegram_chat_id", "is", null)
    .not("telegram_bot_token", "is", null)
    .eq("agentbook_registered", false)
    .eq("agentbook_prompt_sent", false)
    .neq("status", "terminated");

  if (error) {
    console.error("Failed to query VMs:", error.message);
    process.exit(1);
  }

  if (!vms || vms.length === 0) {
    console.log("No eligible VMs found (all either registered, already prompted, or no Telegram).");
    return;
  }

  console.log(`${isDryRun ? "DRY RUN — " : ""}Found ${vms.length} eligible VMs:\n`);

  let sent = 0;
  let failed = 0;

  for (const vm of vms) {
    console.log(`  ${vm.name ?? vm.id} (chat_id: ${vm.telegram_chat_id})`);

    if (isDryRun) continue;

    try {
      const res = await fetch(
        `${TELEGRAM_API}/bot${vm.telegram_bot_token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: vm.telegram_chat_id,
            text: MESSAGE,
            disable_web_page_preview: true,
          }),
        }
      );

      const result = await res.json();

      if (result.ok) {
        // Mark as prompted
        await supabase
          .from("instaclaw_vms")
          .update({ agentbook_prompt_sent: true })
          .eq("id", vm.id);

        sent++;
        console.log(`    ✓ sent`);
      } else {
        failed++;
        console.log(`    ✗ failed: ${JSON.stringify(result.description ?? result)}`);
      }
    } catch (err) {
      failed++;
      console.log(`    ✗ error: ${err}`);
    }

    // Rate limit: 1 message per 100ms to stay under Telegram limits
    await new Promise((r) => setTimeout(r, 100));
  }

  if (isDryRun) {
    console.log(`\nDRY RUN complete. ${vms.length} VMs would be messaged.`);
    console.log("Run with --send to actually send messages.");
  } else {
    console.log(`\nDone. Sent: ${sent}, Failed: ${failed}`);
  }
}

main().catch(console.error);
