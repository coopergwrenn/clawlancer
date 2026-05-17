/**
 * Auto-recovery for vm-911-class 0-byte `openclaw.json` corruption (P1 — added
 * 2026-05-17 same day as the vm-911 incident).
 *
 * Sibling cron to `stuck-unhealthy-customer-alert`:
 *   - alert cron pages humans within ~1 hour of a stuck-unhealthy paying VM.
 *   - this cron AUTO-FIXES the specific vm-911 failure mode (0-byte
 *     openclaw.json) on top of the alert, after waiting 2h to give operators
 *     a chance to act manually first.
 *
 * Scope: NARROW. This cron only fixes the 0-byte `openclaw.json` corruption
 * pattern (matches Rule 46 ENOSPC-during-atomic-rename signature). It does
 * NOT attempt general-purpose VM rescue. If the failure mode is anything
 * else (gateway hung mid-init, missing dependency, partition mounted RO,
 * network failure, etc.), it skips and lets the alert cron continue paging.
 *
 * Recovery recipe (validated manually on vm-911 2026-05-17 00:22 UTC):
 *   1. Confirm openclaw.json is exactly 0 bytes (false-positive guard).
 *   2. Find the latest `openclaw.json.clobbered.<ISO-timestamp>` file with
 *      size >= 100 bytes that ALSO parses as valid JSON. These are
 *      OpenClaw's self-rescue saved-aside-bad-versions; despite the
 *      "clobbered" name they are typically valid configs from before
 *      whatever event caused the current corruption.
 *   3. Backup current 0-byte file to `openclaw.json.zero-byte-bak.<ts>`.
 *   4. Copy clobbered → openclaw.json.
 *   5. `systemctl --user reset-failed openclaw-gateway` (clear
 *      StartLimitBurst=10 cooldown that accumulates during the crash loop).
 *   6. `systemctl --user restart openclaw-gateway`.
 *   7. Poll `is-active=active` AND `/health=200` for up to 120 seconds.
 *      Boot takes 30-60s with plugin loading, so 120s is generous.
 *   8. On success: emit AUTO_RECOVERY_OK code. On failure: emit a specific
 *      failure code so the route can page admin with the actionable detail.
 *
 * The entire SSH-side recipe runs as ONE bash command sent via NodeSSH's
 * execCommand. Atomic from the cron's perspective: either we get
 * AUTO_RECOVERY_OK back or we don't, no partial state hidden from the
 * caller.
 *
 * Safety guards:
 *   - 2-hour wait threshold (gives alert cron + human intervention a chance).
 *   - Caps at 1 attempt per VM per 24 hours via instaclaw_admin_alert_log
 *     dedup key. Prevents infinite-loop on a VM where recovery FAILS — the
 *     alert cron continues paging in parallel, signaling that automation
 *     gave up and operator action is required.
 *   - MAX_VMS_PER_RUN=3 caps fleet-wide blast radius per cron tick.
 *     Combined with the dedup key, this means at most 3 paying-customer VMs
 *     get auto-recovery attempts per 15-min cron tick — small enough that
 *     a misbehaving recovery couldn't cascade across the fleet before
 *     anyone notices.
 *   - The recovery is ATOMIC on the VM side (single bash -c). Backup is
 *     created before any mutation. If the python JSON-validation step
 *     fails (clobbered file isn't actually valid JSON), no mutation
 *     happens.
 *   - SSH duplicate-IP check (via connectSSH) prevents writing to the
 *     wrong VM if a duplicate IP exists in the DB.
 *
 * Original incident: vm-911 (afshinieyesi@gmail.com) silently down for
 * 98h 39m due to 0-byte openclaw.json. Manual recovery took ~10 min once
 * the operator noticed. This cron compresses that to ~1 cron tick + 60s
 * SSH-side recovery = ~17 min worst-case from the 2h detection threshold
 * being crossed. See `docs/incidents/2026-05-17-vm911-4day-silent-down.md`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";
import { connectSSH, type VMRecord } from "@/lib/ssh";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 min covers 3 VMs × ~90s recovery each + overhead

/** Hours unhealthy before this cron will attempt auto-recovery. Gives the
 *  stuck-unhealthy-customer-alert (1h threshold) AND humans a chance first. */
