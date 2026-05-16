/**
 * vm-archive-snapshot — freeze-v2 Phase 2 archive cron (PRD §15.5).
 *
 * Schedule: 0 *\/6 * * * (every 6h). NOT yet in vercel.json — the gbrain
 * `snapshot_brain` MCP tool that callSnapshotBrain() depends on hasn't
 * shipped yet. Once gbrain terminal lands that tool:
 *   1. Remove the STUB short-circuit in callSnapshotBrain()
 *   2. Add the cron entry to vercel.json
 *   3. Run on one canary VM first; then enable fleet-wide.
 *
 * Flow per VM:
 *   1. Lock-acquire freeze-thaw:<vm-id> (30 min TTL)
 *   2. Set freeze_state = 'archiving'
 *   3. SSH to VM
 *   4. callSnapshotBrain() → gzipped tar of PGLite data dir [STUBBED]
 *   5. tar the user-state files (workspace, sessions, .env, wallet, etc.)
 *   6. Combine into outer tar with manifest.json
 *   7. scp outer tar to cron /tmp
 *   8. Encrypt (AES-256-GCM, key_id from FREEZE_ARCHIVE_KEY_CURRENT)
 *   9. Upload to R2 at <vm-id>/<unix-ts>-<sha256-prefix>.tar.enc
 *  10. DB write: frozen_archive_path / sha256 / size_kb / manifest /
 *      taken_at / freeze_state='archived'
 *  11. Retention sweep — keep last 3 per VM in R2
 *  12. Release lock
 *
 * Failure semantics (PRD §15.8):
 *   - Any failure leaves the VM running (no destructive op). Freeze-v2
 *     archive failures NEVER produce zombies — distinguish from the
 *     v1 Linode-image freeze which could.
 *   - On error: set freeze_state back to 'archive_pending', release lock,
 *     log via lifecycle log. Next cron tick retries.
 *
 * Authorization: Bearer CRON_SECRET (Vercel cron pattern, same as
 * cron/vm-lifecycle).
 *
 * See also:
 *   - PRD instaclaw/docs/prd/freeze-thaw-v2-archive-based.md §15
 *   - CLAUDE.md "Freeze pipeline — ARCHITECTURE PIVOT 2026-05-16"
 *   - Rule 53 (encryption mandatory), Rule 54 (never systemctl stop gbrain)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { connectSSH } from "@/lib/ssh";
import { logger } from "@/lib/logger";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { encrypt, getCurrentKeyId } from "@/lib/freeze-encryption";
import { putObject, listObjectsByPrefix, deleteObject } from "@/lib/r2-storage";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
// Worst case: 5 VMs × (SSH connect ~2s + dumpDataDir ~10s + user-state tar ~5s
// + scp ~5s + encrypt ~3s + upload ~10s + DB writes ~1s) ≈ 36s per VM = 180s.
// 300s gives ample margin for slower networks / larger archives.
export const maxDuration = 300;

// ─── Tunables (PRD §15.5) ────────────────────────────────────────────────

/** Per-cron-run cap on archive operations. Conservative to start — gbrain
 *  snapshot_brain may have unknown cost per call; scale up after observing. */
const MAX_ARCHIVES_PER_RUN = 5;

/** Cron-level lock TTL. 30 min comfortably covers the worst-case wall-clock
 *  per archive (~36s) × MAX_ARCHIVES_PER_RUN, plus headroom. */
const CRON_LOCK_TTL_SECONDS = 30 * 60;

/** Per-VM lock TTL. Same shape, narrower scope. */
const PER_VM_LOCK_TTL_SECONDS = 30 * 60;

/** Archives older than this trigger a fresh snapshot. 24h matches the
 *  candidate-query filter in §15.5; freeze (§15.6) refuses to destroy if
 *  archive is >48h, so 24h freshness gives 24h cushion for freeze. */
const ARCHIVE_FRESHNESS_HOURS = 24;

/** Hard cap on encrypted archive size. Anything larger → alert + skip
 *  (gbrain probably has runaway page accumulation; investigate manually). */
