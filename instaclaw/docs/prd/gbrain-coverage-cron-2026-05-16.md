# gbrain-coverage cron — design

**Status:** SCOPE / DRAFT. Not yet implemented. Submit to Cooper before code lands.
**Date:** 2026-05-16
**Predecessor:** May-12 PRD `gbrain-fleet-rollout-2026-05-12.md` §10 P2 (proposed but not designed)
**Trigger:** Soak verification on vm-354 today exposed the gap — the cheap V+T+S+P idempotency check in `stepGbrain` reports `alreadyCorrect` for a VM whose sidecar is up + reachable but whose underlying PGLite is broken (e.g., the IR-induced vm-050 state earlier in this session).

---

## §0 — Problem

`stepGbrain`'s idempotency check is shallow by design:
- V — `gbrain --version` matches pinning
- T — `mcp.servers.gbrain.transport` is `streamable-http`
- S — `systemctl --user is-active gbrain.service` is `active`
- P — port 3131 bound to 127.0.0.1

Total cost: ~2 seconds per VM per reconcile cycle. Acceptable for fleet-wide check every 3 min.

But: a VM whose sidecar process is running, port is bound, /health returns 200 — but whose PGLite schema is broken, bearer token has drifted, or `put_page` fails for any internal reason — will pass the cheap check and stay `alreadyCorrect` indefinitely. Per Rule 23 lying-DB pattern, the reconciler never re-runs install and the broken state persists silently until a user complaint.

We need a DEEP health check that exercises the actual put_page → get_page round-trip. This check is **expensive** (~2-5s per VM + an OpenAI embed call) so it can't run on every 3-min reconcile cycle. It belongs in a SEPARATE cron at a longer interval (hourly).

## §1 — Scope

A new Vercel cron that:
1. Runs hourly (or every 30 min during Esmeralda)
2. Iterates over assigned + healthy edge_city VMs that have gbrain installed (`mcp.servers.gbrain.transport === streamable-http`)
3. SSHes into each, runs `verify-gbrain-mcp.py` with the per-VM bearer
4. Parses RESULT_OK / RESULT_FAIL output
5. Records to a per-VM health log + tracks consecutive failures
6. Sends admin alerts on RESULT_FAIL (deduped 6h, escalates at ≥3 consecutive)

## §2 — What this catches that V+T+S+P misses

Per Rule 31, named failure modes the cheap check can't detect:
- **Embedding-dimension mismatch** — PGLite schema has `vector(1536)` but env has `GBRAIN_EMBEDDING_DIMENSIONS=1024` → every put_page errors at embed time. The vm-050 2026-05-11 incident.
- **PGLite write failure** — disk near-full, file permission drift, schema migration stalled mid-way. /health returns 200 because it's a stat query, but actual INSERT fails.
- **Bearer token drift** — bearer file rotated but DB row doesn't reflect (or vice versa). /mcp initialize might still authenticate via a stale fallback path; actual `tools/call` returns 401.
- **OpenAI key revocation** — sidecar starts fine but every put_page fails at embed call. Hard to detect via /health.
- **Anthropic key issues** — degrades expansion only; non-fatal for our verify (we use get_page slug lookup, not search). Surfaced as `anthropic_auth_warn` in the RESULT_OK line.
- **Sidecar process running but main worker thread crashed** — Bun runtime quirks. /health may still respond from a sibling worker; tools/call fails.

## §3 — Schema changes

### New table `instaclaw_gbrain_health_log`

Per-check audit trail. Append-only.

```sql
CREATE TABLE instaclaw_gbrain_health_log (
  id BIGSERIAL PRIMARY KEY,
  vm_id UUID NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL,  -- 'ok' | 'fail' | 'skipped'
  fail_code TEXT,         -- when status='fail', the RESULT_FAIL code from verify-gbrain-mcp.py
  latency_ms INTEGER,     -- end-to-end wall-clock for the verify run
  marker_ts TEXT,         -- correlation with the verify script's MARKER_TS for log dives
  details_json JSONB      -- full RESULT_OK / RESULT_FAIL kvpairs
);
CREATE INDEX idx_gbrain_health_log_vm_at ON instaclaw_gbrain_health_log(vm_id, checked_at DESC);
CREATE INDEX idx_gbrain_health_log_status ON instaclaw_gbrain_health_log(status) WHERE status = 'fail';
```

