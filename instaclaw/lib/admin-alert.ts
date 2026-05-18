import { sendAdminAlertEmail } from "./email";
import { getSupabase } from "./supabase";
import { logger } from "./logger";

const COOLDOWN_HOURS = 6;

/**
 * Send a per-VM admin alert with PER-VM dedup. Use this — NOT AlertCollector —
 * for ACTIONABLE alerts where Cooper needs visibility into EACH affected VM
 * individually (disk-critical, paying-customer down, etc.).
 *
 * Why this exists separately from AlertCollector:
 * AlertCollector dedups by `alert_key = subject`. That's correct for FYI
 * digests ("3 VMs hit a soft threshold") but catastrophic for actionable
 * alerts. The 2026-05-18 vm-748 lesson: when one VM fires "VM Disk
 * Critical", AlertCollector suppresses ALL other VMs hitting Disk Critical
 * within the 6h cooldown. Paying customers' VMs crashed silently while
 * Cooper waited 6h for the next email.
 *
 * Per-VM keys (`disk_critical:${vm.id}`) dedup independently — each VM
 * gets its own 6h window, so 8 VMs going critical in the same hour produce
 * 8 emails (correct: each one is actionable), not 1 (wrong: only first is
 * visible).
 *
 * Failure mode: if email send fails, we do NOT insert the dedup row, so
 * the next cron tick retries. This mirrors AlertCollector's existing
 * behavior and trades one duplicate-on-retry for "no silent P1 misses."
 *
 * @returns "sent" — email delivered to Resend AND dedup row inserted
 *          "deduped" — recent send found, no action
 *          "failed" — email failed; no dedup row, next tick will retry
 */
export async function sendPerVmAlertDeduped(params: {
  alertKey: string;
  subject: string;
  body: string;
  dedupHours?: number;
}): Promise<"sent" | "deduped" | "failed"> {
  const { alertKey, subject, body, dedupHours = COOLDOWN_HOURS } = params;
  const supabase = getSupabase();

  // Dedup check — fail-OPEN on table error (better to over-alert than to
  // silently swallow a P1 because admin_alert_log is temporarily down).
  try {
    const cutoff = new Date(Date.now() - dedupHours * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("instaclaw_admin_alert_log")
      .select("id")
      .eq("alert_key", alertKey)
      .gte("sent_at", cutoff)
      .limit(1);
    if (data && data.length > 0) return "deduped";
  } catch (err) {
    logger.warn("sendPerVmAlertDeduped: dedup query failed, sending anyway", {
      alertKey,
      error: String(err),
    });
  }

  // Send email FIRST. If it fails, don't claim the dedup slot — retry next tick.
  try {
    await sendAdminAlertEmail(subject, body);
  } catch (err) {
    logger.error("sendPerVmAlertDeduped: email send failed", {
      alertKey,
      subject,
      error: String(err),
    });
    return "failed";
  }

  // Email succeeded — claim the dedup slot. Best-effort; if insert fails we'll
  // double-send once before the next dedup window naturally cycles.
  try {
    await supabase.from("instaclaw_admin_alert_log").insert({
      alert_key: alertKey,
      vm_count: 1,
      details: body.slice(0, 2000),
    });
  } catch (err) {
    logger.warn("sendPerVmAlertDeduped: dedup row insert failed (email already sent)", {
      alertKey,
      error: String(err),
    });
  }

  return "sent";
}

interface PendingAlert {
  subject: string;
  vmName: string;
  detail: string;
}

/**
 * Collects admin alerts during a cron cycle and sends them as grouped
 * digest emails instead of individual emails per VM. Also deduplicates
 * across cycles using the instaclaw_admin_alert_log table (6-hour cooldown).
 *
 * Usage:
 *   const alerts = new AlertCollector();
 *   alerts.add("Session Size Warning", "vm-016", "session.json is 300KB");
 *   alerts.add("Session Size Warning", "vm-039", "session.json is 280KB");
 *   await alerts.flush();
 *   // → Sends ONE email: "Session Size Warning on 2 VMs: vm-016, vm-039"
 */
export class AlertCollector {
  private pending: PendingAlert[] = [];

  /** Queue an alert for the end-of-cycle digest. */
  add(subject: string, vmName: string, detail: string): void {
    this.pending.push({ subject, vmName, detail });
  }

  /** Group queued alerts by subject, dedup against recent sends, and flush as digest emails. */
  async flush(): Promise<{ sent: number; skipped: number }> {
    if (this.pending.length === 0) return { sent: 0, skipped: 0 };

    const supabase = getSupabase();
    const grouped = new Map<string, PendingAlert[]>();

    for (const alert of this.pending) {
      const existing = grouped.get(alert.subject) || [];
      existing.push(alert);
      grouped.set(alert.subject, existing);
    }

    let sent = 0;
    let skipped = 0;

    for (const [subject, alerts] of grouped) {
      const alertKey = subject;

      // Check cooldown: was this alert type sent in the last N hours?
      let recentlySent = false;
      try {
        const cutoff = new Date(Date.now() - COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
        const { data } = await supabase
          .from("instaclaw_admin_alert_log")
          .select("id")
          .eq("alert_key", alertKey)
          .gte("sent_at", cutoff)
          .limit(1);

        recentlySent = (data?.length ?? 0) > 0;
      } catch {
        // Table may not exist yet — proceed without dedup
      }

      if (recentlySent) {
        skipped += alerts.length;
        continue;
      }

      // Build digest email
      const vmNames = alerts.map((a) => a.vmName);
      const count = vmNames.length;
      const digestSubject =
        count === 1
          ? `${subject}: ${vmNames[0]}`
          : `${subject} on ${count} VMs`;

      let digestBody: string;
      if (count <= 10) {
        // Show full details for small batches
        digestBody = alerts
          .map((a) => `${a.vmName}:\n${a.detail}`)
          .join("\n\n---\n\n");
      } else {
        // Summary for large batches
        const listed = vmNames.slice(0, 20).join(", ");
        const more = count > 20 ? `\n... and ${count - 20} more` : "";
        digestBody = `Affected VMs (${count}): ${listed}${more}\n\nSample detail from ${vmNames[0]}:\n${alerts[0].detail}`;
      }

      try {
        await sendAdminAlertEmail(digestSubject, digestBody);
        sent++;

        // Log to dedup table
        try {
          await supabase.from("instaclaw_admin_alert_log").insert({
            alert_key: alertKey,
            vm_count: count,
            details: digestBody.slice(0, 2000),
          });
        } catch {
          // Table may not exist — non-fatal
        }
      } catch (err) {
        logger.error("Failed to send admin alert digest", {
          subject: digestSubject,
          error: String(err),
        });
      }
    }

    // Cleanup old entries (>7 days) — best effort
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      await supabase
        .from("instaclaw_admin_alert_log")
        .delete()
        .lt("sent_at", weekAgo);
    } catch {
      // Non-fatal
    }

    this.pending = [];
    return { sent, skipped };
  }
}