const ARCHIVE_MAX_BYTES = 200 * 1024 * 1024;

/** Number of generations kept per VM in R2 after retention sweep. */
const RETENTION_GENERATIONS = 3;

/** Bearer token file inside the VM (set by install-gbrain.sh). */
const GBRAIN_TOKEN_PATH = "~/.gbrain/openclaw-bearer-token.txt";

/** gbrain HTTP endpoint inside the VM (loopback only, per Rule 35). */
const GBRAIN_LOOPBACK = "localhost:3131";

// ─── Types ───────────────────────────────────────────────────────────────

interface ArchiveCandidate {
  id: string;
  name: string | null;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  assigned_to: string | null;
  health_status: string | null;
  status: string | null;
  freeze_state: string | null;
  frozen_archive_path: string | null;
  frozen_archive_taken_at: string | null;
}

interface ArchiveResult {
  vm_id: string;
  vm_name: string | null;
  outcome:
    | "archived"
    | "skipped_recent"
    | "skipped_lock"
    | "snapshot_failed"
    | "user_state_failed"
    | "encrypt_failed"
    | "upload_failed"
    | "db_write_failed"
    | "size_exceeded"
    | "ssh_failed"
    | "error";
  detail: string;
  archive_path?: string;
  size_bytes?: number;
  duration_ms?: number;
}

interface RunSummary {
  run_id: string;
  attempted: number;
  archived: number;
  skipped: number;
  failed: number;
  duration_ms: number;
  results: ArchiveResult[];
  note?: string;
}

