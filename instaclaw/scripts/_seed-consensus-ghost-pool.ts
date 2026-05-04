/**
 * Seed the matchpool with 10 hand-crafted "ghost" profiles representing
 * the kinds of people Consensus 2026 attendees would actually want to
 * meet: VCs, agent infra builders, AI researchers, protocol founders,
 * partnership operators, etc.
 *
 * This solves the first-mover problem for the Tue 9am launch: any user
 * who opts in immediately has a meaningful candidate pool to match
 * against. Without this, the first 5-10 opt-ins each see "no matches
 * yet" because there's nobody else to match with.
 *
 * The ghosts:
 *   1. AI infra fund partner (writes seed/Series A checks)
 *   2. Agent wallet builder (Bankr-adjacent — Base infra)
 *   3. AI researcher on long-context agent memory
 *   4. Decentralized inference protocol founder
 *   5. Privacy-AI infra builder
 *   6. Agentic-commerce platform operator
 *   7. World-builder / pop-up city operator (Edge-City-adjacent)
 *   8. Crypto-AI journalist + media operator
 *   9. Smart-contract auditor specializing in agent code
 *   10. Trading-AI quant building agent strategies
 *
 * Each profile gets real Voyage-3-large / OpenAI text-embedding-3-large
 * embeddings via lib/match-embeddings.ts so Layer 1 cosine math works
 * against them the same as real users.
 *
 * Idempotent: safe to re-run. Uses well-known UUIDs prefixed
 * `99999999-...` so cleanup is trivial. Re-running re-embeds (cheap
 * — 20 calls × $0.0002 = $0.004 per run).
 *
 * Cleanup (if/when we want to remove these):
 *   await sb.from("matchpool_profiles").delete().like("agent_id", "ghost-%");
 *   await sb.from("instaclaw_users").delete().like("email", "%@ghost.consensus");
 *
 * NOTE: ghost profiles set consent_tier='interests' (visible) and
 * partner='consensus-ghost' so we can distinguish them in queries
 * (e.g., "real opt-ins this week excluding ghosts").
 *
 * Run:
 *   npx tsx scripts/_seed-consensus-ghost-pool.ts
 *   npx tsx scripts/_seed-consensus-ghost-pool.ts --cleanup   # remove
 */
import { readFileSync } from "fs";
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

import { embedDual, vectorToPgString } from "../lib/match-embeddings";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface Ghost {
  id: string;
  agent_id: string;
  display_name: string;
  email: string;
  offering_summary: string;
  seeking_summary: string;
  interests: string[];
  looking_for: string[];
  format_preferences: string[];
}

