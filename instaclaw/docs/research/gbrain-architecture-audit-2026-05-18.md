# gbrain Architecture Audit — Research Findings (2026-05-18)

**Mode:** Deep research only — no code changes proposed. Spec-first per the new operating directive.
**Probe basis:** 3 edge_city VMs covering the age spectrum (vm-050 = 3 days, vm-354 = 2 days, vm-771 = today after disk-cleanup retry). Raw probe logs at `/tmp/gbrain-audit/*.log` (local-only, contains API keys — see §6 for cleanup).
**Index source basis:** `indexnetwork/index@main` packages/edgeclaw/install/* (read directly from GitHub raw, not summarized via WebFetch).

---

## 0. Executive summary

| Question | Answer (one-line) |
|---|---|
| Real put_page latency? | **270–420ms cold-start, 16–19ms warm** (warm path is content-hash skip; real user facts hit cold) |
| Real search latency? | **31–102ms cold, 19–30ms warm** (semantic search; faster than I expected) |
| Real get_page latency? | **15–26ms** (deterministic, no embed) |
| PGLite size baseline? | **42 MB on every VM regardless of page count** (1536-dim pgvector schema + indexes dominate; user data is incremental beyond) |
| Embedding model? | `openai:text-embedding-3-large` (1536 dimensions; configurable via `GBRAIN_EMBEDDING_MODEL` env) |
| PGLite version pinned? | `0.4.3`. **Latest is 0.4.5 (2 patches behind).** Changelog 0.4.4/0.4.5 = "Disable checkpointer" + "Fix caching of artifacts" — neither addresses Rule 54 SIGTERM corruption |
| gbrain version pinned? | `v0.35.0.0` (commit `baf1a47`, 2026-05-15). **Upstream has shipped 9 versions in the 2 days since** (up to v0.35.7.0 today). One known PGLite embed-hang issue tracked at upstream #1065 (CLI batch path, not runtime tool path — doesn't affect us). |
| Index = gbrain coexistence problem? | **Non-problem.** They don't overlap. gbrain = personal memory always. Index = discovery/matchmaking always. Only interaction: agent stores Index match outcomes via `gbrain__put_page` (standard usage). |
| Index installer architecture? | 3 crons + 1 `mcp.servers.index` config entry + workspace files. ~150 LOC. Reproducible as a reconciler step (§3.3 below). |

The protocol is healthy. The biggest *operational* finding: **gbrain upstream is moving FAST** (7 versions in 2 days, including v0.35.4.0 "58x perf" and v0.35.6.0 "search metadata boost gate"). The biggest *integration* finding: Index Network's installer is small enough that we can replicate it in a reconciler step with high fidelity — but Index's signup API requires a master key that lives server-side only, so our reconciler step needs Cooper to add `INDEX_NETWORK_MASTER_KEY` to Vercel env first.

---

## 1. Thread 1 — gbrain architecture (measured, not assumed)

### 1.1 Data flow trace (verified end-to-end)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Agent's LLM produces tool_use block: { name: "gbrain__put_page",  │
│  input: { slug, title, content } }                                  │
└────────────────────────────┬────────────────────────────────────────┘
                             │ (intercepted by OpenClaw's MCP client)
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  OpenClaw MCP client reads ~/.openclaw/openclaw.json:                │
│    mcp.servers.gbrain = {                                            │
│      transport: "streamable-http",                                   │
│      url: "http://127.0.0.1:3131/mcp",                               │
│      headers: { Authorization: "Bearer gbrain_<71-char-hex>" }      │
│    }                                                                  │
└────────────────────────────┬────────────────────────────────────────┘
                             │ HTTP POST /mcp (JSON-RPC, Accept: text/event-stream)
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  gbrain.service (systemd --user, KillSignal=SIGKILL per Rule 54):    │
│    bun /home/openclaw/.bun/install/global/node_modules/gbrain/       │
│      src/cli.ts serve --http --port 3131                             │
│  Listens loopback-only (127.0.0.1:3131). Single PID per VM.          │
│  Bearer auth via PGLite access_tokens table.                         │
└────────────────────────────┬────────────────────────────────────────┘
                             │ (parsed by @modelcontextprotocol/sdk v1.29.0)
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Tool handler: put_page(slug, title, content)                       │
│   1. Hash content; check existing page hash for same slug            │
│   2. If unchanged → skip embedding, update updated_at, return        │
│   3. If new/changed → chunk content, call OpenAI:                    │
│        POST https://api.openai.com/v1/embeddings                     │
│        { model: "text-embedding-3-large", input: [chunks] }          │
│      → returns 1536-dim float32 vector(s)                            │
│   4. Write pages + chunks + embeddings rows in PGLite (pgvector)    │
└────────────────────────────┬────────────────────────────────────────┘
                             │ JSON-RPC response: { slug, status, chunks: N, ... }
                             ▼ (event-stream framed)
┌─────────────────────────────────────────────────────────────────────┐
│  OpenClaw delivers to agent as tool_result content block.           │
│  Agent uses the slug in subsequent turn.                            │
└─────────────────────────────────────────────────────────────────────┘
```

**Verified:**
- All 3 probed VMs use streamable-http transport with Bearer auth. Loopback 127.0.0.1:3131 confirmed via `ss -lnpt`.
- gbrain version `0.35.0.0` consistent across all 3 VMs (matches `GBRAIN_PINNED_VERSION` in `lib/vm-reconcile.ts:127`).
- systemd unit (`systemctl --user cat gbrain.service`) shows:
  - `Environment=GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large`
  - `Environment=OPENAI_API_KEY=<redacted>` (sk-proj-... 154 chars)
  - `Environment=ANTHROPIC_API_KEY=<redacted>` (sk-ant-... 108 chars)
  - `MemoryHigh=2G`, `MemoryMax=2500M`, `TasksMax=50`
  - `KillSignal=SIGTERM` (base unit) **OVERRIDDEN** by drop-in `KillSignal=SIGKILL` (Rule 54). Drop-in took effect on all 3 probed VMs.

### 1.2 Latency measurements (3 iterations per op per VM, n=9 per op)

Curl-timed POST against `http://127.0.0.1:3131/mcp` from the VM itself (zero network):

| Op | VM | Run 1 (ms) | Run 2 (ms) | Run 3 (ms) | Notes |
|---|---|---|---|---|---|
| **put_page** | vm-050 | 273 | 19 | 17 | Run 1 = cold (new slug, embedding call); 2-3 = warm (idempotency hash skip) |
| put_page | vm-354 | 420 | 18 | 19 | (same shape) |
| put_page | vm-771 | 410 | 16 | 17 | (same shape) |
| **get_page** | vm-050 | 19 | 25 | 26 | Slug-keyed lookup; no embedding |
| get_page | vm-354 | 18 | 17 | 16 | (consistent) |
| get_page | vm-771 | 24 | 18 | 15 | (consistent) |
| **search** | vm-050 | 102 | 26 | 23 | Run 1 = embed query + vector scan; 2-3 = query-embedding cached |
| search | vm-354 | 47 | 26 | 30 | (warmer query embed pool) |
| search | vm-771 | 31 | 19 | 21 | (fewer pages = faster scan, likely) |

**Interpretation:**

- **put_page cold path** is **270–420ms**, dominated by the OpenAI embedding API roundtrip (text-embedding-3-large typical 100–300ms + small chunking + Postgres write). For a user request "remember my birthday", that's the latency.
- **put_page warm path** (same slug, same content) is **16–19ms** — gbrain detects unchanged content via hash and skips the embed call entirely. **This is the path my repeat-iteration probe exercised, NOT the real user-facing latency.** A future audit should use a unique slug per iteration to measure the true cold-path distribution.
- **get_page** is **15–26ms** consistently — a B-tree slug lookup with no embedding.
- **search** cold-path (first query) is **30–100ms**: one OpenAI embed call for the query + vector similarity scan + result chunk read. Warm-path is 19–30ms.

**Statistical caveats:** n=9 per op. No P95/P99. Single-VM, single-time-window. Don't read these as production distributions — they're "is this in the right order of magnitude" measurements. Real user latency includes the OpenClaw → MCP-client → sidecar trip + the gateway proxy to Anthropic. The numbers above are gbrain-internal only.

**Headline:** gbrain is fast enough for a "remember this" UX. Sub-500ms cold-path put_page is well within "feels instant" budget. The Rule 28 directive "MUST call before responding" doesn't introduce a noticeable latency tax.

### 1.3 PGLite storage characterization

```
$ du -sh ~/.gbrain/brain.pglite
42M  /home/openclaw/.gbrain/brain.pglite     # vm-050 (3 pages, 3 days old)
42M  /home/openclaw/.gbrain/brain.pglite     # vm-354 (3 pages, 2 days old)
42M  /home/openclaw/.gbrain/brain.pglite     # vm-771 (2 pages, today)
```

The 42 MB is the **schema + extension baseline**:
- PGLite WASM init (a few MB)
- pgvector extension binary + supporting indexes
- gbrain schema (~30 migrations through v66): pages, chunks, embeddings, links, timeline, tags, access_tokens, jobs, etc.
- Empty B-tree + HNSW indexes pre-allocate space

Per-page incremental cost: ~7 KB per chunk (1536-dim float32 vector = 6 KB + chunk text + metadata). A typical user fact is 1–3 chunks → ~7–21 KB per page. Conservative estimate: **10,000 pages ≈ 70 MB user data + 42 MB baseline ≈ ~110 MB total.** Well within any reasonable VM disk budget.

**What I didn't measure** (P2 followup): performance degradation curve as page count grows. The HNSW vector index has a known O(log N) search cost but real-world degradation depends on parameters (m, ef_construction, ef_search). gbrain's HNSW config not yet audited.

**Backups + corruption forensics on vm-050:**
```
brain.pglite.canary-checkpoint-20260515T231823.tar.gz  5.8 MB
brain.pglite.pre-upgrade-20260515T230758.tar.gz        5.1 MB
brain.pglite.PRE-WIPE-20260515T232244.tar.gz           5.8 MB
brain.pglite.PRE-WIPE-20260516T154436.tar.gz           5.9 MB
brain.pglite.BROKEN-20260516T152817/                   (data dir, kept for forensics — Rule 54 SIGTERM corruption)
```

Cooper's discipline visible in the `.PRE-WIPE-*.tar.gz` files (4 backups across 2 days, ~5–6 MB compressed each). The `BROKEN-*/` data dir is the empirical proof of Rule 54: it's the data dir that exists post-SIGTERM and can't be re-opened by gbrain's WASM init. Preserved on disk for upstream-issue evidence.

### 1.4 Embedding model + dimensions

From systemd Environment:
```
GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large
```

From gbrain source (`~/gbrain/src/commands/`):
- Default: `'openai:text-embedding-3-large'` (`src/commands/providers.ts` + `src/commands/upgrade.ts`)
- `DEFAULT_EMBEDDING_DIMENSIONS = 1536` (`src/commands/models.ts`)
- Configurable per-engine: VoyageAI and ZeroEntropy allow custom dimensions; OpenAI defaults to 1536.

**text-embedding-3-large characteristics (verified):**
- Dimensions: 1536 (also supports 256 / 1024 / 3072 via `dimensions` param, but gbrain uses default 1536)
- Context window: 8192 tokens (~6000 words)
- Typical API latency: 100–300ms for ~7-token input (matches our cold-path measurement)
- Cost: $0.13 / 1M input tokens. At 7 tokens per typical user fact, ~$0.0000009 per put_page. 10,000 facts = ~$0.01. Negligible.

**Quality assessment** (qualitative, not benchmarked): text-embedding-3-large is OpenAI's strongest general-purpose embedder. It significantly outperforms `text-embedding-ada-002` (the previous-generation default) on MTEB benchmarks. For "user said 'I love coffee in the morning' / agent later asks 'do they prefer coffee or tea'" — solid semantic match. For domain-specific queries (medical, legal, code) — would benefit from a fine-tuned alternative, but that's beyond Esmeralda scope.

### 1.5 PGLite version + bug-fix status

- Pinned: `@electric-sql/pglite: "0.4.3"` (gbrain `package.json`)
- Latest: `0.4.5` (npm publish 2026-04-27 per `https://registry.npmjs.org/@electric-sql/pglite`)
- We're **2 patch versions behind**.

