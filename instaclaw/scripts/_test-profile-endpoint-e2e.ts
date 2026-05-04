/**
 * End-to-end test for POST /api/match/v1/profile.
 *
 * Steps:
 *   1. Confirm matchpool_profiles is empty for vm-780's user (clean state)
 *   2. Construct a hand-built ProfileRequestBody (skip the LLM extractor — we
 *      already validated that pipeline; here we test JUST the endpoint)
 *   3. POST against PROD endpoint with vm-780's gateway_token
 *   4. Verify the response shape
 *   5. Verify matchpool_profiles row in DB:
 *        - user_id matches
 *        - offering_embedding + seeking_embedding non-null, 1024 dims
 *        - profile_version = 1 (new)
 *        - consent_tier = 'hidden' (default)
 *        - agent_id is non-empty SHA-256 hex (64 chars)
 *   6. POST again with SAME body — verify profile_version stays at 1 (no bump)
 *   7. POST again with CHANGED offering_summary — verify profile_version → 2
 *   8. Cleanup: delete the test row
 */
import { readFileSync } from "fs";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local","/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key"]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ENDPOINT = process.env.PROFILE_ENDPOINT_OVERRIDE || "https://instaclaw.io/api/match/v1/profile";

const BODY_BASE = {
  offering_summary: "I'm building InstaClaw, a per-user AI agent platform with crypto wallets. Active partnerships with Bankr and Edge City. Daily Claude power user.",
  seeking_summary: "Looking for early-stage investors in agentic AI infrastructure and AI-research collaborators on long-context agent memory.",
  interests: ["agentic-ai", "crypto-infrastructure", "agent-wallets", "long-context-memory"],
  looking_for: ["ai-investor", "research-collaborator"],
  format_preferences: ["1on1", "small_group"],
  confidence: 0.85,
  metadata: {
    extracted_at: new Date().toISOString(),
    extractor_version: "v1-test",
    memory_chars: 4321,
    is_cold_start: false,
  },
};

async function getVmAndToken() {
  const { data: vm, error } = await sb
    .from("instaclaw_vms")
    .select("id, name, gateway_token, assigned_to")
    .eq("name", "instaclaw-vm-780")
    .single();
  if (error || !vm) throw new Error(`vm-780 lookup: ${error?.message}`);
  if (!vm.gateway_token) throw new Error("vm-780 has no gateway_token");
  if (!vm.assigned_to) throw new Error("vm-780 has no assigned_to");
  return { vmId: vm.id as string, token: vm.gateway_token as string, userId: vm.assigned_to as string };
}

async function postProfile(token: string, body: unknown) {
  const start = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - start;
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { /* leave null */ }
  return { status: res.status, body: parsed, elapsed_ms: elapsed };
}

