/**
 * Coverage query — Index Network provisioning across the edge_city cohort.
 *
 * Per CLAUDE.md Rule 27 ("Coverage Dashboards — Build the Query Before
 * Shipping"): every fleet-wide resource needs a single query that answers
 * "what % of the relevant cohort has this?" in <10 seconds. This is that
 * query for the Index integration.
 *
 * Output:
 *   - `n_total`           — edge_city VMs (the cohort that should be provisioned)
 *   - `n_provisioned`     — VMs where index_user_id + index_api_key are populated
 *   - `n_failed_recent`   — VMs where index_provisioned_failed_at > index_provisioned_at
 *                           (or failed_at is set and there's no successful provision yet)
 *   - `n_no_owner`        — edge_city VMs with assigned_to = NULL (can't provision)
 *
 * Healthy fleet state at any time during Edge Esmeralda 2026:
 *   n_provisioned == n_total - n_no_owner    AND    n_failed_recent == 0
 *
 * Re-run after every manifest version bump that touches stepIndexProvision,
 * and as a routine patrol check (CLAUDE.md "Patrol mode").
 *
 * Usage:
 *   npx tsx scripts/_coverage-index-provision.ts             # summary
 *   npx tsx scripts/_coverage-index-provision.ts --verbose   # per-VM detail
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // .env.ssh-key optional here
  }
}

const verbose = process.argv.includes("--verbose");

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select(
      "id, name, ip_address, status, health_status, assigned_to, partner, index_user_id, index_api_key, index_provisioned_at, index_provisioned_failed_at",
    )
    .eq("partner", "edge_city")
    .order("name");

  if (error) {
    console.error("❌ query failed:", error.message);
    process.exit(1);
  }

  const rows = vms ?? [];
  const total = rows.length;
  const provisioned = rows.filter((v) => v.index_user_id && v.index_api_key && v.index_provisioned_at);
  const noOwner = rows.filter((v) => !v.assigned_to);
  const failedRecent = rows.filter((v) => {
    if (!v.index_provisioned_failed_at) return false;
    if (!v.index_provisioned_at) return true;
    return new Date(v.index_provisioned_failed_at) > new Date(v.index_provisioned_at);
  });
  const elig = total - noOwner.length;
  const pct = elig === 0 ? "n/a" : `${Math.round((provisioned.length / elig) * 100)}%`;

  console.log("\n=== Index Network provisioning coverage — edge_city cohort ===");
  console.log(`  edge_city VMs total:        ${total}`);
  console.log(`  ├── provisioned:            ${provisioned.length}  (${pct} of eligible)`);
  console.log(`  ├── no owner (can't prov):  ${noOwner.length}`);
  console.log(`  ├── failed (recent):        ${failedRecent.length}`);
  console.log(`  └── stuck (eligible, ¬prov, ¬failed): ${
    elig - provisioned.length - failedRecent.length
  }\n`);

  if (verbose) {
    console.log("Per-VM detail:");
    for (const v of rows) {
      const ownerStr = v.assigned_to ? v.assigned_to.slice(0, 8) : "(no owner)";
      const keyStr = v.index_api_key ? `ix_${v.index_api_key.slice(3, 8)}…` : "(none)";
      const userStr = v.index_user_id ? v.index_user_id.slice(0, 8) : "(none)";
      const provStr = v.index_provisioned_at ? v.index_provisioned_at.slice(0, 19).replace("T", " ") : "(never)";
      const failStr = v.index_provisioned_failed_at
        ? v.index_provisioned_failed_at.slice(0, 19).replace("T", " ")
        : "—";
      const statusStr =
        v.index_user_id && v.index_api_key
          ? "✓ provisioned"
          : !v.assigned_to
            ? "· no owner"
            : v.index_provisioned_failed_at
              ? "✗ failed"
              : "⌛ pending";
      console.log(
        `  ${v.name?.padEnd(20)} ${statusStr.padEnd(16)} owner=${ownerStr} user=${userStr} key=${keyStr} ok=${provStr} fail=${failStr}`,
      );
    }
    console.log();
  }
}

main().catch((err) => {
  console.error("✗ unexpected error:", err);
  process.exit(99);
});