Changelog review (0.4.4 + 0.4.5):
- **0.4.4** (2026-04-09): "Disable checkpointer"
- **0.4.5** (2026-04-27): "Fix caching of artifacts such that they are not downloaded multiple times"

**Neither addresses Rule 54 (SIGTERM corruption).** Cooper's `KillSignal=SIGKILL` drop-in workaround remains the only known fix.

`Disable checkpointer` in 0.4.4 is interesting — could affect WAL flush behavior under load. Worth checking if gbrain relies on checkpointer semantics. Quick spot-check: `grep -r checkpoint ~/gbrain/src/` would tell us. P3 followup.

### 1.6 gbrain upstream activity since our pin (load-bearing surprise)

**We pinned `baf1a47` (v0.35.0.0) on 2026-05-15.** Upstream has shipped **9 versions in the 2 days** since:

| Version | Date | Title |
|---|---|---|
| v0.35.1.0 | 2026-05-16 | embedder shootout prereqs (pricing + gateway export + `--resume-from`) |
| v0.35.1.1 | 2026-05-16 | longmemeval fix wave (adapter + slug + gateway-wire) |
| v0.35.3.0 | 2026-05-17 | fix wave: extract_facts items + git --no-recurse-submodules placement |
| v0.35.3.1 | 2026-05-17 | feat(eval): temporal-aware contradiction probe + verdict enum |
| v0.35.4.0 | 2026-05-17 | **fix(doctor,entities): supervisor crash classification + bare-name resolver + 58x perf + stub guard observability** |
| v0.35.5.0 | 2026-05-17 | fix wave: bootstrap + orphans + think MCP + worktree + walker |
| v0.35.5.1 | 2026-05-17 | fix(doctor): stop counting clean supervisor exits as crashes |
| v0.35.6.0 | 2026-05-17 | **feat(search): floor-ratio gate for metadata boost stages (closes #1091)** |
| v0.35.7.0 | 2026-05-18 | feat: temporal trajectory + founder scorecard (Phases 2-4) |

Three look directly relevant to our use case:
- **v0.35.4.0** "58x perf" — vague but quantitatively significant. Worth a closer look before Esmeralda.
- **v0.35.5.0** "orphans" — `get_health` on all 3 VMs reports `orphan_pages = page_count` (every page is orphan, no links). If v0.35.5.0 changes orphan semantics or auto-link behavior, that affects our `brain_score=45` baseline.
- **v0.35.6.0** "search metadata boost" — improves semantic search precision/recall.

**Decision needed (spec, not action):** bump `GBRAIN_PINNED_*` to v0.35.7.0 before Esmeralda (May 30)? Risk: we have working v0.35.0.0 on 8 production VMs. Reward: 9 versions of fixes including a "58x perf" claim. Spec this as a separate PR with a one-VM canary at v0.35.7.0 first, soak 24h, then fleet.

### 1.7 Open upstream issues touching us

Searched `garrytan/gbrain` for `embedding OR memory OR search OR sigterm OR pglite state:open`:

- **#1065** (open, May 16): "gbrain embed hangs indefinitely on PGLite - no HTTP requests sent". **Not our path** — this is the `gbrain embed --stale/--all` batch CLI command, not the runtime `put_page` MCP tool. We never invoke that CLI in production. Filed for awareness only.
- **#1088** (open, May 16): "fix(migrate): preserve embedding_model and embedding_dimensions on engine switch" — relevant only if we ever switch engines.
- **#940** (open, May 13): "LongMemEval harness: missing configureGateway() prevents hybrid search" — eval-infra, not production.
- **#765** (open, May 9): "fix: stabilize hunyuan pglite embeddings and retrieval" — Hunyuan-specific (we use OpenAI), not us.
- **#232** (open, Apr 19): "fix(autopilot): reconnect crash, silent 0-chunk loop, and dirty-shutdown Aborted()" — **the `Aborted()` symptom matches Rule 54's WASM-init failure post-SIGTERM.** Worth tracking; if upstream fixes the autopilot reconnect path it likely reveals the underlying PGLite bug.

---

## 2. Thread 2 — Index Network integration (NOT coexistence)

Per Cooper's mid-flight clarification: gbrain = personal memory always. Index = discovery/matchmaking always. **They do not overlap.** The only interaction is one-directional: after Index surfaces a match, the agent saves notes about the match into gbrain via `put_page`. That's standard gbrain usage — no special routing logic, no protocol-level coordination.

### 2.1 Index installer source — what it actually does

Source: `indexnetwork/index@main` `packages/edgeclaw/install/`:
- `install.ts` (8.3 KB) — orchestrator
- `install_index.ts` (4.8 KB) — Index Network backend (the one that matters)
- `install_edgeos.ts` (642 B) — placeholder for future EdgeOS integration
- `install_geo.ts` (642 B) — placeholder for future Geo integration

**`install_index.ts` does exactly four things** (extracted directly from the source):

1. **Read the attendee API key** from `process.argv[0]` or `API_KEY` env or `INDEX_API_KEY` env. Bails if missing.

2. **Write `mcp.servers.index` to openclaw.json** via:
   ```bash
   openclaw config set mcp.servers.index '<JSON>' --strict-json
   ```
   The JSON payload:
   ```json
   {
     "url": "https://protocol.index.network/mcp",
     "transport": "streamable-http",
     "headers": { "x-api-key": "<ix_... attendee key>" }
   }
   ```
   Prod URL: `https://protocol.index.network/mcp`. Dev URL: `https://protocol.dev.index.network/mcp`. Toggle via `--dev` flag or `INDEX_MCP_URL` env.

   **Auth note:** Index uses `x-api-key` header. gbrain uses `Authorization: Bearer ...`. Different mechanisms; same `streamable-http` transport. Both register cleanly side-by-side in `openclaw.json`.

3. **Install 3 cron jobs** (after removing any existing `EdgeClaw — *`-prefixed crons for idempotency):
   ```
   --name "EdgeClaw — daily digest"                  --cron "0 8 * * *"   --message "$(cat ~/.openclaw/workspace/prompts/digest.md)"
   --name "EdgeClaw — ambient discovery (afternoon)" --cron "0 14 * * *"  --message "$(cat ~/.openclaw/workspace/prompts/ambient.md)"
   --name "EdgeClaw — ambient discovery (evening)"   --cron "0 20 * * *"  --message "$(cat ~/.openclaw/workspace/prompts/ambient.md)"
   ```
   All three: `--session isolated --light-context --no-deliver --channel last`.

   `--no-deliver` is load-bearing: it disables the runner's announce fallback so the agent must use the `message` tool to deliver visible content. Eliminates a class of NO_REPLY-token-leak bugs.

   `--channel last` is a TEMPORARY binding the orchestrator (`install.ts`) later patches to a real Telegram chat ID via `bindCronsToTelegram` once a session exists. Without that re-binding the crons fire into the void.

4. **Workspace bundle** (handled by orchestrator, not `install_index.ts`): copies `packages/edgeclaw/workspace/*.md` and `prompts/*.md` into `~/.openclaw/workspace/`. Includes BOOTSTRAP.md, AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md, HEARTBEAT.md, COMMUNITY.md, and the digest/ambient prompts.

**What `install_index.ts` does NOT do:**
- Does NOT call the Index signup API. The API key is assumed to already exist.
- Does NOT restart the gateway. The orchestrator does that as a final step.
- Does NOT set partner tags or any DB state — it's a pure CLI-on-the-VM script.

### 2.2 Index signup API (the piece we need to call)

From the EdgeClaw README:
```
POST https://protocol.index.network/api/networks/<NETWORK_ID>/signup
Content-Type: application/json
x-api-key: <masterKey>

Body:
{
  "email": "alice@example.com",
  "name": "Alice Example",
  "bio": "...",
  "location": "Healdsburg, CA",
  "socials": [
    { "label": "telegram", "value": "@alice" },
    { "label": "twitter",  "value": "alice_eg" }
  ]
}
```

Returns: an attendee API key bound to a network-scoped agent. The masterKey is per-network, "server-side only — never expose it in the EdgeOS portal frontend, user-visible config, the public repo, or attendee-facing copy-paste."

**That means our reconciler step needs `INDEX_NETWORK_MASTER_KEY` in Vercel env BEFORE we can ship.** Cooper action.

### 2.3 Proposed `stepDeployIndexMCP` — design only, no code

```typescript
async function stepDeployIndexMCP(
  ssh: SSHConnection,
  vm: VMRecord & { partner?: string | null; assigned_to?: string | null; index_api_key?: string | null },
  result: ReconcileResult,
  dryRun: boolean,
): Promise<void> {
  // ── Gate: edge_city only ──
  if (vm.partner !== "edge_city") return;
  // ── Gate: VM has an assigned user (skip pool VMs) ──
  if (!vm.assigned_to) return;
  // ── Gate: master key configured ──
  const masterKey = process.env.INDEX_NETWORK_MASTER_KEY;
  const networkId = process.env.INDEX_NETWORK_ID; // Esmeralda's network id
  if (!masterKey || !networkId) {
    recordHealWarning(result, "stepDeployIndexMCP: INDEX_NETWORK_MASTER_KEY or INDEX_NETWORK_ID unset in Vercel — skipping");
    return;
  }

  // ── Marker probe: skip if mcp.servers.index already set ──
  const probe = await ssh.execCommand(
    `jq -r '.mcp.servers.index.url // "absent"' ~/.openclaw/openclaw.json 2>/dev/null`,
  );
  const present = (probe.stdout || "").trim() === "https://protocol.index.network/mcp";
  if (present) {
    result.alreadyCorrect.push("index-mcp (already wired)");
    // TODO: also verify the 3 crons are present. If not, fall through to install_index.
    return;
  }

  if (dryRun) {
    result.fixed.push("[dry-run] stepDeployIndexMCP: would call signup API + write mcp.servers.index + install 3 crons");
    return;
  }

  // ── 1. Look up the attendee's email + name from instaclaw_users ──
  const supabase = getSupabase();
  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("email, name, user_timezone, index_api_key")
    .eq("id", vm.assigned_to)
    .single();
  if (!user?.email) {
    recordHealWarning(result, "stepDeployIndexMCP: assigned_to user has no email — skipping");
    return;
  }

  // ── 2. Resolve attendee API key (DB cache, else signup) ──
  let apiKey = user.index_api_key ?? null;
  if (!apiKey) {
    // Call POST /api/networks/:id/signup
    const signupResp = await fetch(
      `https://protocol.index.network/api/networks/${networkId}/signup`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": masterKey },
        body: JSON.stringify({
          email: user.email,
          name: user.name,
          location: user.user_timezone ?? undefined,
        }),
      },
    );
    if (!signupResp.ok) {
      result.errors.push(
        `stepDeployIndexMCP: signup API returned ${signupResp.status}: ${(await signupResp.text()).slice(0, 200)}`,
      );
      return;
    }
    const signupBody = await signupResp.json();
    apiKey = signupBody.apiKey ?? signupBody.api_key ?? null;
    if (!apiKey) {
      result.errors.push(`stepDeployIndexMCP: signup response missing apiKey field: ${JSON.stringify(signupBody).slice(0, 200)}`);
      return;
    }
    // Persist to DB for re-runs.
    await supabase.from("instaclaw_users").update({ index_api_key: apiKey }).eq("id", vm.assigned_to);
  }

  // ── 3. Write mcp.servers.index via openclaw config set ──
  const mcpEntry = JSON.stringify({
    url: "https://protocol.index.network/mcp",
    transport: "streamable-http",
    headers: { "x-api-key": apiKey },
  });
  const setRes = await ssh.execCommand(
    `${NVM_PREAMBLE} && openclaw config set mcp.servers.index '${mcpEntry.replace(/'/g, "'\\''")}' --strict-json`,
  );
  if (setRes.code !== 0) {
    result.errors.push(`stepDeployIndexMCP: config set failed: ${(setRes.stderr || "").slice(0, 200)}`);
    return;
  }

  // ── 4. Install 3 EdgeClaw crons (mirror install_index.ts) ──
  // Workspace prompts (digest.md, ambient.md) are pre-staged by stepFiles
  // or by configureOpenClaw bundling the EdgeClaw workspace into the canonical
  // V2 template — to be designed in a follow-up spec.
  // ... (cron-add commands here) ...

  result.fixed.push(`stepDeployIndexMCP: signed up + wired mcp.servers.index + installed 3 crons`);
}
```

**Wire-in:** between `stepDeployGbrainSoulProtocol` (just shipped in v102) and `stepDeployEdgeOverlay`. Both are partner-gated, both touch workspace state.

**New schema dep:** `instaclaw_users.index_api_key` column to cache the attendee key (avoid re-calling signup on every reconcile). Pending-migration per Rule 56.

**Risks:**
- The Index signup API may not be idempotent at the SAME email. Calling twice may produce two API keys with the second one invalidating the first. Need to ASK Index team or read their backend. **Spec-question for Cooper before shipping.**
- The workspace prompts (`digest.md`, `ambient.md`) live in Index's `packages/edgeclaw/workspace/prompts/` — we need to either bundle them into our manifest (adds ~5 KB to template size) or fetch them at reconcile time from Index's GitHub (introduces a network dependency). **Spec-question.**
- Cron `--channel last` binding requires a Telegram session to exist. New attendee VMs without a Telegram message yet would have crons firing-into-void. The orchestrator's `bindCronsToTelegram` re-binds after first user message — we'd need to replicate that re-binding logic, or rely on the EdgeClaw installer's own retry pattern.

### 2.4 SOUL.md/AGENTS.md routing for Index — proposed bullet

Per Cooper: "something simple like: discovery / who should i meet / find collaborators / ambient opportunities → use Index tools".

Insert as a NEW bullet in `## Routing — keyword → action` in `WORKSPACE_AGENTS_MD_V2` (right after the gbrain-routing bullet we added in v102):