const GHOSTS: Ghost[] = [
  {
    id: "99999999-0000-0000-0000-000000000001",
    agent_id: "ghost-vc-ai-infra",
    display_name: "Lena Park",
    email: "lena@ghost.consensus",
    offering_summary:
      "Partner at AI-focused fund. Lead seed and Series A checks $2-5M into agent infrastructure, decentralized AI compute, and crypto-AI plays. Active portfolio in agent wallet infra and Anthropic-adjacent infrastructure companies. Comfortable taking lead and stepping in as board observer.",
    seeking_summary:
      "Founders building per-user AI agent platforms with paying users and durable per-user economics. Specifically interested in agent-controlled wallet infrastructure on Base or Solana, and platforms with real conversation depth (not just chat wrappers).",
    interests: ["agentic-ai", "agent-wallets", "crypto-infrastructure", "ai-fund"],
    looking_for: ["founder", "agent-platform", "infra-startup"],
    format_preferences: ["1on1"],
  },
  {
    id: "99999999-0000-0000-0000-000000000002",
    agent_id: "ghost-agent-wallet-builder",
    display_name: "Marcus Tate",
    email: "marcus@ghost.consensus",
    offering_summary:
      "Founding engineer at an agent wallet infra startup on Base. Shipped wallet-per-agent provisioning at scale. Active partnership pipeline with multiple agent platforms. Deep knowledge of MPC, smart accounts, and gas-sponsorship UX for agents.",
    seeking_summary:
      "Other agent platform builders shipping in production who need wallet-per-agent infra. Want to compare implementation notes on session-isolated keys, custody UX, and rate-limit defenses for agent-controlled funds.",
    interests: ["agent-wallets", "base", "crypto-infrastructure", "agent-platforms"],
    looking_for: ["agent-platform-builder", "infra-collab"],
    format_preferences: ["1on1"],
  },
  {
    id: "99999999-0000-0000-0000-000000000003",
    agent_id: "ghost-researcher-memory",
    display_name: "Dr. Yuki Nakashima",
    email: "yuki@ghost.consensus",
    offering_summary:
      "AI researcher at a top university on long-context agent memory and retrieval over agentic action histories. Recent papers on cross-session memory persistence and structured fact extraction from conversation logs. Open-source release of evaluation framework forthcoming.",
    seeking_summary:
      "Engineers shipping agent platforms in production with real user data. Looking for collaboration on benchmarks for cross-session memory recall and willingness to share anonymized agent trajectory data for research.",
    interests: ["long-context-memory", "agent-research", "evaluation"],
    looking_for: ["practitioner-collab", "data-collab"],
    format_preferences: ["1on1", "small_group"],
  },
  {
    id: "99999999-0000-0000-0000-000000000004",
    agent_id: "ghost-protocol-decentralized-inference",
    display_name: "Reza Sarvi",
    email: "reza@ghost.consensus",
    offering_summary:
      "Founder of a decentralized inference protocol routing agent calls across a permissionless GPU network. Token live on Base. Several agent platforms have integrated for fallback and cost arbitrage. Looking to expand integrations.",
    seeking_summary:
      "Agent platform operators shipping volume in production who want to plug a fallback model route or arbitrage pricing across providers. Also interested in shared rate-limit pooling across platforms.",
    interests: ["decentralized-inference", "agent-platforms", "crypto-infrastructure", "base"],
    looking_for: ["agent-platform-builder", "infra-collab"],
    format_preferences: ["1on1"],
  },
  {
    id: "99999999-0000-0000-0000-000000000005",
    agent_id: "ghost-privacy-ai-builder",
    display_name: "Asha Mehta",
    email: "asha@ghost.consensus",
    offering_summary:
      "Builder at confidential-compute infra company. Trusted execution environments for agent workloads with end-to-end attestation. Live on enterprise pilots. Selling into agent platforms whose users care about data sovereignty.",
    seeking_summary:
      "Agent platforms whose users have privacy demands beyond standard cloud — financial agents, health agents, legal agents, regulated industries. Want to talk integration patterns for confidential agent execution.",
    interests: ["privacy", "confidential-compute", "agent-infrastructure", "enterprise"],
    looking_for: ["agent-platform-builder", "enterprise-pilot"],
    format_preferences: ["1on1", "small_group"],
  },
  {
    id: "99999999-0000-0000-0000-000000000006",
    agent_id: "ghost-agentic-commerce",
    display_name: "David Park",
    email: "david@ghost.consensus",
    offering_summary:
      "Operator at an agentic commerce platform. Agents transact on behalf of humans across crypto rails. Live integrations with major payment networks. Recently shipped agent-to-agent payment negotiation.",
    seeking_summary:
      "Agent platform builders interested in commerce primitives — wallet UX, intent matching, agent-to-agent transactions. Especially interested in platforms with persistent agent memory that could enable durable agent-to-agent relationships.",
    interests: ["agentic-commerce", "agent-payments", "crypto-rails", "agent-platforms"],
    looking_for: ["agent-platform-builder", "infra-collab"],
    format_preferences: ["1on1"],
  },
  {
    id: "99999999-0000-0000-0000-000000000007",
    agent_id: "ghost-pop-up-city",
    display_name: "Yumi Chen",
    email: "yumi@ghost.consensus",
    offering_summary:
      "Operator running pop-up city programs at the crypto-AI cultural edge. Live community of 1000+ builders, recurring residencies in different cities. Looking to embed agent platforms as community infrastructure for attendee coordination.",
    seeking_summary:
      "Agent platforms whose users overlap with crypto-AI builder community. Specifically: platforms shipping persistent-memory agents that could power attendee matching, event coordination, residency follow-ups.",
    interests: ["pop-up-cities", "community", "agent-platforms", "edge-city"],
    looking_for: ["agent-platform-builder", "community-partner"],
    format_preferences: ["small_group", "session"],
  },
  {
    id: "99999999-0000-0000-0000-000000000008",
    agent_id: "ghost-journalist-crypto-ai",
    display_name: "Marcus Wells",
    email: "marcus.wells@ghost.consensus",
    offering_summary:
      "Senior reporter covering crypto-AI infrastructure. Writes the most-read newsletter for institutional readers in this space. Always looking for shipping founders with real metrics, not vaporware. Strong distribution to enterprise crypto buyers.",
    seeking_summary:
      "Founders shipping production agent platforms with paying users, willing to talk metrics on the record. Interested in funding rounds, partnership announcements, and contrarian technical positions. Trades coverage for transparency.",
    interests: ["crypto-ai", "journalism", "media", "agent-platforms"],
    looking_for: ["founder", "press-opportunity"],
    format_preferences: ["1on1"],
  },
  {
    id: "99999999-0000-0000-0000-000000000009",
    agent_id: "ghost-auditor-agent-code",
    display_name: "Stephanie Ruiz",
    email: "stephanie@ghost.consensus",
    offering_summary:
      "Smart-contract auditor specializing in agent-controlled code paths. Multiple high-profile audits of agent wallet infra, agent governance contracts, and intent-matching engines. Particularly experienced with race conditions and confused-deputy issues in agent code.",
    seeking_summary:
      "Builders shipping agent platforms or agent-controlled smart contracts who want pre-launch security review. Especially interested in projects with novel custody patterns or agent-governance flows.",
    interests: ["smart-contract-audit", "agent-security", "agent-wallets", "governance"],
    looking_for: ["agent-platform-builder", "audit-engagement"],
    format_preferences: ["1on1"],
  },
  {
    id: "99999999-0000-0000-0000-00000000000a",
    agent_id: "ghost-trading-quant",
    display_name: "Vikram Iyer",
    email: "vikram@ghost.consensus",
    offering_summary:
      "Quant building trading-AI strategies that deploy as autonomous agents. Live PnL across multiple venues. Interested in agent platforms that support complex tool use, persistent strategy memory, and per-agent wallet provisioning.",
    seeking_summary:
      "Agent platforms with sophisticated tool calling and persistent state where I can deploy paper-trading agents as a beta. Also interested in market-data API providers and execution venue partnerships.",
    interests: ["trading-ai", "quant", "agent-platforms", "market-data"],
    looking_for: ["agent-platform-builder", "data-provider", "venue-partner"],
    format_preferences: ["1on1"],
  },
];

