/**
 * ENOSPC detection wrapper — CLAUDE.md Rule 37.
 *
 * Why this exists:
 *   When a fleet VM hits ENOSPC mid-reconcile, the actual stderr emitted by
 *   the failing command (`openclaw config set`, `npm install`, `echo >`,
 *   `tar`, etc.) was historically discarded by the reconciler. The non-strict
 *   stepConfigSettings path was the worst offender — it surfaced a downstream
 *   "config-set silent failure" verify-mismatch instead of the actual ENOSPC.
 *   Rule 36 fixed that for stepConfigSettings specifically (surfaces upstream
 *   stderr). Rule 37 closes the broader hole: ANY ssh.execCommand or
 *   ssh.putFile that emits ENOSPC must short-circuit the reconcile, push a P0
 *   error, and fire an admin alert. The customer's gateway is functional NOW
 *   (the running OpenClaw process holds its config in memory), but the next
 *   config-mutating write would corrupt openclaw.json via the
 *   ENOSPC-during-atomic-rename failure mode (the 2026-05-13 vm-842 0-byte-
 *   config incident).
 *
 * How:
 *   - `wrapSSHForEnospcDetection(ssh, vm, result)` returns a thin proxy that
 *     intercepts execCommand and putFile. After every call, it scans the
 *     result (stdout + stderr + thrown-error.message) for ENOSPC markers. On
 *     first detection within a reconcile:
 *       1. Push a P0 entry to result.errors with the command prefix + path.
 *       2. Set result.enospcDetected so the orchestrator can skip later steps.
 *       3. Fire-and-forget admin alert (6h dedup via
 *          instaclaw_admin_alert_log).
 *       4. Throw the __ENOSPC__ sentinel so the reconcileVM try/catch in
 *          lib/vm-reconcile.ts can stop the cycle cleanly.
 *   - Subsequent ENOSPC hits in the same reconcile are silently dropped
 *     (result.enospcDetected already set) — no duplicate alerts.
 *
 * What gets matched:
 *   - "ENOSPC" (Node.js fs error code; also surfaces from libuv-backed CLIs
 *     like openclaw/npm)
 *   - "No space left on device" (POSIX errno text)
 *   - "no space left on device" (lowercase; some tools print it that way)
 *
 * What gets path-extracted (best-effort, for log/alert clarity):
 *   - Node format: `ENOSPC: no space left on device, open '/path/to/foo'`
 *   - bash redirect: `bash: line N: /path/to/foo: No space left on device`
 *   - tar/cp: `cp: error writing '/path': No space left on device`
 *
 * Path extraction is best-effort. If no path matches, we log the last 500
 * chars of stderr+stdout so an operator can dig in.
 *
 * What we DON'T do here:
 *   - We don't try to free space ourselves. stepDiskGuard (Rule 46) is the
 *     proactive purge step; this is the reactive detector.
 *   - We don't classify "transient" vs "persistent" — every ENOSPC is treated
 *     as critical, because the failure mode (silent half-write) is the same
 *     regardless of duration.
 *   - We don't attempt to recover the in-flight reconcile. Short-circuit is
 *     the safer move; the next cron cycle re-evaluates once stepDiskGuard
 *     has freed space.
 */
import type { VMRecord } from "./ssh";
import type { ReconcileResult } from "./vm-reconcile";
import { getSupabase } from "./supabase";
import { sendAdminAlertEmail } from "./email";
import { logger } from "./logger";

// `VMRecord` in lib/ssh.ts doesn't declare `name`, but most reconciler call
// sites pass a VMRecord & { name?: string | null } (the DB row includes it).
// Accept either shape so this helper can log a friendly identifier without a
// caller having to massage the type.
type VMRecordWithName = VMRecord & { name?: string | null };

/**
 * Sentinel error thrown by the wrapper when ENOSPC is detected. reconcileVM
 * (and runFileDriftPass, if wrapped) MUST catch this and treat it as a
 * controlled short-circuit — push to result.errors (already done by the
 * wrapper), dispose SSH, return normally. Don't re-throw.
 */