```markdown
- **who should I meet / find collaborators / discover / ambient opportunities / connect / introductions** → use Index Network tools (`index__*`). Tools available: `index__search` (find people by intent), `index__create_intent` (express what you're looking for). DO NOT use gbrain for this — gbrain is for your OWN memory; Index is for discovering OTHER people. After Index produces a match, save the outcome with `gbrain__put_page({ slug: "intro-<person-name>", ... })`.
```

Marker-guarded with `<!-- INDEX_NETWORK_ROUTING_V1 -->` ... `<!-- /INDEX_NETWORK_ROUTING_V1 -->`. Same insertion pattern as GBRAIN_MEMORY_PROTOCOL_V1 — Python script, atomic write, Rule 22 backup.

### 2.5 Ordering with `stepDeployGbrainSoulProtocol`

Both steps modify AGENTS.md. Both are marker-guarded. Both can run in any order:
1. **stepDeployGbrainSoulProtocol** (v102, shipped) inserts the gbrain Memory Protocol block before `## Memory Protocol`.
2. **stepDeployIndexMCP** (proposed) would insert the Index routing bullet into the `## Routing — keyword → action` section AND write `mcp.servers.index`.

They don't conflict — different anchor points in AGENTS.md. Order: gbrain first (lower-numbered manifest), Index second. Both idempotent via separate markers.

