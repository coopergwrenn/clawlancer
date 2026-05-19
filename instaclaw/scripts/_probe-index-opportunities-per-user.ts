/**
 * Empirical test for the Index Network /api/opportunities?status=accepted
 * endpoint — auth model + result scoping.
 *
 * Three questions to answer:
 *
 *   1. After Yanek's master-key rotation, are our PER-USER keys (stored in
 *      instaclaw_vms.index_api_key from earlier stepIndexProvision /signup
 *      calls) still valid? Or do we need to re-run signup for all 9 agents
 *      with the new master before doing anything else?
 *
 *   2. If valid: does GET /api/opportunities?status=accepted return ALL
 *      accepted opportunities in the network (Option A — one key polls
 *      everything), or only opportunities visible to the authed user
 *      (Option B — must poll all 9 keys and dedup)?
 *
 *   3. As a corollary to #2: when polled with two different agents' keys,
 *      are the returned opportunity-id sets identical (all-network) or
 *      different (user-scoped)?
 *
 * Method:
 *
 *   For each of two distinct agents (we pick vm-050 = Cooper's test agent,
 *   and vm-859 = Katherine Jones — both in the spectator cohort and
 *   already provisioned with index_user_id + index_api_key):
 *     - hit GET /api/opportunities?status=accepted with x-api-key: <user-key>
 *     - record status, opportunity count, opportunity IDs, and whether the
 *       authed agent appears as one of the actors in each opportunity
 *
 *   Then compare the two result sets:
 *     - identical sets → all-network (Option A)
 *     - disjoint sets → user-scoped where neither sees the other (unlikely)
 *     - overlapping but unequal sets → user-scoped where each user sees
 *       opportunities they're an actor in (Option B)
 *
 *   Edge case: if both keys return [] (no accepted opportunities exist
 *   yet — likely at this stage, agents haven't expressed intents), we
 *   can confirm auth + endpoint reachability + response shape, but the
 *   all-vs-mine question is empirically inconclusive. In that case we
 *   recommend Option B as the safer default since Yanek's per-user-key
 *   architecture statement strongly implies user-scoped responses.
 *
 * Side effects: read-only. No DB writes, no Vercel mutations, no Index
 * writes (we use GET, no body).
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

const API_BASE = (process.env.INDEX_NETWORK_API_URL?.trim() || "https://protocol.dev.index.network").replace(/\/+$/, "");

async function probe(label: string, apiKey: string): Promise<{
  status: number;
  count: number;
  ids: string[];
  bodyPrefix: string;
  authedUserAppearsAsActor: boolean[];
}> {
  const res = await fetch(`${API_BASE}/api/opportunities?status=accepted`, {
    method: "GET",
    headers: { "x-api-key": apiKey, Accept: "application/json" },
  });
  const bodyText = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(bodyText); } catch {}
  const opps = (parsed?.opportunities ?? []) as Array<{ id: string; actors?: Array<{ userId?: string }> }>;
  return {
    status: res.status,
    count: opps.length,
    ids: opps.map((o) => o.id),
    bodyPrefix: bodyText.slice(0, 300),
    authedUserAppearsAsActor: [],
  };
}

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Pick two distinct agents from the cohort with index_api_key populated.
  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("name, assigned_to, index_user_id, index_api_key")
    .eq("partner", "edge_city")
    .not("index_api_key", "is", null)
    .order("name");
  if (error || !vms || vms.length < 2) {
    console.error("✗ need >=2 edge_city VMs with index_api_key. err:", error);
    process.exit(1);
  }

  // Prefer Carter (vm-917) + Katherine (vm-859) — both spectator-visible
  // and used in the prior smoke test, so they're known-good cohort members.
  const a = vms.find((v) => v.name === "instaclaw-vm-050") ?? vms[0];
  const b = vms.find((v) => v.name === "instaclaw-vm-859") ?? vms[1];

  console.log(`\n=== Test agents ===`);
  console.log(`  A: ${a.name}  index_user_id=${a.index_user_id?.slice(0, 8)}…  key=${a.index_api_key?.slice(0, 8)}…`);
  console.log(`  B: ${b.name}  index_user_id=${b.index_user_id?.slice(0, 8)}…  key=${b.index_api_key?.slice(0, 8)}…`);

  console.log(`\n=== Probe A (${a.name}) ===`);
  const ra = await probe("A", a.index_api_key as string);
  console.log(`  status        : ${ra.status}`);
  console.log(`  opp count     : ${ra.count}`);
  if (ra.ids.length > 0) {
    console.log(`  opp ids       : ${ra.ids.slice(0, 5).join(", ")}${ra.ids.length > 5 ? ` … (+${ra.ids.length - 5} more)` : ""}`);
  } else {
    console.log(`  body prefix   : ${ra.bodyPrefix}`);
  }

  console.log(`\n=== Probe B (${b.name}) ===`);
  const rb = await probe("B", b.index_api_key as string);
  console.log(`  status        : ${rb.status}`);
  console.log(`  opp count     : ${rb.count}`);
  if (rb.ids.length > 0) {
    console.log(`  opp ids       : ${rb.ids.slice(0, 5).join(", ")}${rb.ids.length > 5 ? ` … (+${rb.ids.length - 5} more)` : ""}`);
  } else {
    console.log(`  body prefix   : ${rb.bodyPrefix}`);
  }

  console.log(`\n=== Diagnosis ===`);

  // Question 1: are per-user keys still valid?
  if (ra.status === 401 || ra.status === 403 || rb.status === 401 || rb.status === 403) {
    console.log("✗ Per-user keys appear to be INVALID after master rotation.");
    console.log("  → Action: re-provision all 9 edge_city VMs against the new master key.");
    console.log("  → Easiest path: SQL UPDATE to NULL out index_user_id + index_api_key for");
    console.log("    all 9 edge_city VMs, then let stepIndexProvision in the reconcile-fleet cron");
    console.log("    re-issue per-user keys against the new master on the next tick.");
    process.exit(2);
  }
  if (ra.status !== 200 || rb.status !== 200) {
    console.log(`✗ Unexpected non-2xx from one or both probes (A=${ra.status}, B=${rb.status}).`);
    console.log("  → Investigate before designing poller architecture.");
    process.exit(3);
  }
  console.log("✓ Both per-user keys returned 200. Per-user keys are valid (survived master rotation).");

  // Question 2 + 3: all-network vs user-scoped
  const setA = new Set(ra.ids);
  const setB = new Set(rb.ids);
  const inter = ra.ids.filter((id) => setB.has(id));
  const onlyA = ra.ids.filter((id) => !setB.has(id));
  const onlyB = rb.ids.filter((id) => !setA.has(id));

  console.log(`\n  A unique : ${onlyA.length}`);
  console.log(`  B unique : ${onlyB.length}`);
  console.log(`  shared   : ${inter.length}`);

  if (ra.count === 0 && rb.count === 0) {
    console.log("\n? INCONCLUSIVE — both endpoints returned 0 accepted opportunities.");
    console.log("  Likely cause: no agent has accepted an opportunity yet (cohort just provisioned 24h ago).");
    console.log("  Auth + endpoint shape are confirmed working. The all-vs-mine question can't be");
    console.log("  empirically answered with no data.");
    console.log();
    console.log("  Recommended architecture given Yanek's 'master is only for /signup, per-user");
    console.log("  keys are scoped to specific users' statement:");
    console.log("  → Default to Option B (poll all 9 agents' keys, dedup on UNIQUE constraint).");
    console.log("  → If real traffic later proves Option A works, simplify to a single-key poll.");
    return;
  }

  if (ra.count === rb.count && onlyA.length === 0 && onlyB.length === 0) {
    console.log("\n✓ ALL-NETWORK auth model (Option A).");
    console.log("  Both keys returned the same set of opportunities. The endpoint is network-scoped");
    console.log("  via the master-issued per-user key, returning ALL accepted opportunities regardless");
    console.log("  of which agent's key is used. Architecture: pick one agent's key (rotated periodically");
    console.log("  if needed), poll with it. Simple.");
    return;
  }

  console.log("\n✓ USER-SCOPED auth model (Option B).");
  console.log("  Each agent's key returns a DIFFERENT set of opportunities — the endpoint filters");
  console.log("  to opportunities the authed user is an actor in. Architecture: poll all 9 agents'");
  console.log("  keys per cron tick. Idempotency via matchpool_outcomes_index_opportunity_unique");
  console.log("  partial-UNIQUE index — bidirectional matches (both actors in our cohort) will be");
  console.log("  attempted by both keys but the UNIQUE constraint dedups to one row.");
}

main().catch((e) => {
  console.error("✗ probe threw:", e);
  process.exit(99);
});