### New columns on `instaclaw_vms`

Per-VM rolling state for the cron's batch query (NULLS FIRST ordering).

```sql
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS gbrain_last_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gbrain_last_check_status TEXT,
  ADD COLUMN IF NOT EXISTS gbrain_consecutive_failures INTEGER DEFAULT 0;
```

### Migration path

Per Rule 56 (just landed in CLAUDE.md): place the migration in `supabase/pending_migrations/` first, NOT `migrations/`. Cooper applies via `supabase db push` against the live DB. Then code can land.

File: `supabase/pending_migrations/20260516XXXXXX_gbrain_coverage_schema.sql`

## §4 — Implementation

### §4.1 — `lib/gbrain-coverage.ts`

Single-VM check function. Takes an SSH connection + VM record, returns a structured result.

```typescript
// pseudocode
interface CoverageCheckResult {
  status: "ok" | "fail" | "skipped";
  failCode?: string;           // when status='fail'
  latencyMs: number;
  markerTs: string;
  details: Record<string, string>;  // parsed RESULT_OK/FAIL kvpairs
  skipReason?: string;          // when status='skipped'
}

export async function checkGbrainCoverage(
  ssh: SSHConnection,
  vm: VMRecord,
): Promise<CoverageCheckResult> {
  // 1. Read bearer + env vars from the VM
  // 2. Upload verify-gbrain-mcp.py if not present (cache via mtime check)
  // 3. Run: TOKEN=... GBRAIN_BEARER_TOKEN=$TOKEN MARKER_TS=... timeout 60 python3 /tmp/verify-gbrain-mcp.py
  // 4. Parse RESULT_OK / RESULT_FAIL <CODE> from stdout
  // 5. Return CoverageCheckResult
}
```

### §4.2 — `app/api/cron/gbrain-coverage/route.ts`

The Vercel cron handler.

```typescript
// pseudocode
export const runtime = "nodejs";
export const maxDuration = 600;  // Rule 11 — LLM calls inside verify

const BATCH_SIZE = 10;
const CRON_LOCK_TTL_SEC = 660;  // > maxDuration

export async function GET(req: Request) {
  // 1. Auth check (same pattern as other crons)
  // 2. Acquire distributed cron lock
  try {
    // 3. Query candidates:
    //    SELECT * FROM instaclaw_vms
    //    WHERE partner = 'edge_city'
    //      AND health_status = 'healthy'
    //      AND status = 'assigned'
    //      AND (gbrain_last_check_at IS NULL OR gbrain_last_check_at < now() - INTERVAL '50 minutes')
    //    ORDER BY gbrain_last_check_at NULLS FIRST
    //    LIMIT BATCH_SIZE;

    // 4. For each VM (sequentially OR small concurrency=3):
    //    - SSH connect
    //    - checkGbrainCoverage(ssh, vm)
    //    - INSERT into instaclaw_gbrain_health_log
    //    - UPDATE instaclaw_vms SET gbrain_last_check_at, status, consecutive_failures
    //    - On RESULT_FAIL: send admin alert (deduped 6h by vm_id+fail_code)
    //    - On 3+ consecutive failures: escalation alert (page-level urgency)

    // 5. Return summary { checked, ok, fail, skipped, escalated }
  } finally {
    // Release cron lock
  }
}
```

### §4.3 — `vercel.json` cron registration

```json
{
  "crons": [
    { "path": "/api/cron/gbrain-coverage", "schedule": "0 * * * *" }
  ]
}
```

Hourly at minute 0. During Esmeralda (May 30+), Cooper can bump to `*/30 * * * *` for tighter detection.

### §4.4 — Alert deduplication

Use the existing `instaclaw_admin_alert_log` table with dedup_key:
- Normal fail: `gbrain-coverage:${vmId}:${failCode}` (6h dedup)
- Escalation (3+ consecutive): `gbrain-coverage-escalated:${vmId}` (24h dedup, paging severity)

## §5 — Cost analysis

Per check (one VM):
- SSH overhead: ~500ms
- `verify-gbrain-mcp.py` runtime: ~2-5s (3-5 HTTP requests + OpenAI embed)
- OpenAI cost: ~$0.00013 per check (text-embedding-3-large at ~7 tokens for the marker page)