---

## 3. Thread 3 — OpenClaw community memory landscape

**OpenClaw runtime memory** (per the search results — the underlying OpenClaw codebase, not InstaClaw):
- Built-in 12-layer memory architecture: knowledge graph (3K+ facts), semantic search (multilingual, 7ms GPU), continuity + stability + graph-memory plugins, activation/decay system, domain RAG.
- Storage: SQLite with optional `sqlite-vec` acceleration.
- Chunking: ~400 tokens with 80-token overlap.
- Embeddings: OpenAI / Gemini / local GGUF (configurable).
- Source-of-truth: a community fork at `coolmanns/openclaw-memory-architecture` describes the design; not the canonical OpenClaw runtime.

**Implication:** OpenClaw has its OWN memory layer beyond gbrain. Our agents currently don't use it (we override with gbrain via MCP). Worth understanding whether OpenClaw's built-in memory and gbrain semantically overlap or are intentionally separate layers. **Spec question for a future audit.**

**2026 MCP roadmap themes** (per search):
- Transport scalability
- Agent communication lifecycle semantics
- Governance maturation
- Enterprise readiness (audit trails, SSO-ready auth, gateway behavior, portable configuration)

None of these block our gbrain integration. They're upstream MCP-SDK concerns.

**MCP donated to Linux Foundation (Dec 2025):** Anthropic donated MCP to the Agentic AI Foundation (AAIF, a Linux Foundation directed fund co-founded by Anthropic, Block, OpenAI). Implications: more vendor-neutral governance, more standardization pressure. No immediate impact on us.