// ─── Route handler ───────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  // Vercel cron auth — same pattern as cron/vm-lifecycle.
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runId = randomUUID();
  const tStart = Date.now();
  const supabase = getSupabase();

  // Outer cron-level lock so two concurrent cron firings can't double-process.
  const cronLock = await tryAcquireCronLock(
    "vm-archive-snapshot",
    CRON_LOCK_TTL_SECONDS,
    "vercel-cron",
  );
  if (!cronLock) {
    logger.info("vm-archive-snapshot: outer cron lock busy; skipping run", { runId });
    return NextResponse.json({
      run_id: runId,
      attempted: 0,
      archived: 0,
      skipped: 0,
      failed: 0,
      duration_ms: 0,
      results: [],
      note: "outer cron lock busy",
    } satisfies RunSummary);
  }

  const summary: RunSummary = {
    run_id: runId,
    attempted: 0,
    archived: 0,
    skipped: 0,
    failed: 0,
    duration_ms: 0,
    results: [],
  };

  try {
    // ── Find candidates ──
    //
    // Eligible: status=assigned, health IN (suspended, hibernating),
    // freeze_state IS NULL or IN ('archive_pending', 'archived'),
    // archive missing OR taken_at older than ARCHIVE_FRESHNESS_HOURS.
    //
    // Order by taken_at ASC nulls first so VMs with no archive get prioritized,
    // then oldest archives next. Prevents starvation of fresh-suspended VMs by
    // a backlog of recent re-archives.
    const freshnessCutoff = new Date(
      Date.now() - ARCHIVE_FRESHNESS_HOURS * 60 * 60 * 1000,
    ).toISOString();

    const { data: candidates, error: queryErr } = await supabase
      .from("instaclaw_vms")
      .select(
        "id, name, ip_address, ssh_port, ssh_user, assigned_to, health_status, status, freeze_state, frozen_archive_path, frozen_archive_taken_at",
      )
      .in("health_status", ["suspended", "hibernating"])
      .eq("status", "assigned")
      .not("provider_server_id", "is", null)
      // Either no archive yet OR stale archive.
      .or(`frozen_archive_taken_at.is.null,frozen_archive_taken_at.lt.${freshnessCutoff}`)
      // Don't pick VMs that are mid-freeze or mid-thaw — only idle ones, or
      // ones explicitly in archive_pending/archived where we know freeze
      // hasn't started yet.
      .or("freeze_state.is.null,freeze_state.eq.archive_pending,freeze_state.eq.archived")
      .order("frozen_archive_taken_at", { ascending: true, nullsFirst: true })
      .limit(MAX_ARCHIVES_PER_RUN * 3); // grab extra; some may be skipped by lock

    if (queryErr) {
      logger.error("vm-archive-snapshot: candidate query failed", {
        runId,
        error: queryErr.message,
      });
      throw queryErr;
    }

    logger.info("vm-archive-snapshot: candidates", {
      runId,
      count: candidates?.length ?? 0,
      max_per_run: MAX_ARCHIVES_PER_RUN,
    });

    // ── Process up to MAX_ARCHIVES_PER_RUN VMs ──
    let processed = 0;
    for (const vm of (candidates ?? []) as ArchiveCandidate[]) {
      if (processed >= MAX_ARCHIVES_PER_RUN) break;
      summary.attempted++;

      const tVm = Date.now();
      const result = await archiveOne(supabase, vm, runId);
      result.duration_ms = Date.now() - tVm;
      summary.results.push(result);

      if (result.outcome === "archived") {
        summary.archived++;
        processed++;
      } else if (
        result.outcome === "skipped_recent" ||
        result.outcome === "skipped_lock"
      ) {
        summary.skipped++;
      } else {
        summary.failed++;
        // Failed attempts also count toward the per-run cap — don't try to
        // grind through 100 VMs when something's structurally wrong.
        processed++;
      }
    }

    summary.duration_ms = Date.now() - tStart;
    logger.info("vm-archive-snapshot: run complete", { runId, ...summary });
    return NextResponse.json(summary);
  } catch (err) {
    logger.error("vm-archive-snapshot: run threw", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    summary.duration_ms = Date.now() - tStart;
    return NextResponse.json(
      { ...summary, fatal: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    await releaseCronLock("vm-archive-snapshot");
  }
}

// ─── Per-VM archive flow ─────────────────────────────────────────────────

async function archiveOne(
  supabase: ReturnType<typeof getSupabase>,
  vm: ArchiveCandidate,
  runId: string,
): Promise<ArchiveResult> {
  const base: Pick<ArchiveResult, "vm_id" | "vm_name"> = {
    vm_id: vm.id,
    vm_name: vm.name,
  };
  const lockKey = `freeze-thaw:${vm.id}`;

  // Per-VM lock. If busy, freeze cron or thaw cron is mid-op — skip cleanly.
  const acquired = await tryAcquireCronLock(
    lockKey,
    PER_VM_LOCK_TTL_SECONDS,
    `vm-archive-snapshot/${runId}`,
  );
  if (!acquired) {
    return {
      ...base,
      outcome: "skipped_lock",
      detail: `another freeze-thaw op holds ${lockKey}`,
    };
  }

  let ssh: Awaited<ReturnType<typeof connectSSH>> | null = null;
  try {
    // Mark state — transition idle/archive_pending/archived → archiving
    {
      const { error } = await supabase
        .from("instaclaw_vms")
        .update({ freeze_state: "archiving" })
        .eq("id", vm.id);
      if (error) {
        return {
          ...base,
          outcome: "db_write_failed",
          detail: `freeze_state='archiving' set failed: ${error.message}`,
        };
      }
    }

    // SSH connect
    try {
      ssh = await connectSSH({
        id: vm.id,
        ip_address: vm.ip_address,
        ssh_port: vm.ssh_port,
        ssh_user: vm.ssh_user,
      });
    } catch (err) {
      await markPending(supabase, vm.id);
      return {
        ...base,
        outcome: "ssh_failed",
        detail: `connect failed: ${truncate(err)}`,
      };
    }

    // 1. PGLite hot snapshot via gbrain MCP — STUBBED until snapshot_brain ships.
    const tSnap = Date.now();
    let brainTarGz: Buffer;
    try {
      brainTarGz = await callSnapshotBrain(ssh, vm);
    } catch (err) {
      await markPending(supabase, vm.id);
      return {
        ...base,
        outcome: "snapshot_failed",
        detail: `gbrain snapshot_brain failed (${Date.now() - tSnap}ms): ${truncate(err)}`,
      };
    }

    // 2. User-state tarball (workspace, sessions, .env, wallet, etc.) via remote tar.
    let userStateTarGz: Buffer;
    try {
      userStateTarGz = await snapshotUserState(ssh, vm, runId);
    } catch (err) {
      await markPending(supabase, vm.id);
      return {
        ...base,
        outcome: "user_state_failed",
        detail: `user-state tar failed: ${truncate(err)}`,
      };
    }

    // 3. Manifest.json (records what's in the archive + integrity sha256s).
    const brainSha = sha256(brainTarGz);
    const userSha = sha256(userStateTarGz);
    const manifestObj = {
      schema_version: "1",
      vm_id: vm.id,
      vm_name: vm.name,
      user_id: vm.assigned_to,
      generated_at: new Date().toISOString(),
      source_manifest_version: null, // populated once we wire to VM_MANIFEST.version snapshot
      encryption_key_id: getCurrentKeyId(),
      inner: {
        brain_pglite_sha256: brainSha,
        brain_pglite_size_bytes: brainTarGz.length,
        user_state_sha256: userSha,
        user_state_size_bytes: userStateTarGz.length,
      },
      run_id: runId,
    };
    const manifestBuf = Buffer.from(JSON.stringify(manifestObj, null, 2), "utf-8");

    // 4. Combine into outer tar.
    // Build tar in memory using a minimal pure-Node implementation — avoids
    // adding a 'tar' dep. The wire format is the same standard ustar that
    // any `tar -tf` can list.
    const outerTar = buildOuterTar([
      { name: "manifest.json", buffer: manifestBuf },
      { name: "brain.pglite.tar.gz", buffer: brainTarGz },
      { name: "user-state.tar.gz", buffer: userStateTarGz },
    ]);

    // Size gate — defense against runaway page accumulation.
    if (outerTar.length > ARCHIVE_MAX_BYTES) {
      await markPending(supabase, vm.id);
      return {
        ...base,
        outcome: "size_exceeded",
        detail: `outer tar ${outerTar.length} bytes exceeds cap ${ARCHIVE_MAX_BYTES}; investigate gbrain page growth`,
      };
    }

    // 5. Encrypt.
    let ciphertext: Buffer;
    let keyId: string;
    try {
      const enc = encrypt(outerTar);
      ciphertext = enc.ciphertext;
      keyId = enc.keyId;
    } catch (err) {
      await markPending(supabase, vm.id);
      return {
        ...base,
        outcome: "encrypt_failed",
        detail: truncate(err),
      };
    }

    const outerSha = sha256(ciphertext);
    const archiveKey = `${vm.id}/${Math.floor(Date.now() / 1000)}-${outerSha.slice(0, 8)}.tar.enc`;

    // 6. Upload to R2.
    try {
      await putObject(archiveKey, ciphertext, "application/octet-stream");
    } catch (err) {
      await markPending(supabase, vm.id);
      return {
        ...base,
        outcome: "upload_failed",
        detail: `R2 putObject failed for ${archiveKey}: ${truncate(err)}`,
      };
    }

    // 7. DB write — atomic update to 'archived' with archive metadata.
    {
      const { error } = await supabase
        .from("instaclaw_vms")
        .update({
          freeze_state: "archived",
          frozen_archive_path: archiveKey,
          frozen_archive_sha256: outerSha,
          frozen_archive_size_kb: Math.ceil(ciphertext.length / 1024),
          frozen_archive_manifest: {
            ...manifestObj,
            outer_sha256: outerSha,
            outer_size_bytes: ciphertext.length,
          },
          frozen_archive_taken_at: new Date().toISOString(),
        })
        .eq("id", vm.id);
      if (error) {
        // Upload succeeded but DB write failed — orphan in R2. Don't delete
        // it from R2 because the DB column might just be eventually-consistent
        // or the network blip; safer to retry on next cron tick. A separate
        // gc cron sweeps orphans (no DB pointer + >24h old).
        logger.error("vm-archive-snapshot: DB write failed AFTER upload — orphan possible", {
          runId,
          vmId: vm.id,
          archiveKey,
          error: error.message,
        });
        return {
          ...base,
          outcome: "db_write_failed",
          detail: `archive uploaded but DB write failed: ${error.message}; key=${archiveKey} (orphan-eligible)`,
          archive_path: archiveKey,
          size_bytes: ciphertext.length,
        };
      }
    }

    // 8. Retention sweep — keep last RETENTION_GENERATIONS per VM.
    try {
      await retentionSweep(vm.id);
    } catch (err) {
      // Retention sweep failure is non-fatal — archive is still written.
      logger.warn("vm-archive-snapshot: retention sweep failed (non-fatal)", {
        runId,
        vmId: vm.id,
        error: truncate(err),
      });
    }

    // Lifecycle log — operator visibility.
    await logLifecycle(supabase, vm, "archived", `key=${archiveKey} size=${ciphertext.length}`, runId);

    return {
      ...base,
      outcome: "archived",
      detail: `uploaded ${archiveKey} (${ciphertext.length} bytes, key_id=${keyId})`,
      archive_path: archiveKey,
      size_bytes: ciphertext.length,
    };
  } catch (err) {
    await markPending(supabase, vm.id);
    return {
      ...base,
      outcome: "error",
      detail: truncate(err),
    };
  } finally {
    try { ssh?.dispose?.(); } catch { /* noop */ }
    await releaseCronLock(lockKey);
  }
}

// ─── gbrain MCP `snapshot_brain` call — STUBBED ──────────────────────────

/**
 * Call gbrain's `snapshot_brain` MCP tool on the VM. Returns the gzipped
 * PGLite data dir as a Buffer.
 *
 * IMPORTANT: this is STUBBED. The gbrain `snapshot_brain` MCP tool is a
 * dependency that hasn't shipped yet (gbrain terminal's task, blocking
 * freeze-v2 Phase 2). When it ships, replace the throw below with the
 * real implementation:
 *
 *   const tokenCmd = await ssh.execCommand(`cat ${GBRAIN_TOKEN_PATH}`);
 *   const token = tokenCmd.stdout.trim();
 *   if (!token) throw new Error("gbrain bearer token missing");
 *
 *   const payload = JSON.stringify({
 *     jsonrpc: "2.0", id: 1, method: "tools/call",
 *     params: { name: "snapshot_brain", arguments: { compression: "gzip" } },
 *   });
 *   const curl = await ssh.execCommand(
 *     `curl -sS -X POST ${GBRAIN_LOOPBACK}/mcp ` +
 *     `-H "Content-Type: application/json" ` +
 *     `-H "Accept: application/json, text/event-stream" ` +
 *     `-H "Authorization: Bearer ${token}" ` +
 *     `-d ${JSON.stringify(payload)}`
 *   );
 *   // Parse SSE: find the "data: " line with the result
 *   // result.content[0].blob is base64-encoded gzipped tar
 *   return Buffer.from(parsedBlob, "base64");
 *
 * See PRD §15.3 for the tool spec gbrain needs to implement.
 *
 * The stub-removal is a ~30 line diff. The rest of this cron is complete
 * and tested against the substrate (R2 + encryption + DB schema).
 */
async function callSnapshotBrain(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ssh: Awaited<ReturnType<typeof connectSSH>>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  vm: ArchiveCandidate,
): Promise<Buffer> {
  // STUB: feature gated on gbrain shipping snapshot_brain MCP tool.
  // See PRD §15.3. Replace this throw with the curl-MCP implementation
  // documented in this function's JSDoc when ready.
  throw new Error(
    "STUB: gbrain snapshot_brain MCP tool not yet available. " +
    "Freeze-v2 Phase 2 is gated on gbrain shipping the tool. " +
    "See PRD §15.3 + this file's callSnapshotBrain() docstring.",
  );
}

// ─── User-state tarball ──────────────────────────────────────────────────

/**
 * Build a gzipped tar of the user-state files on the VM. These are regular
 * files (not databases) so a normal `tar` is safe — they have no WAL or
 * lock-file concerns like PGLite.
 *
 * Some paths may not exist (e.g., empty wallet on a never-launched user,
 * sessions/ directory absent on a brand-new VM). `tar --ignore-failed-read`
 * + explicit existence checks via shell handle that without failing the
 * archive.
 */
async function snapshotUserState(
  ssh: Awaited<ReturnType<typeof connectSSH>>,
  vm: ArchiveCandidate,
  runId: string,
): Promise<Buffer> {
  // Paths relative to $HOME (i.e., /home/openclaw). The list is the Tier 1+2
  // "must save" + "should save" union from PRD §6.1, minus the PGLite dir
  // (handled separately by snapshot_brain) and minus things excluded as
  // regen-from-manifest.
  //
  // We list them in a here-doc and tar them via `tar -T -` (read names from
  // stdin) with `--ignore-failed-read` so missing paths are warnings only.
  const tarballPath = `/tmp/user-state-${runId}.tar.gz`;
  const listPath = `/tmp/user-state-list-${runId}.txt`;
  const cmd = `cat > ${listPath} <<'EOF'
.openclaw/wallet
.openclaw/workspace/MEMORY.md
.openclaw/workspace/memory
.openclaw/workspace/SOUL.md
.openclaw/.env
.openclaw/openclaw.json
.openclaw/agents/main/agent/auth-profiles.json
.openclaw/agents/main/sessions
.gbrain/openclaw-bearer-token.txt
EOF
cd $HOME && tar --ignore-failed-read -czf ${tarballPath} -T ${listPath} 2>&1 | head -20
echo "EXIT:$?"
stat -c%s ${tarballPath} 2>/dev/null || echo "STAT_FAIL"`;

  const r = await ssh.execCommand(cmd);
  const out = r.stdout || "";
  const exitMatch = out.match(/EXIT:(\d+)/);
  if (!exitMatch) {
    throw new Error(`user-state tar: missing EXIT marker. out=${out.slice(0, 300)}`);
  }
  const exitCode = Number.parseInt(exitMatch[1], 10);
  if (exitCode !== 0) {
    throw new Error(`user-state tar exit=${exitCode}; out=${out.slice(0, 300)}`);
  }

  // tar may have emitted warnings (ignored-failed-read), but it succeeded.
  // Read the size we logged + then fetch the file.
  const sizeMatch = out.match(/(\d+)\s*$/m);
  if (!sizeMatch) {
    throw new Error(`user-state tar: couldn't read tarball size. out=${out.slice(0, 300)}`);
  }

  // Pull the file off the VM. node-ssh's getFile reads to disk; we use a
  // temp path on the cron side then load to Buffer + clean up.
  const cronTmp = `/tmp/user-state-${vm.id}-${runId}.tar.gz`;
  await ssh.getFile(cronTmp, tarballPath);
  const fs = await import("node:fs/promises");
  try {
    const buf = await fs.readFile(cronTmp);
    return buf;
  } finally {
    await fs.unlink(cronTmp).catch(() => { /* best-effort */ });
    // Clean up VM tmp too (best-effort).
    await ssh.execCommand(`rm -f ${tarballPath} ${listPath}`).catch(() => { /* noop */ });
  }
}

// ─── Outer-tar builder (minimal ustar, no external deps) ─────────────────

/**
 * Build a ustar-format tar containing the given entries. Pure-Node, no
 * dependency on the `tar` npm package. Sufficient for our use case because:
 *   - We control all entries (no symlinks, no fancy metadata).
 *   - All entries are regular files with simple short names.
 *   - The output is read by us only (not by external tools), so we don't
 *     need GNU-tar extensions.
 *
 * For each entry: 512-byte header + content (padded to 512-byte block).
 * Trailing 2 × 512 NUL blocks marks end-of-archive.
 */
function buildOuterTar(entries: Array<{ name: string; buffer: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const NUL_BLOCK = Buffer.alloc(512);
  for (const e of entries) {
    if (e.name.length > 99) {
      throw new Error(`outer-tar: entry name too long (>99 chars): ${e.name}`);
    }
    chunks.push(buildUstarHeader(e.name, e.buffer.length));
    chunks.push(e.buffer);
    const padLen = (512 - (e.buffer.length % 512)) % 512;
    if (padLen > 0) chunks.push(Buffer.alloc(padLen));
  }
  // End-of-archive: two empty 512-byte blocks.
  chunks.push(NUL_BLOCK);
  chunks.push(NUL_BLOCK);
  return Buffer.concat(chunks);
}

/** Pad an octal string to N chars + trailing space + NUL (ustar convention). */
function octalField(value: number, width: number): Buffer {
  const oct = value.toString(8).padStart(width - 1, "0");
  return Buffer.from(oct + "\0", "ascii");
}

function buildUstarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  // name (100 bytes)
  header.write(name, 0, "ascii");
  // mode (8) — 0644 = "0000644\0"
  header.write("0000644\0", 100, "ascii");
  // uid (8) / gid (8) — both 0
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  // size (12)
  octalField(size, 12).copy(header, 124);
  // mtime (12) — now
  octalField(Math.floor(Date.now() / 1000), 12).copy(header, 136);
  // chksum (8) — placeholder spaces, computed below
  header.write("        ", 148, "ascii");
  // typeflag (1) — '0' = regular file
  header.write("0", 156, "ascii");
  // linkname (100) — empty
  // magic (6) + version (2) — ustar
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  // uname/gname/devmajor/devminor/prefix — empty
  // Compute checksum: sum of all bytes, with chksum field treated as spaces.
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  octalField(sum, 8).copy(header, 148);
  // Replace the trailing NUL of the chksum with a space (POSIX requirement).
  header[154] = 0x20;
  return header;
}

// ─── Retention sweep ─────────────────────────────────────────────────────

/**
 * Keep the most-recent RETENTION_GENERATIONS archives per VM in R2. Delete
 * older. Best-effort; logged but not fatal.
 *
 * Object key pattern: `<vm-id>/<unix-ts>-<sha256-prefix>.tar.enc` — listing
 * by prefix `<vm-id>/` returns all generations; sort by key descending
 * (alphabetic sort of zero-padded unix ts works because all timestamps
 * are 10 digits for the next ~250 years).
 */
async function retentionSweep(vmId: string): Promise<{ kept: number; deleted: number }> {
  const prefix = `${vmId}/`;
  const all = await listObjectsByPrefix(prefix);
  // Sort by key descending so newest is first. Our keys start with unix-ts,
  // so lexicographic sort matches timestamp sort. Defensively also sort by
  // last-modified.
  all.sort((a, b) => {
    const aTs = a.modified.getTime();
    const bTs = b.modified.getTime();
    if (aTs !== bTs) return bTs - aTs;
    return b.key.localeCompare(a.key);
  });
  const toDelete = all.slice(RETENTION_GENERATIONS);
  for (const o of toDelete) {
    try {
      await deleteObject(o.key);
    } catch {
      // Single failure doesn't abort the sweep — next cron tick retries.
    }
  }
  return { kept: Math.min(all.length, RETENTION_GENERATIONS), deleted: toDelete.length };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function markPending(
  supabase: ReturnType<typeof getSupabase>,
  vmId: string,
): Promise<void> {
  try {
    await supabase
      .from("instaclaw_vms")
      .update({ freeze_state: "archive_pending" })
      .eq("id", vmId);
  } catch {
    // best-effort
  }
}

async function logLifecycle(
  supabase: ReturnType<typeof getSupabase>,
  vm: ArchiveCandidate,
  action: string,
  reason: string,
  runId: string,
): Promise<void> {
  try {
    await supabase.from("instaclaw_vm_lifecycle_log").insert({
      vm_id: vm.id,
      vm_name: vm.name,
      ip_address: vm.ip_address,
      user_id: vm.assigned_to,
      user_email: "(see vm row)",
      subscription_status: null,
      credit_balance: 0,
      action,
      reason: `[${runId.slice(0, 8)}] ${reason}`,
      provider_server_id: null,
    });
  } catch (err) {
    logger.error("vm-archive-snapshot: lifecycle log insert failed (non-fatal)", {
      vmId: vm.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function truncate(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 200);
}
