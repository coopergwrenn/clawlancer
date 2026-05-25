/**
 * lib/bake/checkpoint-verify.ts — §3.5.5 automation.
 *
 * `install-gbrain.sh` Phase C2 has a WARN-not-FATAL path that ships an inert
 * CHECKPOINT cron if the patch fails to apply. Phase I has no equivalent
 * "did it actually work" check. Both gaps mean a snapshot can `INSTALL_COMPLETE`
 * while shipping degraded Rule-54 protection.
 *
 * This module verifies:
 *
 *   1. Phase C2: checkpoint-operation.ts patch file is on disk
 *   2. Phase C2: operations.ts registers the checkpoint operation
 *   3. Phase I: crontab has the pglite-checkpoint entry
 *   4. Phase I: systemd ExecStop drop-in installed at
 *      ~/.config/systemd/user/gbrain.service.d/20-execstop-checkpoint.conf
 *   5. Phase I: pglite-checkpoint.sh script is executable
 *   6. End-to-end: trial CHECKPOINT call returns "ok latency_ms=<N>"
 *
 * The 6th check is the load-bearing one — it exercises the full chain
 * (patch applied → MCP tool registered → cron script can reach it →
 * bearer in place → CHECKPOINT round-trip works).
 *
 * Per design doc §1.6 gap-fill item #7. Replaces the heredoc verification
 * block currently in `snapshot-bake-v105-checklist.md` §3.5.5.
 */

import { openSsh, sshExec } from "./verifications";

export interface CheckpointVerifyResult {
  ok: boolean;
  checks: Array<{ ok: boolean; label: string; detail: string }>;
  trial_checkpoint_latency_ms: number | null;
}

/**
 * Run the 6-check sequence against a bake VM. Returns structured results.
 * Caller decides what to do with failures (P0 typically — Rule 54 is load-bearing).
 */