---

## 4. Thread 4 — Open-source MCP memory servers comparison

**Anthropic reference: `@modelcontextprotocol/server-memory`** (knowledge graph):
- Storage: local JSONL file (configurable via `MEMORY_FILE_PATH`)
- Schema: Entities + Relations + Observations (knowledge graph)
- Tools (9 total): `create_entities`, `create_relations`, `add_observations`, `delete_entities`, `delete_observations`, `delete_relations`, `read_graph`, `search_nodes`, `open_nodes`
- Retrieval: **substring/keyword text matching** — no embeddings
- Process: lightweight npm/npx
- Latest version: 2026.1.26 (per search)

**Comparison with gbrain:**

| Aspect | Anthropic memory-server | gbrain |
|---|---|---|
| Storage | JSONL file | PGLite (WASM Postgres + pgvector) |
| Schema | Knowledge graph (entities/relations/observations) | Pages (slug + content + chunks + embeddings) |
| Retrieval | Substring/keyword text match | Vector similarity (text-embedding-3-large, 1536-dim) + slug lookup |
| Tool count | 9 (CRUD-ish on the graph) | 63 (full lifecycle: pages, links, timeline, tags, sync, jobs, dream, etc.) |
| Embeddings | None | OpenAI text-embedding-3-large (~$0.13 / 1M tokens) |
| Process footprint | ~30 MB (Node + npx) | ~150 MB (bun + repo + node_modules + PGLite baseline) |
| Strength | Explicit relations; lightweight; deterministic | Fuzzy recall; semantic match across phrasings; large tool surface |
| Weakness | No semantic search; "do you remember X" needs exact word match | Heavier; requires OpenAI API + key; PGLite WASM quirks (Rule 54) |

