# EE26 Research Data Export Pipeline

Anonymization + export pipeline for the Edge Esmeralda 2026 Agent Village
experiment. Pulls 5 source tables from `research.*` schema in Supabase,
hashes agent identifiers, runs a PII regex sweep on free-text fields,
writes per-table CSV/Parquet files plus a manifest and redaction log.

**Status:** v0.1.0. Gates the May 23, 2026 milestone in the EE26 PRD.
Source-of-truth: `instaclaw/docs/prd/edgeclaw-partner-integration.md`
Section 4.10.3.

## Quick start

```bash
# 1. Apply the migration (creates the research.* schema)
supabase db push --include-all

# 2. Generate a research salt (held only by InstaClaw, rotated post-village)
export EDGE_CITY_RESEARCH_SALT=$(openssl rand -hex 32)
export EDGE_CITY_RESEARCH_SALT_VERSION="ee26-v1"

# 3. Run the export
npx tsx instaclaw/scripts/_export-research-data.ts

# Output appears at ./research-exports/ee26-export-<timestamp>-<rand>/
```

## What gets exported

Five tables, one file per table per run, plus a manifest and redaction
log:

| File | Source table | Description |
|------|--------------|-------------|
| `agent_signals.csv` | `research.agent_signals` | Nightly availability signals submitted to Index Network + XMTP plaza |
| `match_outcomes.csv` | `research.match_outcomes` | Per-candidate Index Network match results + agent action taken |
| `briefing_outcomes.csv` | `research.briefing_outcomes` | Morning briefing composition + human response |
| `governance_events.csv` | `research.governance_events` | Per-proposal, per-agent governance participation |
| `cohort_assignments.csv` | `research.cohort_assignments` | Vendrov's treatment/control cohort assignments |
| `manifest.json` | — | Run metadata (export_id, salt_version, row counts, format, date range) |
| `redactions.jsonl` | — | One JSONL record per PII redaction event (for the 1% manual spot-check) |

## Privacy guarantees

The pipeline enforces the privacy commitments in PRD Section 4.10.3:

1. **`agent_id` is one-way hashed.** Source tables store raw Bankr wallet
   addresses (so the agent runtime can write to them), but the export
   pipeline replaces them with `HMAC-SHA-256(wallet, salt)` truncated to
   16 hex chars. Vendrov cannot reverse this without the salt, which is
   held only by InstaClaw and rotated post-village.

2. **Cross-table consistency.** The same wallet appearing in multiple
   tables (e.g., signals + match_outcomes + briefings) hashes to the
   same `agent_id` within a single export run. This lets researchers
   join across tables without ever seeing the raw wallet.

3. **Salt rotation.** When the salt is rotated, all hashed `agent_id`
   values change. Old exports remain re-identifiable only with the
   OLD salt — which gets destroyed on rotation. This is the
   "deletion-by-key-rotation" pattern: rotating the salt is equivalent
   to deleting all longitudinal linkage in old exports.

4. **PII regex sweep.** Free-text columns (`interests`, `goals`,
   `looking_for`, `notes`) run through six regex rules at export
   time. Matches are replaced with `<REDACTED:reason>` markers.
   Rules:

   - EVM wallets (0x + 40 hex)
   - Solana wallets (base58, 32–44 chars)
   - Emails
   - SSNs (123-45-6789)
   - IPv4 addresses
   - Phone numbers (international and US formats)

   Rule order is critical: more-specific patterns run first so the
   greedy phone regex doesn't chew up parts of a wallet or SSN.

5. **Redaction events never contain raw PII.** The `redactions.jsonl`
   log records the row id, column, rule name, reason, offset, and
   length of each redaction — but NEVER the matched text. Safe to
   share with reviewers for the 1% manual spot-check.

6. **Manifest never contains the salt.** The manifest records the
   `salt_version` (a short tag like `ee26-v1`) so future analysts
   can correlate exports that used the same agent_id mapping. The
   actual salt value is never written anywhere on disk.

7. **Per-human longitudinal study requires explicit consent.**
   `instaclaw_users.research_longitudinal_consent` defaults to FALSE.
   Tracking one specific human across multiple nights of data
   requires the user to opt in during onboarding.

## Configuration

### Required environment variables

| Var | Purpose |
|-----|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Read access to `research.*` schema |
| `EDGE_CITY_RESEARCH_SALT` | 32+ char random hex, generated with `openssl rand -hex 32` |

### Optional environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `EDGE_CITY_RESEARCH_SALT_VERSION` | `ee26-v1` | Short tag recorded in manifest |
| `RESEARCH_EXPORT_DIR` | `./research-exports` | Output directory base |

### CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--format=csv\|parquet` | `csv` | Output format. Parquet requires optional `@dsnp/parquetjs`. |
| `--out=PATH` | `./research-exports` | Output directory base |
| `--from=YYYY-MM-DD` | (none) | Lower bound of date filter (must be paired with `--to`) |
| `--to=YYYY-MM-DD` | (none) | Upper bound of date filter |
| `--quiet` | off | Suppress progress logs |

## Output format

CSV is the default and zero-dependency. Tables with TEXT[] columns
serialize the array as `;`-joined strings. To convert to Parquet
post-export:

```bash
# DuckDB one-liner
duckdb -c "COPY (SELECT * FROM read_csv_auto('agent_signals.csv'))
           TO 'agent_signals.parquet' (FORMAT PARQUET)"
```

For native Parquet output, install the optional dependency:

```bash
npm install --save-optional @dsnp/parquetjs
npx tsx instaclaw/scripts/_export-research-data.ts --format=parquet
```

## Architecture

```
scripts/_export-research-data.ts          (CLI)
   │
   ▼
lib/research-export/pipeline.ts           (orchestrator)
   │   runResearchExport(opts)
   ├─▶ extractors.ts                      (Supabase queries, paginated)
   ├─▶ anonymize.ts                       (hash + PII sweep)
   ├─▶ writers.ts                         (CSV, Parquet, manifest, JSONL)
   └─▶ schemas.ts                         (TypeScript types)
```

Each layer is testable in isolation. See:

- `__tests__/anonymize.test.ts` — 30 assertions on the hash + sweep
- `__tests__/writers.test.ts` — 16 assertions on CSV / manifest / log
- `__tests__/pipeline.integration.test.ts` — 22 end-to-end assertions
  including privacy guarantees (raw wallets never appear in output) and
  determinism (same salt → byte-identical output)

Run all tests:

```bash
npx tsx instaclaw/lib/research-export/__tests__/anonymize.test.ts
npx tsx instaclaw/lib/research-export/__tests__/writers.test.ts
npx tsx instaclaw/lib/research-export/__tests__/pipeline.integration.test.ts
```

## Operational runbook

### Pre-village (before May 30)

1. Apply the migration: `supabase db push --include-all`
2. Generate the production salt: `openssl rand -hex 32`. Store in 1Password
   under "EE26 Research Salt v1". Set `EDGE_CITY_RESEARCH_SALT` in the
   relevant env (Vercel + local admin).
3. Set `EDGE_CITY_RESEARCH_SALT_VERSION=ee26-v1`.
4. Sign DPA / NDA with Vendrov before any export runs.
5. Test against the staging DB with mock data before production.

### During the village (May 30 – June 27)

Run the export nightly via cron or GitHub Actions:

```bash
# Crontab entry — run at 2am Pacific
0 2 * * *  cd /opt/instaclaw && \
           EDGE_CITY_RESEARCH_SALT=$(cat /etc/instaclaw/research.salt) \
           npx tsx instaclaw/scripts/_export-research-data.ts \
             --out=/data/ee26-research \
             --from=$(date -v-1d +%Y-%m-%d) \
             --to=$(date +%Y-%m-%d) \
             --format=csv \
             --quiet >> /var/log/research-export.log 2>&1
```

Upload the output directory to the researcher-controlled bucket
(per the delivery model agreed with Vendrov).

### Post-village (by Sept 30, 2026)

1. Run a final full-range export.
2. Spot-check 1% of redaction events from `redactions.jsonl` for missed
   PII (especially names, which the regex doesn't catch).
3. Hand the export off to Vendrov for the formal research report.
4. Per the privacy commitment: rotate the salt by Sept 30 and delete
   the old salt. Old exports become structurally non-reidentifiable
   even by InstaClaw at this point.

## Open questions

See PRD Section 8 for the full list. Pipeline-relevant:

- **Q21** — final shape of researcher data access (CSV drop vs Postgres
  replica). v0.1.0 ships the CSV drop path; Postgres replica is a future
  add if Vendrov needs lower-latency interactive querying.
- **Q22** — sponsor commitment timeline. Affects whether we need to gate
  the export pipeline on sponsor confirmation, but mostly orthogonal to
  this code.

## Changelog

- **2026-04-29** — v0.1.0 initial implementation. Migration + 5-table
  schema + anonymization + PII sweep + CSV/Parquet writers + CLI +
  end-to-end integration tests.
