/**
 * End-to-end integration test for the research export pipeline.
 *
 * Uses an in-memory mock Supabase client (no real DB needed) to exercise
 * the full extract → anonymize → write loop. Verifies:
 *
 *   - All 5 tables get extracted, anonymized, and written
 *   - PII in source rows gets redacted
 *   - Bankr wallets in source rows get hashed (not present in output)
 *   - Same wallet appearing in multiple tables maps to the same agent_id
 *   - Manifest is written with correct row counts
 *   - Output is deterministic for a given salt
 *
 * Run: npx tsx instaclaw/lib/research-export/__tests__/pipeline.integration.test.ts
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runResearchExport } from "../pipeline";
import { hashAgentId } from "../anonymize";

let failures = 0;
const tmpRoot = path.join(os.tmpdir(), `wwb-pipeline-test-${Date.now()}`);

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    console.log(`  ✗ ${label}${detail !== undefined ? "  →  " + JSON.stringify(detail) : ""}`);
    failures++;
  }
}

const VALID_SALT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const WALLET_A = "0xaaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const WALLET_B = "0xbbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";

// ─── Mock Supabase client ────────────────────────────────────────────

interface MockTable {
  rows: Record<string, unknown>[];
}

function makeMockSupabase(tables: Record<string, MockTable>) {
  const buildQuery = (rows: Record<string, unknown>[]) => {
    let filtered = [...rows];
    let rangeApplied = false;
    let pageStart = 0;
    let pageEnd = Number.MAX_SAFE_INTEGER;

    const result = () => ({
      data: rangeApplied ? filtered.slice(pageStart, pageEnd + 1) : filtered,
      error: null as null | { message: string },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      range: (from: number, to: number) => {
        rangeApplied = true;
        pageStart = from;
        pageEnd = to;
        return chain;
      },
      order: () => chain,
      gte: () => chain,
      lte: () => chain,
      eq: (col: string, val: unknown) => {
        filtered = filtered.filter((r) => r[col] === val);
        return chain;
      },
      not: () => chain,
      // Thenable — Supabase's QueryBuilder resolves to { data, error } on await
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        try {
          return Promise.resolve(result()).then(resolve, reject);
        } catch (e) {
          if (reject) return reject(e);
          throw e;
        }
      },
    };
    return chain;
  };

  return {
    schema: (schemaName: string) => ({
      from: (tableName: string) => {
        const tableKey = `${schemaName}.${tableName}`;
        return buildQuery(tables[tableKey]?.rows ?? []);
      },
    }),
    from: (tableName: string) => {
      return buildQuery(tables[tableName]?.rows ?? []);
    },
  };
}

// ─── Mock data ───────────────────────────────────────────────────────

function makeFixtures() {
  return {
    "research.agent_signals": {
      rows: [
        {
          signal_id: "11111111-1111-1111-1111-111111111111",
          bankr_wallet: WALLET_A,
          night_of: "2026-06-01",
          interests: ["AI agents", "biotech", "alice@example.com is here"],
          goals: ["meet a biotech founder"],
          looking_for: ["AI researcher"],
          available_slot_count: 3,
          week: 1,
          submitted_to_index_network_at: "2026-06-01T22:30:00Z",
          created_at: "2026-06-01T22:30:00Z",
        },
        {
          signal_id: "22222222-2222-2222-2222-222222222222",
          bankr_wallet: WALLET_B,
          night_of: "2026-06-01",
          interests: ["governance", "Coasean bargaining"],
          goals: ["learn about pol.is"],
          looking_for: ["mechanism designer"],
          available_slot_count: 2,
          week: 1,
          submitted_to_index_network_at: "2026-06-01T22:31:00Z",
          created_at: "2026-06-01T22:31:00Z",
        },
      ],
    },
    "research.match_outcomes": {
      rows: [
        {
          outcome_id: "33333333-3333-3333-3333-333333333333",
          signal_id: "11111111-1111-1111-1111-111111111111",
          candidate_bankr_wallet: WALLET_B,
          match_score: 0.87,
          agent_action: "dm_sent",
          counterpart_response: "accepted",
          human_confirmed: true,
          meeting_actually_happened: null,
          created_at: "2026-06-02T04:00:00Z",
        },
      ],
    },
    "research.briefing_outcomes": {
      rows: [
        {
          briefing_id: "44444444-4444-4444-4444-444444444444",
          bankr_wallet: WALLET_A,
          briefing_date: "2026-06-02",
          proposed_intro_count: 3,
          proposed_event_count: 2,
          proposed_governance_count: 1,
          human_response: "approved_partial",
          response_latency_minutes: 12,
          created_at: "2026-06-02T07:00:00Z",
        },
      ],
    },
    "research.governance_events": {
      rows: [
        {
          event_id: "55555555-5555-5555-5555-555555555555",
          proposal_id: "prop-housing-001",
          bankr_wallet: WALLET_A,
          agent_surfaced_to_human: true,
          human_voted: true,
          vote_value: "yes",
          vote_latency_minutes: 8,
          created_at: "2026-06-03T15:00:00Z",
        },
      ],
    },
    "research.cohort_assignments": {
      rows: [
        {
          assignment_id: "66666666-6666-6666-6666-666666666666",
          bankr_wallet: WALLET_A,
          experiment_id: "h1-introduction-graph",
          cohort: "treatment",
          assigned_at: "2026-05-30T00:00:00Z",
          notes: "active agent cohort. contact: alice@example.com",
        },
      ],
    },
  };
}

// ─── Test ────────────────────────────────────────────────────────────

async function main() {
  await fs.mkdir(tmpRoot, { recursive: true });

  console.log("\n# end-to-end pipeline run");

  const fixtures = makeFixtures();
  const supabase = makeMockSupabase(fixtures) as never;

  const result = await runResearchExport({
    supabase,
    salt: VALID_SALT,
    saltVersion: "test-v1",
    outputDir: tmpRoot,
    format: "csv",
    verbose: false,
  });

  check("export id generated", typeof result.exportId === "string" && result.exportId.length > 10);

  check(
    "row counts match input",
    result.rowCounts.agent_signals === 2 &&
      result.rowCounts.match_outcomes === 1 &&
      result.rowCounts.briefing_outcomes === 1 &&
      result.rowCounts.governance_events === 1 &&
      result.rowCounts.cohort_assignments === 1
  );

  // Verify all 5 CSV files exist
  for (const t of [
    "agent_signals",
    "match_outcomes",
    "briefing_outcomes",
    "governance_events",
    "cohort_assignments",
  ]) {
    const filePath = path.join(result.outputPath, `${t}.csv`);
    const stat = await fs.stat(filePath).catch(() => null);
    check(`${t}.csv exists`, !!stat && (stat?.size ?? 0) > 0);
  }

  // Verify manifest
  const manifestRaw = await fs.readFile(path.join(result.outputPath, "manifest.json"), "utf-8");
  const manifest = JSON.parse(manifestRaw);
  check("manifest has expected salt_version", manifest.salt_version === "test-v1");
  check("manifest has format", manifest.format === "csv");

  // Verify NO raw wallets in any output
  console.log("\n# privacy guarantees");

  const allFileContents = await Promise.all(
    [
      "agent_signals.csv",
      "match_outcomes.csv",
      "briefing_outcomes.csv",
      "governance_events.csv",
      "cohort_assignments.csv",
      "manifest.json",
      "redactions.jsonl",
    ].map((f) => fs.readFile(path.join(result.outputPath, f), "utf-8"))
  );
  const corpus = allFileContents.join("\n");

  check(
    "WALLET_A not in any output file",
    !corpus.toLowerCase().includes(WALLET_A.toLowerCase())
  );
  check(
    "WALLET_B not in any output file",
    !corpus.toLowerCase().includes(WALLET_B.toLowerCase())
  );
  check(
    "salt not in any output file",
    !corpus.includes(VALID_SALT)
  );

  // Verify hashes ARE in output, and same wallet → same hash across tables
  const hashA = hashAgentId(WALLET_A, VALID_SALT);
  const hashB = hashAgentId(WALLET_B, VALID_SALT);
  check("hash for wallet A appears in output", corpus.includes(hashA));
  check("hash for wallet B appears in output", corpus.includes(hashB));

  const signalsCsv = await fs.readFile(
    path.join(result.outputPath, "agent_signals.csv"),
    "utf-8"
  );
  const briefingsCsv = await fs.readFile(
    path.join(result.outputPath, "briefing_outcomes.csv"),
    "utf-8"
  );
  check(
    "wallet A hash in agent_signals AND briefing_outcomes (cross-table consistency)",
    signalsCsv.includes(hashA) && briefingsCsv.includes(hashA)
  );

  // PII redaction
  console.log("\n# PII redaction");

  const cohortsCsv = await fs.readFile(
    path.join(result.outputPath, "cohort_assignments.csv"),
    "utf-8"
  );
  check(
    "email in cohort notes redacted",
    !cohortsCsv.includes("alice@example.com") && cohortsCsv.includes("<REDACTED:email>")
  );

  check(
    "email in interests array redacted",
    !signalsCsv.includes("alice@example.com") && signalsCsv.includes("<REDACTED:email>")
  );

  // Redaction log written
  const redactionsRaw = await fs.readFile(
    path.join(result.outputPath, "redactions.jsonl"),
    "utf-8"
  );
  const redactionLines = redactionsRaw.trim().split("\n").filter((l) => l.length > 0);
  check("redactions.jsonl has events", redactionLines.length >= 2);
  check(
    "redaction events never include the matched text",
    !redactionsRaw.includes("alice@example.com") && !redactionsRaw.includes("@example.com")
  );

  // Determinism
  console.log("\n# determinism");

  const result2 = await runResearchExport({
    supabase,
    salt: VALID_SALT,
    saltVersion: "test-v1",
    outputDir: tmpRoot,
    format: "csv",
    verbose: false,
  });

  const csv1 = await fs.readFile(path.join(result.outputPath, "agent_signals.csv"), "utf-8");
  const csv2 = await fs.readFile(path.join(result2.outputPath, "agent_signals.csv"), "utf-8");
  check("two runs with same salt produce identical content", csv1 === csv2);

  // Salt rotation
  const result3 = await runResearchExport({
    supabase,
    salt: VALID_SALT.replace(/0/g, "1"),
    saltVersion: "test-v2",
    outputDir: tmpRoot,
    format: "csv",
    verbose: false,
  });
  const csv3 = await fs.readFile(path.join(result3.outputPath, "agent_signals.csv"), "utf-8");
  check("rotated salt produces different agent_ids", csv1 !== csv3);

  // Cleanup
  await fs.rm(tmpRoot, { recursive: true, force: true });

  if (failures > 0) {
    console.log(`\n❌ ${failures} test(s) failed`);
    process.exit(1);
  } else {
    console.log("\n✅ all integration tests passed");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