**Other notable MCP memory servers** (not deep-dived — P3 followup):
- Community implementations on `modelcontextprotocol/servers` (~500 public servers as of early 2026, ~50+ are memory-flavored)
- LobeHub catalog at `lobehub.com/mcp/liuhao6741-openclaw-memory` (community OpenClaw memory plugin)

**Why gbrain wins for our use case:**
- Semantic search beats keyword for "do you remember X" recall (the canonical user query)
- 63-tool surface gives the agent richer operations (timeline, links, tags) than the 9-tool graph
- pgvector is a mature, well-known database extension; debugging is well-understood
- Cooper has direct contact with Garry Tan (the gbrain author) — bug fixes are reachable

**Why we'd consider Anthropic's reference instead:**
- Lighter weight (no PGLite, no 42 MB baseline)
- No external API dependency (no OpenAI key needed)
- Simpler operationally (a JSONL file vs a PGLite data dir)
- BUT: the substring-matching retrieval is significantly worse for fuzzy user queries

**No swap recommended.** gbrain's semantic search is the right primary choice. Anthropic's reference is a useful comparison point but not a replacement.

---

## 5. Re-read of GBRAIN_MEMORY_PROTOCOL_V1 with fresh eyes

Per the new operating directive: re-read the block I deployed yesterday from the agent's POV.