async function cleanup(): Promise<void> {
  const ids = GHOSTS.map((g) => g.id);
  await sb.from("matchpool_profiles").delete().in("user_id", ids);
  await sb.from("instaclaw_users").delete().in("id", ids);
  console.log(`✓ removed ${GHOSTS.length} ghost profiles + users`);
}

async function seed(): Promise<void> {
  // Idempotent: pre-clean
  await cleanup();

  console.log(`Seeding ${GHOSTS.length} ghost profiles…`);

  // Insert users (FK target)
  const userRows = GHOSTS.map((g) => ({
    id: g.id,
    email: g.email,
    name: g.display_name,
    partner: "consensus-ghost",  // distinguishes ghosts in audits
  }));
  const { error: uErr } = await sb.from("instaclaw_users").insert(userRows);
  if (uErr) throw new Error(`seed users: ${uErr.message}`);
  console.log(`  ✓ inserted ${userRows.length} ghost users`);

  // Embed + insert profiles
  console.log("  embedding via Voyage/OpenAI…");
  let i = 0;
  for (const g of GHOSTS) {
    const e = await embedDual({
      offering: g.offering_summary,
      seeking: g.seeking_summary,
    });
    const { error: pErr } = await sb.from("matchpool_profiles").insert({
      user_id: g.id,
      agent_id: g.agent_id,
      offering_summary: g.offering_summary,
      seeking_summary: g.seeking_summary,
      interests: g.interests,
      looking_for: g.looking_for,
      format_preferences: g.format_preferences,
      offering_embedding: vectorToPgString(e.offering_embedding),
      seeking_embedding: vectorToPgString(e.seeking_embedding),
      embedding_model: e.model,
      consent_tier: "interests",
      profile_version: 1,
      intent_extracted_at: new Date().toISOString(),
      intent_extraction_confidence: 1.0,
      partner: "consensus-ghost",
    });
    if (pErr) throw new Error(`seed profile ${g.agent_id}: ${pErr.message}`);
    i++;
    process.stdout.write(`  ${i}/${GHOSTS.length}  ${g.agent_id}\r`);
  }
  console.log(`\n  ✓ ${GHOSTS.length} ghost profiles embedded + persisted`);
}

async function main() {
  const cleanupMode = process.argv.includes("--cleanup");
  if (cleanupMode) {
    console.log("== CLEANUP MODE ==");
    await cleanup();
  } else {
    console.log("== SEED MODE ==");
    await seed();
    console.log("\nDone. Ghost pool active. Any opt-in user will find matches.");
    console.log("To remove: npx tsx scripts/_seed-consensus-ghost-pool.ts --cleanup");
  }
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
