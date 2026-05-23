/**
 * One-shot: stamp `config_version` and `secret_version` on every existing
 * `status='ready'` pool VM whose snapshot bake matches the current LINODE_
 * SNAPSHOT_ID. Run AFTER updating LINODE_SNAPSHOT_CV in Vercel env.
 *
 * == Why ==
 *
 * Pool VMs created BEFORE the 2026-05-23 replenish-pool fix have `cv=0`
 * in the DB despite their on-disk content being at the baked manifest
 * version. When one of these VMs gets assigned to an Edge attendee, the
 * reconciler "catches up" cv=0 → cv=current, triggering redundant
 * gateway restarts during the user's first ~15 min — exactly when the
 * agent needs to be stable for the user's first message.
 *
 * This script catches the stragglers — the 14 ready pool VMs created
 * earlier today + any older ready VMs that predated the env-var-stamp
 * fix. After this runs, those VMs will have `cv=baked-version`, and the
 * reconciler will short-circuit on assignment (no catch-up work).
 *
 * == What it does ==
 *
 * UPDATE instaclaw_vms
 *   SET config_version = <LINODE_SNAPSHOT_CV>,
 *       secret_version = <LINODE_SNAPSHOT_SECRET_VERSION>
 *   WHERE status = 'ready'
 *     AND provider = 'linode'
 *     AND config_version = 0;
 *
 * Selectivity: status='ready' (pool, not assigned) + cv=0 (not yet
 * stamped). Idempotent — re-running after a stamp is a no-op.
 *
 * == What it does NOT do ==
 *
 * Does NOT update assigned VMs. Assigned VMs may have their own real
 * cv (after a successful reconcile) that we shouldn't blindly overwrite.
 *
 * Does NOT update VMs from a different snapshot (we only know the
 * current snapshot's bake version, not historical ones).
 *
 * == Usage ==
 *
 * Dry-run:
 *   npx tsx scripts/_stamp-pool-cv.ts
 *
 * Apply:
 *   LINODE_SNAPSHOT_CV=113 npx tsx scripts/_stamp-pool-cv.ts --apply
 *
 * (Or set LINODE_SNAPSHOT_CV in .env.local first.)
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const APPLY = process.argv.includes("--apply");
const SNAPSHOT_CV = Number(process.env.LINODE_SNAPSHOT_CV ?? "113");
const SNAPSHOT_SECRET_VER = Number(
  process.env.LINODE_SNAPSHOT_SECRET_VERSION ?? "0",
);

if (!Number.isFinite(SNAPSHOT_CV) || SNAPSHOT_CV <= 0) {
  console.error(
    `FATAL: LINODE_SNAPSHOT_CV must be a positive integer (got: ${process.env.LINODE_SNAPSHOT_CV})`,
  );
  process.exit(1);
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log(
    `\n${APPLY ? "🔥 APPLYING" : "🧐 DRY-RUN"} pool VM cv-stamp`,
  );
  console.log(`  Target cv: ${SNAPSHOT_CV}`);
  console.log(`  Target secret_version: ${SNAPSHOT_SECRET_VER}`);
  console.log("");

  // Find candidates: status='ready' + linode + cv=0 (not already stamped)
  const { data: candidates, error } = await sb
    .from("instaclaw_vms")
    .select("id, name, config_version, secret_version, created_at")
    .eq("status", "ready")
    .eq("provider", "linode")
    .eq("config_version", 0);

  if (error) {
    console.error("candidate query failed:", error.message);
    process.exit(1);
  }
  if (!candidates || candidates.length === 0) {
    console.log("✓ No candidates — pool is already stamped or empty.");
    return;
  }

  console.log(`Found ${candidates.length} ready pool VM(s) at cv=0:`);
  for (const vm of candidates) {
    console.log(
      `  ${vm.name.padEnd(25)} created=${vm.created_at.slice(0, 19)} cv=${vm.config_version} sv=${vm.secret_version}`,
    );
  }
  console.log("");

  if (!APPLY) {
    console.log(
      `DRY-RUN: would UPDATE ${candidates.length} row(s) with cv=${SNAPSHOT_CV}, secret_version=${SNAPSHOT_SECRET_VER}`,
    );
    console.log("Pass --apply to execute.");
    return;
  }

  const { data: updated, error: updateErr } = await sb
    .from("instaclaw_vms")
    .update({
      config_version: SNAPSHOT_CV,
      secret_version: SNAPSHOT_SECRET_VER,
      updated_at: new Date().toISOString(),
    })
    .eq("status", "ready")
    .eq("provider", "linode")
    .eq("config_version", 0)
    .select("id, name, config_version, secret_version");

  if (updateErr) {
    console.error("UPDATE failed:", updateErr.message);
    process.exit(1);
  }
  console.log(`✓ Updated ${updated?.length ?? 0} row(s):`);
  for (const vm of updated ?? []) {
    console.log(`  ${vm.name.padEnd(25)} → cv=${vm.config_version} sv=${vm.secret_version}`);
  }

  // Verify: re-query to confirm no candidates remain
  const { count: remainingCount } = await sb
    .from("instaclaw_vms")
    .select("*", { count: "exact", head: true })
    .eq("status", "ready")
    .eq("provider", "linode")
    .eq("config_version", 0);
  console.log(
    `\nPost-update verify: ${remainingCount} ready VMs still at cv=0 (expected: 0)`,
  );
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