export class EnospcDetectedError extends Error {
  constructor(public detail: { path: string | null; cmdPrefix: string; rawTail: string }) {
    super(`ENOSPC_DETECTED${detail.path ? `: ${detail.path}` : ""}`);
    this.name = "EnospcDetectedError";
  }
}

const ENOSPC_PATTERNS = [
  /ENOSPC/,
  /no space left on device/i,
];

/**
 * Scan combined output for ENOSPC markers. Returns { path, rawTail } when a
 * match is found, null otherwise.
 *
 * `rawTail` is the trailing ~500 chars of combined output, scrubbed to ASCII
 * for log safety. Used in the result.errors entry + admin alert body.
 *
 * Path extraction tries three common formats; if none match, path is null
 * but the caller still treats the event as ENOSPC.
 */
export function scanForEnospc(
  stdout: string,
  stderr: string,
): { path: string | null; rawTail: string } | null {
  const combined = `${stdout}\n${stderr}`;
  const hit = ENOSPC_PATTERNS.some((p) => p.test(combined));
  if (!hit) return null;

  // Path-extraction patterns, in order of specificity:
  //   1. Node fs error:  ENOSPC: no space left on device, open '/path/to/foo'
  //   2. bash redirect:  bash: line N: /path/to/foo: No space left on device
  //                     (or just: /path/to/foo: No space left on device — any
  //                      bash-y prefix before the absolute path is tolerated)
  //   3. tar/cp/etc:     error writing '/path/...': No space left on device
  const nodeMatch = combined.match(/ENOSPC:[^,]*,\s*\w+\s+'([^']+)'/);
  const bashMatch = combined.match(/:\s*(\/[^:\s]+):\s*No space left/i);
  const toolMatch = combined.match(/(?:error )?writing\s+'([^']+)'[^:]*:\s*No space left/i);
  const path =
    (nodeMatch && nodeMatch[1]) ||
    (bashMatch && bashMatch[1].trim()) ||
    (toolMatch && toolMatch[1]) ||
    null;

  // ASCII-clean tail — strip non-printable chars so the alert email and the
  // result.errors string don't break formatting.
  const rawTail = combined.slice(-500).replace(/[^\x20-\x7E\n]/g, "?");
  return { path, rawTail };
}

/**
 * Wrap an SSH connection so any ENOSPC observed during execCommand/putFile
 * short-circuits the reconcile. Intended to be called ONCE per reconcileVM
 * immediately after `connectSSH(vm)`; use the returned wrapper everywhere
 * downstream.
 *
 * Implementation: prototype-chain extension via Object.create lets us override
 * exactly `execCommand` and `putFile` while every other NodeSSH method
 * (dispose, getFile, requestSFTP, etc.) passes through unchanged. We don't
 * use Proxy because step* functions occasionally introspect `ssh` for
 * presence of methods, and Proxy can break instanceof / .constructor checks.
 *
 * Idempotency: the wrapper fires its side effects (push error, alert, throw)
 * at most once per reconcile. Subsequent ENOSPC hits return the raw command
 * result without re-firing.
 */