export async function verifyCheckpointInstall(bakeVmIp: string): Promise<CheckpointVerifyResult> {
  const checks: CheckpointVerifyResult["checks"] = [];
  let trial_checkpoint_latency_ms: number | null = null;

  let c;
  try {
    c = await openSsh(bakeVmIp);

    // 1. Patch file present
    const r1 = await sshExec(c, "ls -la ~/gbrain/src/core/checkpoint-operation.ts 2>&1 || true");
    checks.push({
      ok: r1.stdout.includes("checkpoint-operation.ts") && !r1.stdout.includes("No such file"),
      label: "Phase C2: checkpoint-operation.ts present",
      detail: r1.stdout.trim().slice(0, 120),
    });

    // 2. Patch registered in operations.ts
    const r2 = await sshExec(
      c,
      "grep -c 'checkpoint' ~/gbrain/src/core/operations.ts 2>/dev/null || echo 0",
    );
    const grepCount = parseInt(r2.stdout.trim(), 10);
    checks.push({
      ok: grepCount > 0,
      label: "Phase C2: operations.ts references checkpoint",
      detail: `grep-count=${grepCount}`,
    });

    // 3. Crontab entry
    const r3 = await sshExec(c, "crontab -l 2>&1 | grep -c 'pglite-checkpoint' || echo 0");
    const cronCount = parseInt(r3.stdout.trim(), 10);
    checks.push({
      ok: cronCount > 0,
      label: "Phase I: pglite-checkpoint crontab entry",
      detail: `entry-count=${cronCount}`,
    });

    // 4. ExecStop drop-in
    const dropinPath = "~/.config/systemd/user/gbrain.service.d/20-execstop-checkpoint.conf";
    const r4 = await sshExec(c, `ls -la ${dropinPath} 2>&1 || true`);
    checks.push({
      ok: r4.stdout.includes("20-execstop-checkpoint.conf") && !r4.stdout.includes("No such"),
      label: "Phase I: ExecStop drop-in",
      detail: r4.stdout.trim().slice(0, 120),
    });

    // 5. Script executable
    const r5 = await sshExec(c, "test -x ~/.openclaw/scripts/pglite-checkpoint.sh && echo ok || echo missing");
    checks.push({
      ok: r5.stdout.trim() === "ok",
      label: "Phase I: pglite-checkpoint.sh executable",
      detail: r5.stdout.trim(),
    });

    // 6. Trial CHECKPOINT call — end-to-end exercise of the chain.
    //
    // Two bugs in the previous implementation, both surfaced bake attempt
    // 10 (2026-05-25):
    //
    // Bug 1: pglite-checkpoint.sh writes ALL output to
    //   ~/.openclaw/logs/pglite-checkpoint.log (NOT stdout) and always
    //   exits 0 to avoid cron-failure-spam. So `r6.stdout` was always
    //   empty → ok regex always failed → check ALWAYS reported failed
    //   regardless of actual outcome.
    //
    // Bug 2: a gateway restart during the preceding reconcile may have
    //   restarted gbrain too (downstream). gbrain takes ~30s to come
    //   fully active. If checkpoint-verify runs while gbrain is in
    //   "activating" state, pglite-checkpoint.sh silently skips
    //   ("skip: state=activating") and the chain looks broken when
    //   it's actually just timing.
    //
    // Fix: (a) poll for gbrain "active" up to 30s, (b) inject a marker
    // into the log file so we can identify OUR script's output (not a
    // stale cron tick from earlier), (c) invoke the script, (d) read
    // the log file LINES-AFTER-MARKER to determine outcome.
    let gbrainActive = false;
    let gbrainState = "";
    for (let i = 0; i < 15; i++) {
      const probe = await sshExec(c, "systemctl --user is-active gbrain.service 2>&1 || true");
      gbrainState = probe.stdout.trim();
      if (gbrainState === "active") {
        gbrainActive = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (gbrainActive) {
      const t0 = Date.now();
      const r6 = await sshExec(
        c,
        // MARKER line in the log + run script + emit lines AFTER marker (= our script's output only).
        // `tr` strips quotes so awk pattern is simpler.
        `MARKER="checkpoint-verify-$$-$(date +%s)" && ` +
          `mkdir -p ~/.openclaw/logs && ` +
          `echo "[$(date -u +%FT%TZ)] $MARKER" >> ~/.openclaw/logs/pglite-checkpoint.log && ` +
          `bash ~/.openclaw/scripts/pglite-checkpoint.sh && ` +
          `sleep 0.5 && ` +
          `awk -v m="$MARKER" '$0 ~ m { found=1; next } found' ~/.openclaw/logs/pglite-checkpoint.log 2>&1 | tail -3`,
        30_000,
      );
      trial_checkpoint_latency_ms = Date.now() - t0;
      // pglite-checkpoint.sh's success log line is "ok latency_ms=<N>"
      const ok = /ok\s+latency_ms=\d+/.test(r6.stdout);
      checks.push({
        ok,
        label: "End-to-end: trial CHECKPOINT call succeeds",
        detail: ok
          ? r6.stdout.trim().slice(0, 100)
          : `FAILED (gbrain=${gbrainState}, log-tail=${(r6.stdout || "(empty)").trim().slice(0, 150)})`,
      });
    } else {
      // gbrain didn't become active within 30s — escalate from old
      // silent-skip to a real fail. Rule 35 + Rule 54: gbrain MUST be
      // active for the CHECKPOINT MCP tool to be reachable.
      checks.push({
        ok: false,
        label: "End-to-end: trial CHECKPOINT — gbrain did not become active",
        detail: `gbrain.service did not become active within 30s (last state: ${gbrainState}). ` +
          `Rule 35 / Rule 54: gbrain MUST be active for the CHECKPOINT MCP tool to be reachable.`,
      });
    }
  } catch (e) {
    checks.push({
      ok: false,
      label: "checkpoint-verify SSH",
      detail: `SSH error: ${(e as Error).message.slice(0, 100)}`,
    });
  } finally {
    if (c) c.end();
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks, trial_checkpoint_latency_ms };
}