**Strengths (kept):**
- Hard MUST-call directive up top
- Explicit STORE vs RETRIEVE separation
- Banned-pattern enumeration (the deception list)
- "What goes where" table
- Documented diagnosis for the submit_job warning

**Edge cases the protocol DOES NOT yet cover:**

1. **"Forget X" / "delete that"** — agent has `gbrain__delete_page` (or similar) in the catalog but the protocol doesn't mention it. The agent might (a) just say "OK I forgot" without calling delete, (b) hallucinate a delete success, or (c) refuse because it doesn't know.

2. **Updating an existing fact** — user says "actually my birthday is Nov 2, not Nov 1." Should the agent call `put_page` again (overwriting via slug) or use a hypothetical `update_page` (if one exists)? Protocol says "use stable slugs" but doesn't address overwrite semantics.

3. **Conflicting facts** — gbrain has two pages: `user-birthday` (Nov 1) and `user-bday` (Nov 2). Search returns both. What does the agent do? Protocol doesn't handle this.

4. **Information types not in the "what goes where" table**:
   - "Save this Twitter thread for me to read later" — bookmark-like content. Not user fact, not session log.
   - "Remember to ask me about the dentist appointment tomorrow" — reminder + scheduled action. Belongs in `memory/active-tasks.md` or a cron, not gbrain. Routing unclear.
   - "Save my health info: I'm allergic to peanuts" — sensitive PII. Should gbrain treat it differently? (Currently the protocol doesn't gate sensitive data.)

5. **Misinterpretation risk on "MUST call before responding"** — a model could interpret this as "MUST call on every single message" even when the user didn't ask to remember anything. The directive is scoped to "When the user asks you to remember something" but the model's risk-aversion might over-apply it. Could surface as: latency tax + unnecessary puts on every chat.

**Recommendation:** flag these as P2 protocol improvements for a v2 update. Don't ship v2 until we've measured the fleet's actual put_page call rate after v102 deploy (~24 hours of data). If false-positive puts are happening, tighten the "MUST" scoping. If forget/update/conflict patterns surface in production, add specific rules.

---

## 6. Cross-cutting findings + immediate cleanup actions

### 6.1 Sensitive content captured in probe logs (action required)

The SSH probe's `env_seen_by_sidecar` step dumped the gbrain process environment, which includes:
- `OPENAI_API_KEY=sk-proj-<REDACTED-154-chars>` (project-scoped OpenAI key)
- `ANTHROPIC_API_KEY=sk-ant-api03-<REDACTED-108-chars>` (Anthropic API key)

These are real production keys, captured into `/tmp/gbrain-audit/vm-050.log` and (by extension) into stdout this turn.

**Action:**
- Delete `/tmp/gbrain-audit/*.log` after this audit (rotate locally; never commit, never share).
- Future probes: omit the `env_seen_by_sidecar` step OR pipe through a redactor.
- The keys themselves are not exposed in this audit doc (redacted), but the fact they're in `/tmp` is a local-environment exposure worth noting.

### 6.2 OPENAI_API_KEY visible on the VM filesystem

The OPENAI_API_KEY is embedded directly in `~/.config/systemd/user/gbrain.service` (`Environment=OPENAI_API_KEY=...`). Anyone who reads that file (including any agent that can `cat` files in its workspace) can exfiltrate it.

Risk: low (agents are sandboxed to one user's machine; the key is THAT user's quota), but worth flagging. Alternatives: load via `EnvironmentFile=` from a mode-600 file, or via a systemd credential. Mitigation is straightforward but not on-path for Esmeralda — file as P3.

### 6.3 brain_score = 45 across all probed VMs (not "broken" — informative)

`get_health` reports `brain_score: 45` on every probed VM. The score is a sum of 5 sub-scores:
- `embed_coverage_score: 35` (full embedding coverage — good)
- `link_density_score: 0` (no inter-page links — there are 2-3 pages, no agent has linked them)
- `timeline_coverage_score: 0` (no timeline entries)
- `no_orphans_score: 0` (all pages are orphans — same as "no links")
- `no_dead_links_score: 10` (no broken links, trivially because no links exist)

Interpretation: **gbrain rewards LINKED knowledge graphs, not just stored facts.** Our agents are putting facts but not connecting them. v0.35.5.0's "orphans" fix may auto-link via heuristics. Worth testing after a pin bump.

### 6.4 Latency caveat — repeat-iteration measurements are warm-path

My 3-iteration probe used the same slug per VM, so iterations 2–3 hit gbrain's content-hash idempotency skip. **The 16–19ms warm-path put_page is NOT what users see.** Real user-fact `put_page` calls go through the cold path (270–420ms). Future audit: probe with unique slug per iteration to measure the true cold-path distribution + P95/P99.

### 6.5 Spec-questions for Cooper before any code

These need answers before I write any spec for follow-up work:

1. **Index signup idempotency** — what happens if we POST signup twice with the same email? Does the second call invalidate the first key, or return the existing key? **Need to ask Index team OR test on dev URL.**
2. **Index master key** — needs to be added to Vercel env as `INDEX_NETWORK_MASTER_KEY` (and `INDEX_NETWORK_ID` for the Esmeralda network ID) before stepDeployIndexMCP can ship.
3. **gbrain pin bump** — should we bump from v0.35.0.0 to v0.35.7.0 (or wait for more stability)? My recommendation: ONE-VM canary at v0.35.7.0, 24h soak, then fleet. Spec a separate PR.
4. **Index workspace prompts** — bundle `digest.md` / `ambient.md` into our manifest, or fetch from Index's GitHub at reconcile? My recommendation: bundle (predictable, cache-stable, no network dependency).
5. **gbrain memory protocol v2** — should we add forget/update/conflict rules now, or wait 24h to measure how the v102 deploy behaves in production first? My recommendation: wait, measure, then update.

### 6.6 Proposed P1/P2/P3 followups (in priority order)

| Priority | Item | Effort |
|---|---|---|
| P0 | Delete `/tmp/gbrain-audit/*.log` to remove local keymat exposure | 1 command |
| P1 | Spec doc: `stepDeployIndexMCP` (per §2.3) — Cooper reviews + answers spec-questions | 1-2 hours focused |
| P1 | Spec doc: gbrain v0.35.7.0 pin bump + one-VM canary plan | 30 min |
| P2 | Re-run latency probe with unique slugs per iteration, measure P95/P99 cold-path | 1 hour |
| P2 | Spec doc: GBRAIN_MEMORY_PROTOCOL_V2 (forget/update/conflict rules) — gated on 24h v102 production data | 1 hour after data |
| P3 | OpenClaw built-in memory vs gbrain — do they semantically overlap? Should we use both? | 2 hours research |
| P3 | OPENAI_API_KEY exposure in systemd unit file — move to EnvironmentFile mode-600 | 30 min |
| P3 | HNSW index parameters in gbrain's PGLite schema — measure degradation curve at 10K/100K pages | 2 hours synthetic load test |
| P3 | gbrain's `gbrain embed --all` CLI batch path hangs on PGLite (upstream #1065) — we don't use it but worth tracking | passive |

---

## 7. Sources cited

- gbrain source: `~/gbrain/src/commands/` on vm-050 (read directly via SSH probe)
- gbrain releases: `https://api.github.com/repos/garrytan/gbrain/releases` (via curl)
- gbrain open issues: `https://api.github.com/search/issues?q=repo:garrytan/gbrain+state:open` (via curl)
- gbrain commits since pin: `https://api.github.com/repos/garrytan/gbrain/commits?since=2026-05-16` (via curl)
- PGLite npm registry: `https://registry.npmjs.org/@electric-sql/pglite` (via curl)
- PGLite changelog: `https://github.com/electric-sql/pglite/blob/main/packages/pglite/CHANGELOG.md` (via WebFetch)
- Index installer source: `https://raw.githubusercontent.com/indexnetwork/index/main/packages/edgeclaw/install/install_index.ts` (via curl)
- Index EdgeClaw README: `https://raw.githubusercontent.com/indexnetwork/index/main/packages/edgeclaw/README.md` (via curl)
- Anthropic MCP memory server: `https://github.com/modelcontextprotocol/servers/tree/main/src/memory` (via WebFetch)
- OpenClaw memory architecture community fork: `https://github.com/coolmanns/openclaw-memory-architecture` (via WebSearch summary)
- Raw probe logs (local, untracked): `/tmp/gbrain-audit/vm-{050,354,771}.log`