async function readMatchpool(userId: string) {
  const { data } = await sb
    .from("matchpool_profiles")
    .select("user_id, agent_id, offering_summary, seeking_summary, profile_version, consent_tier, embedding_model, intent_extraction_confidence, partner")
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

// pgvector returns embeddings as strings like "[0.1,0.2,...]". Verify shape.
async function readEmbeddingShapes(userId: string) {
  const { data } = await sb.rpc("matchpool_embedding_shape" as never, { _user_id: userId } as never)
    .single() as { data: unknown };
  // RPC may not exist; fall back to a raw SQL query approach via a service-role select
  if (data) return data;
  // Workaround: select offering_embedding via casting
  const { data: row } = await sb
    .from("matchpool_profiles")
    .select("offering_embedding, seeking_embedding")
    .eq("user_id", userId)
    .maybeSingle();
  if (!row) return null;
  // pgvector via supabase-js returns the raw string
  const offeringStr = row.offering_embedding as unknown as string | null;
  const seekingStr = row.seeking_embedding as unknown as string | null;
  return {
    offering_dims: offeringStr ? (offeringStr.match(/,/g) || []).length + 1 : 0,
    seeking_dims: seekingStr ? (seekingStr.match(/,/g) || []).length + 1 : 0,
  };
}

async function main() {
  let pass = 0, fail = 0;
  const ok = (m: string) => { console.log(`  ✓ ${m}`); pass++; };
  const bad = (m: string) => { console.log(`  ✗ ${m}`); fail++; };

  console.log(`Endpoint: ${ENDPOINT}\n`);
  const { token, userId, vmId } = await getVmAndToken();
  console.log(`vm-780 user_id: ${userId}, vm_id: ${vmId}`);

  // Cleanup any prior test row
  await sb.from("matchpool_profiles").delete().eq("user_id", userId);

  // ─ 1. First POST (creates new profile) ─
  console.log("\n── 1. First POST — create new profile ──");
  const r1 = await postProfile(token, BODY_BASE);
  console.log(`  HTTP ${r1.status} in ${r1.elapsed_ms}ms`);
  console.log(`  body: ${JSON.stringify(r1.body)}`);
  if (r1.status === 200) ok("HTTP 200");
  else { bad(`HTTP ${r1.status} (expected 200)`); console.log(JSON.stringify(r1.body, null, 2)); return; }

  const resp1 = r1.body as Record<string, unknown>;
  if (resp1.ok === true) ok("ok=true");
  else bad(`ok != true (got ${resp1.ok})`);
  if (resp1.profile_version === 1) ok("profile_version=1 (new profile)");
  else bad(`profile_version != 1 (got ${resp1.profile_version})`);
  if (resp1.consent_tier === "hidden") ok("consent_tier='hidden' (default)");
  else bad(`consent_tier != 'hidden' (got ${resp1.consent_tier})`);
  if (typeof resp1.agent_id === "string" && (resp1.agent_id as string).length === 64) ok("agent_id is 64-char SHA-256 hex");
  else bad(`agent_id malformed: ${resp1.agent_id}`);
  if (resp1.text_changed === true) ok("text_changed=true (new profile)");
  else bad(`text_changed != true (got ${resp1.text_changed})`);
  if (resp1.is_new_profile === true) ok("is_new_profile=true");
  else bad(`is_new_profile != true`);

  // ─ 2. Verify DB row ─
  console.log("\n── 2. Verify matchpool_profiles row ──");
  const row1 = await readMatchpool(userId);
  if (row1) ok("row exists");
  else { bad("row missing!"); return; }
  if (row1.user_id === userId) ok("user_id matches");
  else bad("user_id mismatch");
  if (row1.offering_summary === BODY_BASE.offering_summary) ok("offering_summary persisted");
  else bad("offering_summary differs");
  if (row1.seeking_summary === BODY_BASE.seeking_summary) ok("seeking_summary persisted");
  else bad("seeking_summary differs");
  if (row1.profile_version === 1) ok("profile_version=1 in DB");
  else bad(`profile_version=${row1.profile_version} in DB (expected 1)`);
  if (row1.consent_tier === "hidden") ok("consent_tier='hidden' in DB");
  else bad(`consent_tier=${row1.consent_tier} in DB`);
  if (row1.intent_extraction_confidence === BODY_BASE.confidence) ok(`confidence=${row1.intent_extraction_confidence} persisted`);
  else bad(`confidence mismatch: ${row1.intent_extraction_confidence} vs ${BODY_BASE.confidence}`);
  if (row1.embedding_model && (row1.embedding_model as string).includes("@1024")) ok(`embedding_model=${row1.embedding_model}`);
  else bad(`embedding_model malformed: ${row1.embedding_model}`);

  // Embedding shapes
  console.log("\n── 3. Verify embeddings (1024-dim vectors) ──");
  const shapes = await readEmbeddingShapes(userId) as { offering_dims: number; seeking_dims: number } | null;
  if (shapes && shapes.offering_dims === 1024) ok("offering_embedding has 1024 dims");
  else bad(`offering_embedding dims = ${shapes?.offering_dims}`);
  if (shapes && shapes.seeking_dims === 1024) ok("seeking_embedding has 1024 dims");
  else bad(`seeking_embedding dims = ${shapes?.seeking_dims}`);

  // ─ 4. Idempotent re-POST (same content) ─
  console.log("\n── 4. Re-POST same body — profile_version should stay at 1 ──");
  const r2 = await postProfile(token, BODY_BASE);
  console.log(`  HTTP ${r2.status} in ${r2.elapsed_ms}ms`);
  const resp2 = r2.body as Record<string, unknown>;
  if (r2.status === 200 && resp2.ok === true) ok("HTTP 200 ok");
  else bad("re-post failed");
  if (resp2.profile_version === 1) ok("profile_version stayed at 1 (idempotent)");
  else bad(`profile_version bumped to ${resp2.profile_version} (should stay at 1)`);
  if (resp2.text_changed === false) ok("text_changed=false (no embedding work done)");
  else bad("text_changed=true (should have skipped embedding)");
  if (r2.elapsed_ms < r1.elapsed_ms) ok(`faster than first call (${r2.elapsed_ms}ms vs ${r1.elapsed_ms}ms — confirms no embedding)`);
  else bad(`not noticeably faster (${r2.elapsed_ms}ms vs ${r1.elapsed_ms}ms)`);

  // ─ 5. POST with changed offering — version should bump ─
  console.log("\n── 5. POST with changed offering — profile_version should bump to 2 ──");
  const bodyChanged = {
    ...BODY_BASE,
    offering_summary: BODY_BASE.offering_summary + " Updated: just shipped intent matching.",
  };
  const r3 = await postProfile(token, bodyChanged);
  console.log(`  HTTP ${r3.status} in ${r3.elapsed_ms}ms`);
  const resp3 = r3.body as Record<string, unknown>;
  if (r3.status === 200) ok("HTTP 200");
  if (resp3.profile_version === 2) ok("profile_version bumped to 2");
  else bad(`profile_version=${resp3.profile_version} (expected 2)`);
  if (resp3.text_changed === true) ok("text_changed=true");
  else bad("text_changed != true");

  const row3 = await readMatchpool(userId);
  if (row3?.offering_summary?.includes("Updated")) ok("DB row reflects updated offering_summary");
  else bad("DB row not updated");
  if (row3?.profile_version === 2) ok("DB row profile_version=2");
  else bad(`DB profile_version=${row3?.profile_version}`);

  // ─ 6. Bad auth ─
  console.log("\n── 6. Bad auth — should 401 ──");
  const rBad = await postProfile("bad-token", BODY_BASE);
  if (rBad.status === 401) ok("invalid token → 401");
  else bad(`bad token returned ${rBad.status}`);

  // ─ 7. Bad body ─
  console.log("\n── 7. Bad body — should 400 ──");
  const rBad2 = await postProfile(token, { offering_summary: "" });
  if (rBad2.status === 400) ok("empty body → 400");
  else bad(`empty body returned ${rBad2.status}`);

  // ─ Cleanup ─
  console.log("\n── 8. Cleanup ──");
  const { error: delErr } = await sb.from("matchpool_profiles").delete().eq("user_id", userId);
  if (!delErr) ok("test row deleted");
  else bad(`cleanup failed: ${delErr.message}`);

  console.log(`\n══ ${pass} passed, ${fail} failed ══\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  console.error(e instanceof Error ? e.stack : "");
  process.exit(1);
});