const STUCK_HOURS_THRESHOLD = 2;
/** Cap recovery attempts per VM per N hours (dedup key TTL). */
const DEDUP_HOURS = 24;
/** Max VMs to attempt per cron tick — bounded blast radius. */
const MAX_VMS_PER_RUN = 3;
/** Bash recovery script — runs as one atomic command via SSH. */
const RECOVERY_SCRIPT = `
set -e

# Step 1: confirm the corruption signature. False-positive guard.
SIZE=$(stat -c %s "$HOME/.openclaw/openclaw.json" 2>/dev/null || echo -1)
if [ "$SIZE" != "0" ]; then
  echo "AUTO_RECOVERY_SKIP_NOT_ZERO_BYTE size=$SIZE"
  exit 0
fi

# Step 2: find the latest .clobbered.<ts> backup that's >= 100 bytes AND parses as valid JSON.
CLOBBERED=""
CLOBBERED_SIZE=0
for f in $(ls -t "$HOME/.openclaw"/openclaw.json.clobbered.* 2>/dev/null); do
  sz=$(stat -c %s "$f" 2>/dev/null || echo 0)
  if [ "$sz" -ge 100 ]; then
    if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" 2>/dev/null; then
      CLOBBERED="$f"
      CLOBBERED_SIZE=$sz
      break
    fi
  fi
done
if [ -z "$CLOBBERED" ]; then
  echo "AUTO_RECOVERY_FAIL_NO_VALID_CLOBBERED"
  exit 1
fi

# Step 3+4: backup current 0-byte, restore clobbered. Both required before any restart.
TS=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="$HOME/.openclaw/openclaw.json.zero-byte-bak.$TS"
cp "$HOME/.openclaw/openclaw.json" "$BACKUP" || { echo "AUTO_RECOVERY_FAIL_BACKUP"; exit 2; }
cp "$CLOBBERED" "$HOME/.openclaw/openclaw.json" || { echo "AUTO_RECOVERY_FAIL_COPY"; exit 3; }

# Verify-after-write: new file should match the clobbered size.
NEW_SIZE=$(stat -c %s "$HOME/.openclaw/openclaw.json" 2>/dev/null || echo 0)
if [ "$NEW_SIZE" -lt 100 ]; then
  echo "AUTO_RECOVERY_FAIL_VERIFY_SIZE new=$NEW_SIZE expected_from=$CLOBBERED expected_size=$CLOBBERED_SIZE"
  exit 4
fi

# Step 5+6: reset start-limit cooldown + restart.
systemctl --user reset-failed openclaw-gateway >/dev/null 2>&1 || true
systemctl --user restart openclaw-gateway >/dev/null 2>&1 || { echo "AUTO_RECOVERY_FAIL_RESTART_CMD"; exit 5; }

# Step 7: poll for active + /health=200. Boot is 30-60s with plugins; 120s budget.
sleep 2
for i in $(seq 1 24); do
  ACTIVE=$(systemctl --user is-active openclaw-gateway 2>/dev/null || echo unknown)
  HEALTH=$(curl -sS -m 2 -o /dev/null -w "%{http_code}" http://localhost:18789/health 2>/dev/null || echo 000)
  if [ "$ACTIVE" = "active" ] && [ "$HEALTH" = "200" ]; then
    echo "AUTO_RECOVERY_OK restored_from=$CLOBBERED clobbered_size=$CLOBBERED_SIZE new_size=$NEW_SIZE backup=$BACKUP boot_seconds=$((i*5))"
    exit 0
  fi
  if [ "$ACTIVE" = "failed" ]; then
    echo "AUTO_RECOVERY_RESTART_FAILED restored_from=$CLOBBERED active=failed health=$HEALTH backup=$BACKUP"
    exit 6
  fi
  sleep 5
done
echo "AUTO_RECOVERY_TIMEOUT active=$ACTIVE health=$HEALTH restored_from=$CLOBBERED backup=$BACKUP"
exit 7
`;

interface RecoveryOutcome {
  code: string;
  rawOutput: string;
  details: Record<string, string>;
  success: boolean;
}