At hourly cadence for 200 edge_city VMs (peak Esmeralda):
- 4800 checks/day × $0.00013 = $0.62/day → $19/mo
- 30-min cadence: $38/mo

Acceptable. Most expensive item: Vercel function-second time. Each batch of 10 VMs × ~3s/check = ~30s. Hourly = 720s/day of function time = well within hobby limits.

## §6 — Rollout

### Phase 1 — Schema migration (Cooper action)
1. I create `supabase/pending_migrations/20260516XXXXXX_gbrain_coverage_schema.sql` per Rule 56.
2. Cooper reviews + applies via `supabase db push` against live DB.
3. Once columns exist, Cooper signs off + I move the migration from `pending_migrations/` to `migrations/` in the same PR as the code.

### Phase 2 — Code lands
1. PR adds `lib/gbrain-coverage.ts` + `app/api/cron/gbrain-coverage/route.ts` + `vercel.json` cron entry + the migration file.
2. Default behavior: cron is registered but the route returns early if env var `GBRAIN_COVERAGE_ENABLED !== "true"` (feature flag, same pattern as `GBRAIN_INSTALL_ENABLED`).
3. PR merges. Vercel deploys. Cron registers but does nothing.

### Phase 3 — Canary
1. Cooper sets `GBRAIN_COVERAGE_ENABLED=true` in Vercel env.
2. Next cron tick (within 60 min) starts hitting VMs.
3. Watch `instaclaw_gbrain_health_log` for the first batch of results. Verify:
   - vm-050 → RESULT_OK
   - vm-354 → RESULT_OK
   - Any other edge_city VM that was already HTTP-sidecar-installed → RESULT_OK
   - VMs without sidecar yet → skipped with reason

### Phase 4 — Fleet
After 24h clean canary: bump to `*/30 * * * *` if Cooper wants tighter detection for Esmeralda.

## §7 — Failure modes the cron itself can have

Per Rule 31:
- **SSH timeout** → record as `status='skipped' skipReason='ssh_timeout'`. Don't escalate. Retry next cycle.
- **Verify script timeout** (60s limit inside verify) → `fail_code='VERIFY_TIMEOUT'`. Escalates after 3 consecutive.
- **VM in suspend/hibernate state** → skip via the candidate query filter (`health_status='healthy'` excludes these).
- **Cron lock contention** → 5xx, next tick retries. Acceptable.
- **OpenAI rate-limited mid-check** → `fail_code='PUT_HTTP_ERROR'` with embed-related stderr. Escalates if persistent across cycles (typically resolves within an hour).
- **Anthropic rate-limited** → not fatal for verify (we use get_page slug lookup). Verify returns OK with `anthropic_auth_warn=yes`. Log as warn, don't escalate.
- **The cron itself errors** → existing admin alert pipeline catches it; we don't need new infrastructure.

## §8 — What this rule DOESN'T do

To avoid scope creep:
- Does NOT auto-fix broken VMs. It's a detection/alerting cron. Recovery is operator-driven.
- Does NOT replace `stepGbrain`'s idempotency check. The cheap V+T+S+P check still runs every 3 min for fast reconciler-driven repair of obvious issues.
- Does NOT verify other reconciler state (config_version, partner-skill installs, etc.) — those have their own coverage mechanisms.

## §9 — Open questions for Cooper

1. **Schedule frequency.** I'm proposing hourly. Want to start more conservatively (every 4h or 6h) and tighten after canary?
2. **Alert routing.** Same as other admin alerts (Resend email to coop@valtlabs.com)? Or different SLA tier for Esmeralda?
3. **VM filter.** Initially `partner='edge_city' AND status='assigned' AND health_status='healthy'`. Should I also include partner='consensus_2026' (Cooper's main bot) for symmetry, or stay edge_city only for now?
4. **Esmeralda dashboard integration.** Want the gbrain coverage stat surfaced in the proposed Esmeralda monitoring dashboard (May-12 PRD §9.1)? If yes, I'll plumb a summary endpoint.
5. **Phase 3 canary timing.** Land the code before May 23 snapshot bake? Or after?

## §10 — Tracking

Tracked as P1 in CLAUDE.md Rule 35's "Open P1 Follow-Ups" section + Task #75 (renamed from "Phase 2 research behaviors" — that task is obsolete; this is its successor).
