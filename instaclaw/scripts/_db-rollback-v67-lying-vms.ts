/**
 * One-shot rollback: VMs whose config_version=67 in DB but SOUL.md still has
 * the v66 routing-table row. Reconciler doesn't redeploy SOUL.md for content
 * edits (manifest entries are append/insert, not overwrite), so the v67 bump
 * was a lie. Rolls them to 66 so the fleet patch script can do the actual
 * SOUL.md/CAPABILITIES.md edit, then re-bump to 67.
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.join(__dirname, "../.env.local") });
import { createClient } from "@supabase/supabase-js";

(async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("id, name, config_version, status")
    .eq("config_version", 67)
    .eq("status", "assigned")
    .eq("provider", "linode");
  if (error) { console.error(error); process.exit(1); }
  console.log(`Found ${vms?.length ?? 0} VMs at config_version=67`);
  for (const v of vms ?? []) console.log(`  ${v.name} (${v.id})`);

  const { error: updateErr } = await sb
    .from("instaclaw_vms")
    .update({ config_version: 66 })
    .eq("config_version", 67)
    .eq("status", "assigned")
    .eq("provider", "linode");
  if (updateErr) { console.error(updateErr); process.exit(1); }
  const { count } = await sb
    .from("instaclaw_vms")
    .select("id", { count: "exact", head: true })
    .eq("config_version", 67);
  console.log(`\nRolled back. Remaining VMs at config_version=67: ${count ?? 0}`);
})();