function parseRecoveryOutput(stdout: string, stderr: string): RecoveryOutcome {
  const merged = (stdout + "\n" + stderr).trim();
  // Find a line starting with AUTO_RECOVERY_
  const line = merged
    .split("\n")
    .reverse()
    .find((l) => /^AUTO_RECOVERY_/.test(l.trim())) ?? "";
  const parts = line.trim().split(/\s+/);
  const code = parts[0] || "AUTO_RECOVERY_UNKNOWN";
  const details: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const m = p.match(/^([^=]+)=(.*)$/);
    if (m) details[m[1]] = m[2];
  }
  return {
    code,
    rawOutput: merged.slice(0, 1500),
    details,
    success: code === "AUTO_RECOVERY_OK" || code === "AUTO_RECOVERY_SKIP_NOT_ZERO_BYTE",
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const now = new Date();
  const stuckCutoff = new Date(
    now.getTime() - STUCK_HOURS_THRESHOLD * 3600_000,
  ).toISOString();

  // Candidates: paying-customer VMs stuck unhealthy/unknown for >2h.
  const { data: candidates, error } = await supabase
    .from("instaclaw_vms")
    .select(
      "id, name, ip_address, ssh_port, ssh_user, gateway_url, gateway_token, region, health_status, last_health_check, assigned_to, partner, config_version, health_fail_count",
    )
    .eq("status", "assigned")
    .eq("provider", "linode")
    .in("health_status", ["unhealthy", "unknown"])
    .lt("last_health_check", stuckCutoff)
    .not("assigned_to", "is", null)
    .not("ip_address", "is", null)
    .order("last_health_check", { ascending: true })
    .limit(MAX_VMS_PER_RUN * 4); // overfetch to skip dedup-hit candidates

  if (error) {
    logger.error("stuck-vm-auto-recover: query failed", {
      route: "cron/stuck-vm-auto-recover",
      error: error.message,
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ candidates: 0, attempted: 0, recovered: 0, failed: 0, skipped: 0 });
  }

  let attempted = 0;
  let recovered = 0;
  let failed = 0;
  let skipped = 0;
  let dedupSkipped = 0;
  const log: Array<{ vm: string; outcome: string; details?: Record<string, string> }> = [];

  for (const vm of candidates) {
    if (attempted >= MAX_VMS_PER_RUN) break;

    // Dedup: 1 attempt per VM per DEDUP_HOURS
    const bucketKey = `stuck_vm_auto_recover:${vm.id}:${Math.floor(
      now.getTime() / (DEDUP_HOURS * 3600_000),
    )}`;
    const { data: existing } = await supabase
      .from("instaclaw_admin_alert_log")
      .select("id")
      .eq("alert_key", bucketKey)
      .limit(1);
    if (existing && existing.length > 0) {
      dedupSkipped++;
      continue;
    }

    attempted++;
    const vmRecord: VMRecord = {
      id: vm.id,
      ip_address: vm.ip_address!,
      ssh_port: vm.ssh_port ?? 22,
      ssh_user: vm.ssh_user ?? "openclaw",
      region: vm.region ?? undefined,
    };

    let outcome: RecoveryOutcome = {
      code: "AUTO_RECOVERY_PRE_SSH_ERROR",
      rawOutput: "",
      details: {},
      success: false,
    };

    try {
      const ssh = await connectSSH(vmRecord);
      try {
        // execCommand returns { stdout, stderr, code }
        // 5 min timeout — covers the 120s health-poll budget + buffers
        const res = await ssh.execCommand(RECOVERY_SCRIPT, { execOptions: { pty: false } });
        outcome = parseRecoveryOutput(res.stdout || "", res.stderr || "");
        logger.info("stuck-vm-auto-recover: ssh complete", {
          route: "cron/stuck-vm-auto-recover",
          vmId: vm.id,
          vmName: vm.name,
          code: outcome.code,
          exitCode: res.code,
          details: outcome.details,
        });
      } finally {
        ssh.dispose();
      }
    } catch (e) {
      outcome = {
        code: "AUTO_RECOVERY_SSH_FAILED",
        rawOutput: String(e).slice(0, 500),
        details: { error: String(e).slice(0, 200) },
        success: false,
      };
      logger.error("stuck-vm-auto-recover: ssh failed", {
        route: "cron/stuck-vm-auto-recover",
        vmId: vm.id,
        vmName: vm.name,
        error: String(e).slice(0, 300),
      });
    }

    // Record the attempt in the dedup table.
    await supabase
      .from("instaclaw_admin_alert_log")
      .insert({ alert_key: bucketKey, sent_at: now.toISOString() });

    // Look up user email for the alert.
    let userEmail = "(unknown)";
    if (vm.assigned_to) {
      const { data: u } = await supabase
        .from("instaclaw_users")
        .select("email")
        .eq("id", vm.assigned_to)
        .limit(1)
        .maybeSingle();
      if (u?.email) userEmail = u.email;
    }

    if (outcome.code === "AUTO_RECOVERY_OK") {
      recovered++;
      // Update DB to reflect the now-healthy state.
      await supabase
        .from("instaclaw_vms")
        .update({
          health_status: "healthy",
          last_health_check: new Date().toISOString(),
        })
        .eq("id", vm.id);
      logger.info("stuck-vm-auto-recover: recovered", {
        route: "cron/stuck-vm-auto-recover",
        vmId: vm.id,
        vmName: vm.name,
        userEmail,
        bootSeconds: outcome.details.boot_seconds,
        restoredFrom: outcome.details.restored_from,
      });
      // Page admin: success
      await sendAdminAlertEmail(
        `✅ Auto-recovered: ${vm.name} (${userEmail})`,
        [
          `VM ${vm.name} was auto-recovered from 0-byte openclaw.json corruption.`,
          ``,
          `Customer:     ${userEmail}`,
          `IP:           ${vm.ip_address}`,
          `Boot time:    ${outcome.details.boot_seconds ?? "?"}s post-restart`,
          `Restored from: ${outcome.details.restored_from ?? "?"}`,
          `Clobbered size: ${outcome.details.clobbered_size ?? "?"} bytes`,
          `New size:     ${outcome.details.new_size ?? "?"} bytes`,
          `Backup:       ${outcome.details.backup ?? "?"} (original 0-byte preserved for forensics)`,
          ``,
          `health_status updated to 'healthy' in DB. No human action required.`,
          `Re-attempt for this VM is dedup-locked for ${DEDUP_HOURS}h.`,
        ].join("\n"),
      ).catch((e) => logger.error("stuck-vm-auto-recover: success alert send failed", { error: String(e) }));
    } else if (outcome.code === "AUTO_RECOVERY_SKIP_NOT_ZERO_BYTE") {
      // VM is unhealthy but NOT due to the 0-byte signature. Different failure
      // mode — out of scope for this cron. The stuck-unhealthy-customer-alert
      // cron continues paging humans about this VM.
      skipped++;
      logger.info("stuck-vm-auto-recover: skip (not zero-byte signature)", {
        route: "cron/stuck-vm-auto-recover",
        vmId: vm.id,
        vmName: vm.name,
        currentSize: outcome.details.size,
      });
    } else {
      // Recovery attempted but failed. Page admin loudly with details.
      failed++;
      logger.error("stuck-vm-auto-recover: failed", {
        route: "cron/stuck-vm-auto-recover",
        vmId: vm.id,
        vmName: vm.name,
        userEmail,
        code: outcome.code,
        details: outcome.details,
      });
      await sendAdminAlertEmail(
        `🔴 Auto-recovery FAILED: ${vm.name} (${userEmail})`,
        [
          `VM ${vm.name} matched the stuck-unhealthy criteria but auto-recovery did NOT succeed.`,
          ``,
          `Customer:    ${userEmail}`,
          `IP:          ${vm.ip_address}`,
          `Failure code: ${outcome.code}`,
          ``,
          `Failure code meanings:`,
          `  AUTO_RECOVERY_FAIL_NO_VALID_CLOBBERED — no .clobbered.<ts> backup exists with valid JSON.`,
          `    Action: VM likely needs a from-scratch reconfigure via /api/admin/reconfigure-vm or`,
          `    rebuilt from a sibling VM's config.`,
          `  AUTO_RECOVERY_FAIL_BACKUP / FAIL_COPY / FAIL_VERIFY_SIZE — filesystem error during recovery.`,
          `    Action: check disk space, permissions, inode exhaustion. SSH and inspect manually.`,
          `  AUTO_RECOVERY_FAIL_RESTART_CMD — systemctl restart returned non-zero.`,
          `    Action: check systemd unit state, user dbus session, runtime dir.`,
          `  AUTO_RECOVERY_RESTART_FAILED — gateway entered 'failed' state after restart attempt.`,
          `    Action: the .clobbered config may be too stale or incompatible. Try an older one,`,
          `    or trigger configureOpenClaw to rebuild from scratch.`,
          `  AUTO_RECOVERY_TIMEOUT — gateway never reached active+healthy within 120s.`,
          `    Action: gateway may be hung in plugin loading. Check ` +
            `journalctl --user -u openclaw-gateway --since "2 minutes ago" for details.`,
          `  AUTO_RECOVERY_SSH_FAILED — couldn't SSH to the VM.`,
          `    Action: check Linode console / firewall / sshd state.`,
          ``,
          `Details: ${JSON.stringify(outcome.details)}`,
          ``,
          `Re-attempt dedup-locked for ${DEDUP_HOURS}h. Manual intervention recommended.`,
          ``,
          `SSH:`,
          `  ssh -i /tmp/instaclaw-ssh-key openclaw@${vm.ip_address}`,
          ``,
          `Raw output (first 1500 chars):`,
          outcome.rawOutput,
        ].join("\n"),
      ).catch((e) => logger.error("stuck-vm-auto-recover: failure alert send failed", { error: String(e) }));
    }

    log.push({ vm: vm.name ?? vm.id, outcome: outcome.code, details: outcome.details });
  }

  logger.info("stuck-vm-auto-recover: cycle complete", {
    route: "cron/stuck-vm-auto-recover",
    candidates: candidates.length,
    attempted,
    recovered,
    failed,
    skipped,
    dedupSkipped,
    log,
  });

  return NextResponse.json({
    candidates: candidates.length,
    attempted,
    recovered,
    failed,
    skipped,
    dedupSkipped,
    log,
  });
}
