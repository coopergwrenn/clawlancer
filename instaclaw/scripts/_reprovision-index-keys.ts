/**
 * Re-provision all 9 edge_city VMs' Index Network keys against the new
 * (rotated) master key.
 *
 * Why this script exists: Yanek rotated INDEX_NETWORK_MASTER_KEY on his
 * side, which invalidated every per-user `ix_…` key stored in
 * instaclaw_vms.index_api_key (issued by the previous master). Empirical
 * confirmation came from scripts/_probe-index-opportunities-per-user.ts
 * — both stored keys returned 401 against the new endpoint.
 *
 * What it does:
 *
 *   1. SNAPSHOT the current (index_user_id, index_api_key, index_provisioned_at)
 *      to stdout so we have an audit trail in case of rollback.
 *
 *   2. NULL the three Index columns on all 9 edge_city VMs in one SQL
 *      UPDATE. After this, stepIndexProvision's `hasLocalCreds` check
 *      returns false → next reconcile will call /signup with the new
 *      master and get a fresh per-user key.
 *
 *   3. Trigger `/api/admin/reconcile-vm` for each of the 9 VMs in
 *      PARALLEL via Promise.all. Each call drives reconcileVM end-to-end,
 *      but because every step except stepIndexProvision is at cv-current
 *      state, only stepIndexProvision does real work — the rest fast-path
 *      to `alreadyCorrect`. Per-VM wall-clock: ~30-90s.
 *
 *   4. Re-query the rows. Verify all 9 now have non-null
 *      (index_user_id, index_api_key) AND the keys DIFFER from the
 *      snapshot. If any VM has null keys after, the reconcile failed for
 *      that VM — report and exit non-zero so the operator notices.
 *
 *   5. Print the final state.
 *
 * Side effects: SQL writes, Vercel function invocations (which themselves
 * SSH to the 9 VMs and rewrite their openclaw.json mcp.servers.index block).
 * Read-only on Index Network (the signups are idempotent — same email
 * always returns the same user.id; only the apiKey gets rotated, which
 * is the intent here).
 *
 * Rollback: if anything goes wrong, the SNAPSHOT printed at the start is
 * the source of truth for the prior (now-dead) keys. They can't be
 * restored (Yanek's master rotation invalidated them) but the snapshot
 * tells operators which VMs were touched.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const l of readFileSync(
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "utf-8",
).split("\n")) {
  const m = l.match(/^([^#=]+)=(.*)$/);
  if (m && !process.env[m[1].trim()]) {
    process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const PROD_BASE = "https://instaclaw.io";

async function reconcileOneVm(
  vm: { id: string; name: string },
  adminKey: string,
): Promise<{ vmId: string; vmName: string; ok: boolean; status: number; durationMs: number; bodyPrefix?: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${PROD_BASE}/api/admin/reconcile-vm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Key": adminKey,
      },
      body: JSON.stringify({ vmId: vm.id, strict: false, dryRun: false }),
    });
    const text = await res.text();
    return {
      vmId: vm.id,
      vmName: vm.name,
      ok: res.ok,
      status: res.status,
      durationMs: Date.now() - t0,
      bodyPrefix: text.slice(0, 200),
    };
  } catch (err: any) {
    return {
      vmId: vm.id,
      vmName: vm.name,
      ok: false,
      status: 0,
      durationMs: Date.now() - t0,
      bodyPrefix: String(err?.message ?? err).slice(0, 200),
    };
  }
}

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    console.error("✗ ADMIN_API_KEY not in env. Run `npx vercel env pull` first.");
    process.exit(1);
  }

  // ── 1. Snapshot the current state ──
  console.log("=== T+0  Snapshot current state (for forensics / rollback) ===");
  const { data: snapshot, error: snapErr } = await sb
    .from("instaclaw_vms")
    .select("id, name, index_user_id, index_api_key, index_provisioned_at")
    .eq("partner", "edge_city")
    .order("name");
  if (snapErr || !snapshot) {
    console.error("✗ snapshot query failed:", snapErr);
    process.exit(2);
  }
  console.log(`  ${snapshot.length} edge_city VMs found:\n`);
  for (const v of snapshot) {
    const u = v.index_user_id ? v.index_user_id.slice(0, 8) : "(null)";
    const k = v.index_api_key ? v.index_api_key.slice(0, 8) + "…" : "(null)";
    const t = v.index_provisioned_at ?? "(null)";
    console.log(`    ${v.name}  user=${u}  key=${k}  prov=${t}`);
  }
  if (snapshot.length !== 9) {
    console.warn(`\n  ⚠ expected 9 edge_city VMs, got ${snapshot.length}`);
  }
  console.log();

  // ── 2. NULL the columns ──
  console.log("=== T+0  NULL the index columns on all 9 edge_city VMs ===");
  const ids = snapshot.map((v) => v.id);
  const { error: updateErr, count } = await sb
    .from("instaclaw_vms")
    .update({
      index_user_id: null,
      index_api_key: null,
      index_provisioned_at: null,
      index_provisioned_failed_at: null,
    })
    .in("id", ids)
    .select("id", { count: "exact" });
  if (updateErr) {
    console.error("✗ UPDATE failed:", updateErr);
    process.exit(3);
  }
  console.log(`  ✓ NULL'd ${count ?? "?"} rows\n`);

  // ── 3. Trigger admin/reconcile-vm in parallel ──
  console.log(`=== T+~10s  Trigger /api/admin/reconcile-vm × ${snapshot.length} in parallel ===`);
  console.log("  (each invocation calls reconcileVM → stepIndexProvision sees null creds → signup against new master → DB + disk writes)");
  console.log();
  const tStart = Date.now();
  const results = await Promise.all(
    snapshot.map((vm) => reconcileOneVm({ id: vm.id, name: vm.name }, adminKey)),
  );
  const tEnd = Date.now();
  console.log(`  All ${results.length} reconciles complete in ${Math.round((tEnd - tStart) / 1000)}s\n`);
  for (const r of results) {
    console.log(`    ${r.ok ? "✓" : "✗"} ${r.vmName.padEnd(20)} HTTP ${r.status}  (${Math.round(r.durationMs / 1000)}s)`);
  }
  const reconcileFailures = results.filter((r) => !r.ok);
  if (reconcileFailures.length > 0) {
    console.warn(`\n  ⚠ ${reconcileFailures.length} reconciles returned non-2xx — investigate before relying on those VMs`);
    for (const r of reconcileFailures) {
      console.warn(`    ${r.vmName}: ${r.bodyPrefix}`);
    }
  }
  console.log();

  // ── 4. Verify all 9 have fresh keys ──
  console.log("=== T+done  Verify all 9 VMs have fresh (non-null) keys ===");
  const { data: final, error: finalErr } = await sb
    .from("instaclaw_vms")
    .select("id, name, index_user_id, index_api_key, index_provisioned_at, index_provisioned_failed_at")
    .eq("partner", "edge_city")
    .order("name");
  if (finalErr || !final) {
    console.error("✗ final query failed:", finalErr);
    process.exit(4);
  }

  let withKey = 0;
  let stillNull = 0;
  let failedProvisioning = 0;
  for (const v of final) {
    const original = snapshot.find((s) => s.id === v.id);
    const newKey = v.index_api_key as string | null;
    const oldKey = original?.index_api_key as string | null;
    const changed = newKey && oldKey && newKey !== oldKey;
    const u = v.index_user_id ? v.index_user_id.slice(0, 8) : "(null)";
    const k = newKey ? newKey.slice(0, 8) + "…" : "(null)";
    const t = v.index_provisioned_at ?? "(never)";
    const failedAt = v.index_provisioned_failed_at;

    let mark = " ";
    if (newKey && changed) {
      mark = "✓";
      withKey++;
    } else if (!newKey) {
      mark = "✗";
      stillNull++;
      if (failedAt) failedProvisioning++;
    } else {
      mark = "?";
    }
    console.log(`    ${mark} ${v.name.padEnd(20)} user=${u}  key=${k}  prov=${t}  fail=${failedAt ?? "(none)"}`);
  }

  console.log();
  console.log(`  Summary: ${withKey} re-provisioned with FRESH keys, ${stillNull} still NULL (${failedProvisioning} had provisioning failure)`);

  if (stillNull > 0) {
    console.error(`\n✗ ${stillNull} VM(s) did not get a fresh key. Investigate via the Vercel function logs for /api/admin/reconcile-vm.`);
    process.exit(5);
  }
  if (withKey !== snapshot.length) {
    console.error(`\n✗ Only ${withKey} of ${snapshot.length} VMs got new keys.`);
    process.exit(6);
  }

  console.log("\n✓ All 9 edge_city VMs re-provisioned with fresh per-user keys.");
}

main().catch((e) => {
  console.error("✗ script threw:", e);
  process.exit(99);
});
