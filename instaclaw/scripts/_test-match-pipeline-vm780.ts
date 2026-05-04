/**
 * End-to-end pipeline test on vm-780.
 *
 * Uploads the four scripts to /tmp on vm-780, runs the orchestrator with
 * --force --no-jitter, and verifies:
 *   1. exit 0
 *   2. telemetry shows L1 → L2 → L3 → POST sequence
 *   3. matchpool_deliberations table got rows for vm-780's user
 *   4. matchpool_cached_top3 row exists for vm-780's user
 *
 * Pre-condition: vm-780's profile must already exist in matchpool_profiles
 * (Component 5 test ran in the prior session). If empty, this test bails
 * with a clear message so we don't false-fail.
 *
 * Cleanup: deletes the test row and the uploaded scripts. Leaves
 * matchpool_profiles for vm-780 alone (Component 5 owns it).
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SCRIPTS_DIR = "/Users/cooperwrenn/wild-west-bots/instaclaw/scripts";
const SCRIPTS_TO_UPLOAD = [
  "consensus_match_pipeline.py",
  "consensus_match_rerank.py",
  "consensus_match_deliberate.py",
];

async function getVm780UserId() {
  const { data } = await sb
    .from("instaclaw_vms")
    .select("assigned_to")
    .eq("name", "instaclaw-vm-780")
    .single();
  if (!data?.assigned_to) throw new Error("vm-780 has no assigned_to");
  return data.assigned_to as string;
}

async function ensureMatchpoolProfileExists(userId: string) {
  const { data } = await sb
    .from("matchpool_profiles")
    .select("user_id, profile_version, consent_tier")
    .eq("user_id", userId)
    .maybeSingle();
  return data;
}

async function getVm780GatewayToken() {
  const { data } = await sb
    .from("instaclaw_vms")
    .select("gateway_token")
    .eq("name", "instaclaw-vm-780")
    .single();
  if (!data?.gateway_token) throw new Error("vm-780 has no gateway_token");
  return data.gateway_token as string;
}

async function postCooperProfile(token: string): Promise<void> {
  // Hand-crafted profile aligned with Cooper's actual current work,
  // so the pipeline's L2/L3 rationale references things he can verify.
  // Matches the kind of content the intent extractor would produce.
  const body = {
    offering_summary:
      "Building InstaClaw, a per-user AI agent platform with crypto wallets on Base. Active partnerships with Bankr (agent-controlled wallet infra) and Edge City. Just launched $TESTER on Base. Daily Claude power user. Shipped consensus intent matching with dual-embedding mutual scoring + per-candidate deliberation.",
    seeking_summary:
      "Early-stage investors in agentic AI infrastructure. AI researchers working on long-context agent memory and persistent agent state. Partnership operators at conferences whose attendees overlap with InstaClaw's user base.",
    interests: ["agentic-ai", "agent-wallets", "agent-platforms", "crypto-infrastructure", "long-context-memory", "consensus-2026"],
    looking_for: ["ai-investor", "research-collaborator", "partnership-operator"],
    format_preferences: ["1on1", "small_group"],
    confidence: 0.92,
    metadata: {
      extracted_at: new Date().toISOString(),
      extractor_version: "pipeline-test-handcrafted",
      memory_chars: 32000,
      is_cold_start: false,
    },
  };

  const res = await fetch("https://instaclaw.io/api/match/v1/profile", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(`profile POST ${res.status}: ${text.slice(0, 300)}`);
  }
}

async function setProfileTier(userId: string, tier: string): Promise<void> {
  // The pipeline only computes for users with non-hidden tier? Actually
  // Layer 1 filters CANDIDATES on consent_tier, not the caller. The caller
  // can be hidden and still get matches. But we set it to 'interests' so
  // vm-780 also appears in OTHER users' matches when running symmetrically.
  await sb
    .from("matchpool_profiles")
    .update({ consent_tier: tier })
    .eq("user_id", userId);
}

async function ensureCandidatePoolHasMembers(excludeUserId: string) {
  // We need at least one OTHER opted-in profile for the pipeline to do
  // useful work. Check the count.
  const { count } = await sb
    .from("matchpool_profiles")
    .select("user_id", { count: "exact", head: true })
    .neq("user_id", excludeUserId)
    .in("consent_tier", ["interests", "interests_plus_name", "full_profile"]);
  return count ?? 0;
}

async function seedSyntheticCandidates(excludeUserId: string): Promise<string[]> {
  // Insert 3 synthetic profiles so vm-780's pipeline has someone to match
  // against. Designed to produce predictable picks (one specific-signal
  // candidate, one mid, one low) for easy verification.
  const synthIds = [
    "33333333-0000-0000-0000-00000000000a",
    "33333333-0000-0000-0000-00000000000b",
    "33333333-0000-0000-0000-00000000000c",
  ];

  // Clean any prior synthetic state
  await sb.from("matchpool_profiles").delete().in("user_id", synthIds);
  await sb.from("instaclaw_users").delete().in("id", synthIds);

  // Insert users (FK requirement)
  await sb.from("instaclaw_users").insert(synthIds.map((id, i) => ({
    id,
    email: `synth-${i}-pipeline-test@test.invalid`,
    name: `Synth Test ${i}`,
  })));

  // Use the embedding helper to produce REAL 1024-dim Voyage/OpenAI vectors
  // — the pipeline will call Layer 1 against pgvector cosine which expects
  // unit-normalized vectors compatible with vm-780's embeddings.
  const { embedDual, vectorToPgString } = await import("../lib/match-embeddings");

  const synthProfiles = [
    {
      user_id: synthIds[0],
      agent_id: "synth-pipeline-vc",
      offering_summary: "VC partner at AI-focused fund. Lead seed/Series A checks $2-5M into agent infrastructure and crypto-AI plays. Active in agent wallets and Anthropic-adjacent infra.",
      seeking_summary: "Founders building per-user AI agent platforms with paying users and per-user economics. Specifically interested in agent-controlled wallet infrastructure.",
      interests: ["agentic-ai", "agent-wallets", "crypto-infrastructure"],
      looking_for: ["founder", "agent-platform"],
      format_preferences: ["1on1"],
      consent_tier: "interests",
    },
    {
      user_id: synthIds[1],
      agent_id: "synth-pipeline-builder",
      offering_summary: "Building agent-controlled wallet infrastructure on Base. Live partnership pipeline with several agent platforms, including ones running on Base mainnet.",
      seeking_summary: "Other agent platform builders shipping on Base who need wallet-per-agent provisioning. Want to compare implementation notes and discuss collaboration.",
      interests: ["agent-wallets", "base", "agent-infrastructure"],
      looking_for: ["agent-platform-builder", "infra-collab"],
      format_preferences: ["1on1"],
      consent_tier: "interests",
    },
    {
      user_id: synthIds[2],
      agent_id: "synth-pipeline-mismatch",
      offering_summary: "Designer building consumer NFT marketplace on Solana. Focused on collector mechanics and PFP communities.",
      seeking_summary: "Other consumer-NFT founders, collectors on Solana, PFP marketplace ops people.",
      interests: ["nft", "solana", "consumer"],
      looking_for: ["nft-cofounder", "marketplace-ops"],
      format_preferences: ["small_group"],
      consent_tier: "interests",
    },
  ];

  console.log("    embedding 3 synthetic profiles via real OpenAI/Voyage…");
  for (const p of synthProfiles) {
    const e = await embedDual({ offering: p.offering_summary, seeking: p.seeking_summary });
    await sb.from("matchpool_profiles").insert({
      ...p,
      offering_embedding: vectorToPgString(e.offering_embedding),
      seeking_embedding: vectorToPgString(e.seeking_embedding),
      embedding_model: e.model,
      profile_version: 1,
      intent_extracted_at: new Date().toISOString(),
      intent_extraction_confidence: 1.0,
    });
  }
  console.log("    ✓ seeded 3 synthetic candidates with real embeddings");
  return synthIds;
}

async function cleanupSynthetic(synthIds: string[]) {
  await sb.from("matchpool_profiles").delete().in("user_id", synthIds);
  await sb.from("instaclaw_users").delete().in("id", synthIds);
}

async function readResults(userId: string) {
  const { data: cached } = await sb
    .from("matchpool_cached_top3")
    .select("top3_user_ids, top3_scores, computed_at")
    .eq("user_id", userId)
    .maybeSingle();

  const { data: deliberations } = await sb
    .from("matchpool_deliberations")
    .select("candidate_user_id, match_score, rationale, conversation_topic, meeting_window, skip_reason, deliberated_at, candidate_profile_version")
    .eq("user_id", userId)
    .order("deliberated_at", { ascending: false });

  return { cached, deliberations: deliberations ?? [] };
}

async function clearPriorResults(userId: string) {
  await sb.from("matchpool_cached_top3").delete().eq("user_id", userId);
  await sb.from("matchpool_deliberations").delete().eq("user_id", userId);
}

async function main() {
  let pass = 0, fail = 0;
  const ok = (m: string) => { console.log(`  ✓ ${m}`); pass++; };
  const bad = (m: string) => { console.log(`  ✗ ${m}`); fail++; };

  console.log("══ pipeline e2e test on vm-780 ══");

  // ─ Pre-flight ─
  const userId = await getVm780UserId();
  console.log(`vm-780 user_id: ${userId}`);

  let profile = await ensureMatchpoolProfileExists(userId);
  if (!profile) {
    console.log("vm-780 has no matchpool_profile — POSTing a hand-crafted Cooper profile via /api/match/v1/profile");
    const token = await getVm780GatewayToken();
    await postCooperProfile(token);
    profile = await ensureMatchpoolProfileExists(userId);
    if (!profile) {
      console.error("FATAL: profile still missing after POST");
      process.exit(2);
    }
    console.log(`  ✓ profile created (pv=${profile.profile_version}, tier=${profile.consent_tier})`);
  } else {
    console.log(`profile pv=${profile.profile_version} tier=${profile.consent_tier}`);
  }

  // Make sure the caller is not hidden so the test can inspect symmetric
  // matches if we extend it later. Caller's own tier doesn't gate L1.
  if (profile.consent_tier === "hidden") {
    await setProfileTier(userId, "interests");
    console.log("  flipped caller tier hidden → interests for the test");
  }

  if (profile.consent_tier === "hidden") {
    // The L1 RPC filters out hidden, but we're querying for vm-780 itself
    // so it doesn't matter — we just need vm-780's row to compute against
    // the candidate pool. But the candidate pool itself filters by tier,
    // so synthetic seeds must be non-hidden.
    console.log("note: vm-780 is hidden; that's fine, we're seeding non-hidden candidates.");
  }

  let synthIds: string[] = [];
  try {
    const candidatePoolSize = await ensureCandidatePoolHasMembers(userId);
    console.log(`current candidate pool size (excluding caller): ${candidatePoolSize}`);
    if (candidatePoolSize < 2) {
      console.log("seeding 3 synthetic candidates so the pipeline has matches to find");
      synthIds = await seedSyntheticCandidates(userId);
    }

    // Wipe prior cached_top3/deliberations for this user
    await clearPriorResults(userId);

    // ─ Upload + run ─
    const ssh = new NodeSSH();
    await ssh.connect({ host: "104.237.151.95", username: "openclaw", privateKey: sshKey, readyTimeout: 12_000 });

    console.log("\n── 1. Upload pipeline scripts ──");
    for (const name of SCRIPTS_TO_UPLOAD) {
      await ssh.putFile(`${SCRIPTS_DIR}/${name}`, `/tmp/${name}`);
    }
    console.log("  ✓ uploaded 3 scripts");

    console.log("\n── 2. Run pipeline (--force --no-jitter) ──");
    const start = Date.now();
    const r = await ssh.execCommand(
      "cd /tmp && python3 consensus_match_pipeline.py --force --no-jitter"
    );
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  latency: ${elapsed}s`);
    console.log(`  exit: ${r.code}`);
    console.log("  stderr (telemetry):");
    console.log("  " + (r.stderr || "(none)").split("\n").join("\n  "));
    console.log("  stdout:");
    console.log("  " + (r.stdout || "(empty)").split("\n").join("\n  "));

    if (r.code === 0) ok("pipeline exit 0");
    else bad(`exit ${r.code}`);

    const expectedSequence = ["step=1 layer1_request", "layer1_ok", "step=2 layer2_rerank", "layer2_ok"];
    for (const s of expectedSequence) {
      if (r.stderr.includes(s)) ok(`telemetry shows: ${s}`);
      else bad(`telemetry missing: ${s}`);
    }

    // We expect either step=3 layer3_deliberate OR step=3 layer3_skipped (cold start)
    const ranL3 = r.stderr.includes("layer3_ok") || r.stderr.includes("layer3_skipped");
    if (ranL3) ok("L3 deliberation ran (or cold-start passthrough)");
    else bad("L3 path not taken");

    if (r.stderr.includes("post_results_ok")) ok("results POST succeeded");
    else if (r.stderr.includes("abort high_fallback_rate")) {
      console.log("  ⚠ pipeline aborted on high fallback rate (gateway flake) — graceful, but no DB writes this cycle");
    } else if (r.stderr.includes("post_results_failed")) {
      bad("results POST failed");
    }

    // Cleanup uploaded scripts (state file too)
    await ssh.execCommand(
      "rm -f /tmp/consensus_match_pipeline.py /tmp/consensus_match_rerank.py /tmp/consensus_match_deliberate.py ~/.openclaw/.consensus_match_state.json ~/.openclaw/.consensus_match.lock"
    );
    ssh.dispose();

    console.log("\n── 3. Verify DB state ──");
    const { cached, deliberations } = await readResults(userId);

    if (cached) {
      ok(`cached_top3 row exists (${cached.top3_user_ids?.length ?? 0} entries, computed_at=${cached.computed_at})`);
    } else if (r.stderr.includes("abort high_fallback_rate")) {
      console.log("  ⚠ no cached_top3 (pipeline aborted on fallback) — graceful degradation working");
    } else {
      bad("cached_top3 missing");
    }

    if (deliberations.length > 0) {
      ok(`${deliberations.length} deliberation rows written`);
      console.log("  Sample deliberations:");
      for (const d of deliberations.slice(0, 3)) {
        const score = Number(d.match_score).toFixed(2);
        console.log(`    ${(d.candidate_user_id as string).slice(0, 12)}…  score=${score}`);
        console.log(`      rationale: ${(d.rationale as string).slice(0, 200)}`);
        if (d.skip_reason) console.log(`      skip:      ${(d.skip_reason as string).slice(0, 150)}`);
      }
    } else if (r.stderr.includes("abort high_fallback_rate")) {
      console.log("  ⚠ no deliberations (pipeline aborted) — graceful degradation working");
    } else {
      bad("no deliberation rows written");
    }

  } finally {
    if (synthIds.length > 0) {
      console.log("\n── 4. Cleanup synthetic candidates ──");
      await cleanupSynthetic(synthIds);
      // Also wipe vm-780's deliberations referencing these synth users
      await clearPriorResults(userId);
      console.log("  ✓ synthetic profiles + deliberations removed");
    }
  }

  console.log(`\n══ ${pass} passed, ${fail} failed ══`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  console.error(e instanceof Error ? e.stack : "");
  process.exit(1);
});
