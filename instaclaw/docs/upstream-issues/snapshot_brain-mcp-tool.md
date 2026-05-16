# [Feature request] Expose `engine.db.dumpDataDir()` as an MCP tool: `snapshot_brain`

**Target repo:** `garrytan/gbrain`
**Status:** Draft — awaiting Cooper review before filing on GitHub.
**Authored:** 2026-05-16 by Claude Opus 4.7 (1M context), agent operating the InstaClaw fleet.
**Pinned upstream version at time of writing:** v0.35.0.0 (commit `baf1a47`).

---

## TL;DR

PGLite's `engine.db.dumpDataDir("gzip")` already produces hot, consistent snapshots of a running gbrain's data dir. Your repo already uses this in `scripts/build-pglite-snapshot.ts:53` to produce test fixtures. **Please expose the same primitive as an authenticated MCP tool named `snapshot_brain` on the running gbrain server**, so downstream consumers can take backups without stopping the service. Without this, gbrain is unbackable in production — and the obvious workaround (`systemctl stop` then `tar`) corrupts PGLite v0.35.0.0 data dirs.

Estimated upstream effort: ~30 lines in the MCP tool registration table. We're happy to submit a PR if helpful.

---

## Background

We run gbrain v0.35.0.0 as a per-VM HTTP sidecar on ~200 production VMs (InstaClaw's agent fleet — `instaclaw.io`). Each VM gbrain holds 5-50 MB of customer memory (Anthropic-summarized facts about the user, with `text-embedding-3-large` embeddings). Losing this data is **catastrophic from the user's perspective** — the whole product premise is that the agent remembers them.

Two operational classes require taking a snapshot of a running gbrain:

1. **Periodic archival to cold storage.** We freeze VMs whose owners cancel their subscription (cost optimization). When they reactivate weeks/months later, we restore from the archive. Customer must get their memory back.

2. **In-place version upgrades.** When we bump `gbrain` from v0.35.0.0 to (eventually) v0.36 / v1.0 / etc., we need to capture the current state, run any necessary migration, and restore. PGLite schema migrations may run on the restored data. The alternative — wipe-and-reinit on every upgrade — discards customer memory.

Other gbrain users running gbrain as a service will hit the same requirement once their brains accumulate non-trivial data.

## The 2026-05-16 PGLite SIGTERM bug

We discovered (empirically on vm-050) that **systemd's SIGTERM-mediated graceful shutdown corrupts the PGLite v0.35.0.0 data dir.** Reload after SIGTERM produces:

```
PGLite failed to initialize its WASM runtime / Aborted()
```

`gbrain serve`'s `beginShutdown` handler in `serve.ts` is logically correct (registers SIGTERM → `engine.disconnect()` → `db.close()` → `releaseLock()` → `process.exit(0)`). The bug is inside PGLite's `db.close()`: it writes something during close that the next WASM init can't reload. Counterintuitively, **SIGKILL produces RECOVERABLE state** — the WAL replays cleanly on next boot because the corrupting write never lands.

So the obvious "stop-and-tar" backup pattern is broken:
- `systemctl stop gbrain` (sends SIGTERM via the default `KillSignal=SIGTERM`) → corrupts data dir, every subsequent restart fails.
- `pkill -KILL` (SIGKILL) before tar → works, but requires service interruption + risks losing in-flight writes if any are pending.

The native `engine.db.dumpDataDir()` sidesteps the bug entirely because the engine **stays running** — `dumpDataDir` reads from the engine's WAL-aware consistent view without ever entering the broken `db.close()` path.

This is a separate upstream issue we may file (PGLite's `db.close()` corruption), but `snapshot_brain` is the path forward regardless.

---

## Use cases (downstream-agnostic, beyond InstaClaw)

1. **Periodic cold-storage backup.** Anyone running gbrain as a service needs scheduled backups. Today there is no path that doesn't risk corruption.
2. **Version upgrade migrations.** Same shape as #1 but the destination is a fresh gbrain at the new version, not cold storage.
3. **Cross-machine brain transfer.** "Move my gbrain from machine A to machine B" — currently impossible without stopping.
4. **GDPR / Article 20 data portability.** When a user asks for an export, you need a way to capture their PGLite state.
5. **Forensic capture.** Security or engineering wants a frozen snapshot of a misbehaving brain for triage.
6. **Pre-destructive-op safety net.** Before any operator-driven schema change or risky migration, take a known-good snapshot.

Cases 1, 2, and 4 are immediate hard-blockers for InstaClaw — we cannot ship our freeze/thaw archival system without this tool. Other cases benefit any production gbrain deployment.

---

## Proposed API contract

### Tool name: `snapshot_brain`

Mirrors the existing MCP tool registration pattern. Bearer-token auth via the existing middleware — no new auth surface.

### Input

```jsonc
{
  "name": "snapshot_brain",
  "arguments": {
    "compression": "gzip"   // optional; "none" | "gzip" | "auto"; default = "gzip"
  }
}
```

`compression` is forwarded directly to PGLite's `dumpDataDir`:
- `"gzip"` — gzipped tar of the data dir (typical 5-50 MB output).
- `"none"` — raw tar (10-100 MB output; useful for callers that want their own compression).
- `"auto"` — let PGLite decide (currently equivalent to gzip).

### Output

MCP tool response with a single `resource` content block carrying the base64-encoded blob. Example response shape:

```jsonc
{
  "content": [
    {
      "type": "resource",
      "mimeType": "application/gzip",
      "blob": "<base64-encoded gzipped tar of the data dir>"
    }
  ]
}
```

Base64 overhead (~33%) is trivial at our typical brain size (5-50 MB raw → 7-67 MB transit). For very large brains an admin HTTP endpoint that streams gzip directly would be more efficient, but we'd accept the base64 overhead as the price of staying within the MCP tool surface.

If MCP's content-block schema doesn't currently support binary resources cleanly, an alternative response shape is acceptable:

```jsonc
{
  "content": [
    {
      "type": "text",
      "text": "{\"path\": \"/tmp/brain-snapshot.tar.gz\", \"size_bytes\": 5242880, \"sha256\": \"...\", \"page_count\": 1234, \"schema_version\": 66, \"compression\": \"gzip\", \"duration_ms\": 850, \"gbrain_version\": \"0.35.0.0\"}"
    }
  ]
}
```

Side effect: writes the snapshot to a sidecar-managed temp path (e.g., `~/.gbrain/snapshots/<unix-ts>-<sha256-prefix>.tar.gz`). The caller reads the file via the same filesystem the sidecar runs on (we're already SSHing in for the operational orchestration).

We'd be happy with either shape. The inline-base64 shape is preferred because it doesn't require coordination with filesystem cleanup; the on-disk shape is preferred if you don't want to encode multi-MB blobs in MCP responses.

### Error shape

Standard MCP `isError: true` with a human-readable message in the text block. Failure scenarios we'd expect to handle:

- Engine busy / lock contention → retryable
- Disk full (if writing to disk) → non-retryable until cleanup
- PGLite internal error (rare; should not happen) → non-retryable; alerts operator

---

## Behavioral semantics

These should be documented in the tool's description so callers can reason about it correctly:

- **Hot snapshot, no service interruption.** The engine continues serving `put_page` / `get_page` / etc. throughout. New writes that land mid-snapshot are NOT guaranteed to be in the output — `dumpDataDir` captures a consistent point-in-time view from PGLite's WAL.
- **Idempotent — but every call produces a fresh snapshot.** No caching, no incremental snapshots. (Incremental would be a nice future enhancement but not required for v1.)
- **Bearer-token auth, same as `put_page`.** Callers must hold the bearer for the brain they want to snapshot. There is no admin override that lets one brain snapshot another.
- **No size cap from gbrain's side.** PGLite's `dumpDataDir` can produce arbitrarily large output. Operational rate-limiting is the caller's responsibility.
- **Stable output format.** A snapshot produced by gbrain v0.35.0.0 must be loadable by gbrain v0.35.0.0 (round-trip property). Cross-version restore semantics (e.g., snapshot at v0.35 → restore at v0.36 with schema migration) is a future PRD on the caller side.

---

## Why an MCP tool (not a bin command, not an admin HTTP endpoint)

We considered three alternative implementations:

1. **`gbrain snapshot` CLI command.** Would work but:
   - Requires the caller to have shell access. Our orchestrator runs over MCP HTTP from a Vercel cron — no SSH needed for the tool call itself (only for SCP-ing the result back, if on-disk).
   - Bypasses the bearer-auth surface; CLI invocations have no auth gating beyond filesystem permissions.
   - Programmatic callers need to parse stdout instead of reading a JSON response.
   - Couldn't compose with the existing tool-registration table.

2. **Bare `/admin/snapshot.tar.gz` HTTP endpoint.** Would work but:
   - Introduces a new HTTP route shape outside the existing MCP surface.
   - Requires new auth middleware specifically for admin endpoints (or duplicates the existing bearer-check logic).
   - We'd accept it as a fallback, but the MCP tool approach has stricter consistency with the rest of the API.

3. **MCP tool `snapshot_brain` (this proposal).** Wins because:
   - Uses the existing tool-registration pattern (no new abstractions).
   - Uses the existing bearer-token middleware (no new auth surface).
   - Plays nicely with MCP-aware tooling (Claude / OpenAI agents / other consumers can invoke it the same way they invoke `put_page`).
   - Trivially composable — a follow-up `restore_brain` tool could fit the same pattern (though restore is harder; see below).

---

## What this issue does NOT propose

To keep scope tight:

- **No `restore_brain` MCP tool.** Restore can't really happen from inside the running sidecar (it would have to wipe its own data dir and reinit). The restore flow is best handled by external orchestration: stop gbrain (SIGKILL — see PGLite bug above), extract tarball into the data dir, start gbrain. That's the path we'll use, gated only on the existence of `snapshot_brain`.
- **No cross-version migration logic.** A v0.35 snapshot loaded into a v0.36 server with schema v67 (vs v66) is the caller's problem. PGLite's own schema-migration tooling handles the reload.
- **No incremental / delta snapshots.** Full snapshots only for v1. We can revisit if brain sizes grow past 100 MB and full snapshots become slow.
- **No streaming.** The blob is materialized fully in the response (or on disk) before the tool returns. Streaming would be a future enhancement.

---

## Implementation sketch (~30 lines)

Reference implementation (TypeScript, mirroring your existing tool registration patterns):

```typescript
// src/mcp/tools/snapshot-brain.ts (or wherever your tool registrations live)
import type { ToolDefinition, ToolContext } from "../types";

export const snapshotBrainTool: ToolDefinition = {
  name: "snapshot_brain",
  description:
    "Hot snapshot of the PGLite data dir. Returns base64-encoded gzipped " +
    "tar of the data dir. No service interruption — uses PGLite's native " +
    "dumpDataDir() against the running engine. Bearer-token auth (same as " +
    "put_page). See: https://github.com/electric-sql/pglite for dumpDataDir " +
    "semantics.",
  inputSchema: {
    type: "object",
    properties: {
      compression: {
        type: "string",
        enum: ["none", "gzip", "auto"],
        default: "gzip",
        description: "Forwarded to PGLite dumpDataDir(). Default gzip.",
      },
    },
  },
  handler: async (args: { compression?: "none" | "gzip" | "auto" }, ctx: ToolContext) => {
    const startMs = Date.now();
    const compression = args.compression ?? "gzip";
    const dump: Blob = await ctx.engine.db.dumpDataDir(compression);
    const buffer = Buffer.from(await dump.arrayBuffer());
    const durationMs = Date.now() - startMs;
    return {
      content: [
        {
          type: "resource",
          mimeType: compression === "none" ? "application/x-tar" : "application/gzip",
          blob: buffer.toString("base64"),
        },
        // Bonus: include a sibling text block with stats so callers don't have
        // to compute sha256 / size themselves. Optional — could be dropped.
        {
          type: "text",
          text: JSON.stringify({
            size_bytes: buffer.length,
            duration_ms: durationMs,
            compression,
            // sha256 can be added if cheap to compute synchronously here.
          }),
        },
      ],
    };
  },
};
```

Tool registration (in whatever your tool-registration table is):

```typescript
import { snapshotBrainTool } from "./mcp/tools/snapshot-brain";

const tools = {
  // ... existing tools ...
  [snapshotBrainTool.name]: snapshotBrainTool,
};
```

That's it. The existing bearer-auth middleware on `tools/call` handles auth. The existing serializer handles the response shape (assuming MCP resources work as I've described — please correct me if not).

---

## Testing

A round-trip test would establish the contract:

1. Start a gbrain server with seed data (a few `put_page` calls).
2. Call `snapshot_brain` over the MCP endpoint.
3. Receive the base64 blob; decode + write to disk as `brain.pglite.tar.gz`.
4. SIGKILL the server (no SIGTERM, per the PGLite bug — see Background).
5. `rm -rf ~/.gbrain/brain.pglite/`.
6. `tar xzf brain.pglite.tar.gz -C ~/.gbrain/`.
7. Restart the gbrain server.
8. Verify the seeded pages are retrievable via `get_page`.

Happy to write this test in our repo if it would help, though it more naturally fits in gbrain's own test suite.

---

## Why this matters / urgency

- **InstaClaw freeze-v2 archival is blocked on this tool.** Without `snapshot_brain` we cannot ship the freeze flow that recovers ~$1,450/mo of cost (50+ VMs we currently can't safely archive). Detailed in our internal PRD `freeze-thaw-v2-archive-based.md`.
- **Esmeralda conference (Edge City partner, May 30 - June 13)** brings 200+ active agents — backups become a P0 requirement before then.
- **PGLite v0.35.0.0 SIGTERM bug** makes the obvious alternative (stop-and-tar) unsafe. Without `snapshot_brain`, gbrain has no production-safe backup path at all.

If gbrain prefers to ship a CLI command or HTTP endpoint instead of an MCP tool, we'd accept that. The MCP-tool shape is our preference but the underlying need is "any safe hot-snapshot path."

---

## References

- PGLite `dumpDataDir` semantics — https://github.com/electric-sql/pglite (search the README and source for `dumpDataDir`).
- Existing usage in gbrain — `scripts/build-pglite-snapshot.ts:53` (uses the same primitive to build test fixtures).
- PGLite SIGTERM corruption bug — empirically verified by us on vm-050 on 2026-05-16. We're happy to share the WASM crash log if useful for a separate PGLite-side issue.
- gbrain HTTP sidecar architecture (downstream context) — InstaClaw runs gbrain as a per-VM systemd `--user` service bound to `127.0.0.1:3131` with Bearer auth on `/mcp`. v0.35.0.0 was the first version we adopted; we previously ran v0.28.1 via the legacy stdio per-session-spawn architecture and migrated for cold-start performance.
- Token mint workaround we currently use — `auth.ts`'s bare `postgres()` client fails on PGLite (uses `engine.executeRaw` in `oauth-provider.ts` instead). This is a separate upstream issue we may file.

---

## Acknowledgments

Thanks for building gbrain — it's the spine of how we give our agents long-term memory, and we deeply appreciate the design choice to keep PGLite local-first. We're happy to:

- Submit a PR with the tool implementation as sketched above
- Write the round-trip test
- Test the upstream change on a real fleet VM before you merge

— Cooper Wrenn (`coopergwrenn`), InstaClaw / Clawlancer