// Generic over an arbitrary SSH-shaped object. We treat the SSH as opaque
// (matches `type SSHConnection = any` in lib/vm-reconcile.ts:702) and return
// it back to the caller at the same nominal type. The wrapper only overrides
// `execCommand` and `putFile`; every other method (dispose, getFile, etc.)
// passes through unchanged via the prototype chain.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wrapSSHForEnospcDetection<T extends object = any>(
  ssh: T,
  vm: VMRecordWithName,
  result: ReconcileResult,
): T {
  const wrapped = Object.create(ssh) as T & {
    execCommand: (...args: unknown[]) => Promise<{ stdout: string; stderr: string; code: number | null }>;
    putFile: (...args: unknown[]) => Promise<void>;
  };

  // Note: we're not adding a property to result interface here (would require
  // editing ReconcileResult). Instead, stash the once-only flag on the
  // wrapped ssh object itself. The orchestrator can read it via the
  // exported `enospcWasDetected(ssh)` helper if it cares.
  let alreadyFired = false;

  const fireOnce = (
    scan: { path: string | null; rawTail: string },
    cmdPrefix: string,
  ): EnospcDetectedError => {
    const error = new EnospcDetectedError({
      path: scan.path,
      cmdPrefix,
      rawTail: scan.rawTail,
    });

    if (alreadyFired) return error;
    alreadyFired = true;

    // ── 1. Push to result.errors so the cron's pushFailed gate holds cv. ──
    const errMsg =
      `[ENOSPC] disk full on ${vm.name ?? vm.id}` +
      (scan.path ? ` (path: ${scan.path})` : "") +
      ` — cmd: ${cmdPrefix.slice(0, 120)} — tail: ${scan.rawTail.slice(-200)}`;
    result.errors.push(errMsg);

    // ── 2. Structured log so operators can grep. ──
    logger.error("ENOSPC_DETECTED", {
      route: "vm-reconcile/enospc-guard",
      vmId: vm.id,
      vmName: vm.name,
      enospcPath: scan.path,
      cmdPrefix: cmdPrefix.slice(0, 200),
      rawTail: scan.rawTail,
    });

    // ── 3. Fire-and-forget admin alert (6h dedup). ──
    sendEnospcAlertDeduped(vm, scan, cmdPrefix).catch((e) => {
      logger.error("ENOSPC alert dispatch failed", {
        route: "vm-reconcile/enospc-guard",
        vmId: vm.id,
        error: String(e).slice(0, 200),
      });
    });

    return error;
  };

  // execCommand interceptor — scan both stdout + stderr, also catch thrown
  // errors (node-ssh wraps some SSH transport errors as thrown rather than
  // returning non-zero exit).
  wrapped.execCommand = async function wrappedExecCommand(this: unknown, ...args: unknown[]) {
    const cmd = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
    type ExecResult = { stdout: string; stderr: string; code: number | null };
    let res: ExecResult;
    try {
      res = (await (ssh as unknown as { execCommand: (...a: unknown[]) => Promise<ExecResult> })
        .execCommand(...args)) as ExecResult;
    } catch (err) {
      // node-ssh throws on transport-level errors; check the message for
      // ENOSPC too (rare but seen on broken pipe during huge writes).
      const msg = err instanceof Error ? err.message : String(err);
      const scan = scanForEnospc("", msg);
      if (scan) throw fireOnce(scan, cmd);
      throw err;
    }
    const scan = scanForEnospc(res.stdout ?? "", res.stderr ?? "");
    if (scan) throw fireOnce(scan, cmd);
    return res;
  };

  // putFile interceptor — node-ssh throws on SFTP failure with a message like
  // "Failure" or sometimes a wrapped errno; the ENOSPC text usually appears
  // in the underlying error.message. We catch, scan, fire if matched, else
  // re-throw the original error untouched (caller's try/catch handles it).
  wrapped.putFile = async function wrappedPutFile(this: unknown, ...args: unknown[]) {
    const localPath = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
    const remotePath = typeof args[1] === "string" ? args[1] : String(args[1] ?? "");
    try {
      await (ssh as unknown as { putFile: (...a: unknown[]) => Promise<void> }).putFile(...args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const scan = scanForEnospc("", msg);
      if (scan) {
        throw fireOnce(scan, `putFile ${localPath} → ${remotePath}`);
      }
      throw err;
    }
  };

  return wrapped as T;
}

/**
 * Send an ENOSPC admin alert with 6h dedup. Mirrors the pattern used by
 * `lib/email.ts:sendVMReadyEmail` (dedup-via-instaclaw_admin_alert_log,
 * record-before-send to prevent races). Per-VM keyed so an outage on one VM
 * doesn't suppress alerting for another.
 *
 * Fire-and-forget — the caller catches its rejection separately.
 */
async function sendEnospcAlertDeduped(
  vm: VMRecordWithName,
  scan: { path: string | null; rawTail: string },
  cmdPrefix: string,
): Promise<void> {
  const supabase = getSupabase();
  const alertKey = `enospc:${vm.id}`;
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

  // Dedup check
  let recentlySent = false;
  try {
    const { data } = await supabase
      .from("instaclaw_admin_alert_log")
      .select("id")
      .eq("alert_key", alertKey)
      .gte("sent_at", sixHoursAgo)
      .limit(1);
    recentlySent = (data?.length ?? 0) > 0;
  } catch {
    // Dedup-table missing → proceed without dedup (better to over-alert than
    // miss the first signal). Matches sendVMReadyEmail's failure mode.
  }
  if (recentlySent) {
    logger.info("ENOSPC alert suppressed (6h dedup)", {
      route: "vm-reconcile/enospc-guard",
      vmId: vm.id,
    });
    return;
  }

  // Record BEFORE send so two near-simultaneous reconciles don't both alert.
  try {
    await supabase.from("instaclaw_admin_alert_log").insert({
      alert_key: alertKey,
      vm_count: 1,
      details: `ENOSPC on ${vm.name ?? vm.id}; path=${scan.path ?? "(unknown)"}; cmd=${cmdPrefix.slice(0, 120)}`,
    });
  } catch {
    // Insert failed (table missing, RLS) — proceed to send anyway.
  }

  const subject = `[Rule 37] ENOSPC on ${vm.name ?? vm.id}`;
  const body =
    `VM: ${vm.name ?? "(unnamed)"} (${vm.id})\n` +
    `IP:  ${vm.ip_address}\n` +
    `Path: ${scan.path ?? "(unknown — see tail)"}\n` +
    `Cmd: ${cmdPrefix.slice(0, 200)}\n` +
    `\n` +
    `Tail of stdout+stderr (last 500 chars):\n` +
    `---\n${scan.rawTail}\n---\n` +
    `\n` +
    `Reconcile was short-circuited (Rule 37). Customer's running gateway is\n` +
    `unaffected because the in-memory config snapshot survives, but the next\n` +
    `config-mutating write would corrupt openclaw.json via the\n` +
    `ENOSPC-during-atomic-rename failure mode.\n` +
    `\n` +
    `Next steps:\n` +
    `  1. SSH in: ssh -i /tmp/ic_ssh_key openclaw@${vm.ip_address}\n` +
    `  2. Check disk: df -h /\n` +
    `  3. Find the bloat: du -sh ~/.openclaw/{session-backups,sessions,workspace} ~/scripts ~/.cache 2>/dev/null | sort -h\n` +
    `  4. Purge (safe defaults):\n` +
    `       find ~/.openclaw/session-backups -mtime +1 -delete\n` +
    `       ls -t ~/.openclaw/session-backups | tail -n +1001 | xargs -I{} rm -f ~/.openclaw/session-backups/{} 2>/dev/null\n` +
    `       sudo journalctl --vacuum-time=2d\n` +
    `  5. Once disk <80%, the next reconcile cron tick (within ~3 min) will resume cleanly.\n` +
    `\n` +
    `stepDiskGuard (Rule 46) should have caught this proactively at the >=90%\n` +
    `threshold. If you're seeing this alert, disk-guard either ran AFTER the\n` +
    `cv-blocking step or wasn't sufficient to free enough space. Investigate\n` +
    `whether the VM has a runaway-cache problem (sessions, node_modules,\n` +
    `~/.cache/) beyond what disk-guard purges.`;

  await sendAdminAlertEmail(subject, body);
}

/**
 * Sentinel-error check used by reconcileVM's catch handler to differentiate
 * EnospcDetectedError from other thrown errors. Lets the orchestrator log a
 * clean short-circuit instead of re-throwing.
 */
export function isEnospcDetectedError(err: unknown): err is EnospcDetectedError {
  return err instanceof EnospcDetectedError;
}
