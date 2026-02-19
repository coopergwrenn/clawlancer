import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  // Find VMs with telegram_bot_token but null channels_enabled
  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, telegram_bot_token, discord_bot_token, channels_enabled, status")
    .is("channels_enabled", null)
    .not("telegram_bot_token", "is", null);

  if (error) {
    console.error("Query error:", error);
    return;
  }

  console.log(`Found ${vms.length} VMs with telegram_bot_token but null channels_enabled:\n`);

  let updated = 0;
  for (const vm of vms) {
    const channels: string[] = ["telegram"];
    if (vm.discord_bot_token) {
      channels.push("discord");
    }

    console.log(`  ${vm.id} | status=${vm.status} | setting channels_enabled=${JSON.stringify(channels)}`);

    const { error: updateErr } = await supabase
      .from("instaclaw_vms")
      .update({ channels_enabled: channels })
      .eq("id", vm.id);

    if (updateErr) {
      console.error(`    ERROR updating ${vm.id}:`, updateErr.message);
    } else {
      updated++;
    }
  }

  console.log(`\nDone. Updated ${updated}/${vms.length} VMs.`);
}

main();
