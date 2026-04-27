/**
 * Phase 3 freeze dry-run — lists all VMs that would be frozen on the next
 * vm-lifecycle cron tick, with per-VM safety check evaluation.
 *
 * READ-ONLY. Does not freeze anything. Does not flip vmLifecycleV2Enabled.
 *
 * Usage:
 *   npx tsx scripts/_freeze-existing-vms.ts
 *   npx tsx scripts/_freeze-existing-vms.ts --json   # machine-readable
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.join(__dirname, "../.env.local") });
dotenv.config({ path: path.join(__dirname, "../.env.ssh-key") });

import { createClient } from "@supabase/supabase-js";
import {
  FREEZE_GRACE_SUSPENDED_DAYS,
  FREEZE_GRACE_HIBERNATING_DAYS,
  MAX_FREEZE_PER_RUN,
} from "../lib/vm-freeze-thaw";
import {
  userHasLiveSubscription,
  vmHasCredits,
  sshHasRecentActivity,
} from "../lib/vm-lifecycle-helpers";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const PROTECTED_USER_IDS = new Set([
  "afb3ae69", "4e0213b3", "24b0b73a",
]);
function isProtectedUser(userId: string): boolean {
  return Array.from(PROTECTED_USER_IDS).some((p) => userId.startsWith(p));
}

const jsonMode = process.argv.includes("--json");
const ssh = !process.argv.includes("--no-ssh");
const log = jsonMode ? () => {} : (...args: unknown[]) => console.log(...args);

interface VmRow {
  id: string;
  name: string | null;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  provider_server_id: string | null;
  assigned_to: string | null;
  health_status: string | null;
  status: string | null;
  suspended_at: string | null;
  credit_balance: number | null;
  bankr_token_address: string | null;
  region: string | null;
  lifecycle_locked_at: string | null;
  config_version: number | null;
}

interface CandidateReport {
  vmName: string;
  vmId: string;
  ip: string;
  userId: string | null;
  userEmail: string | null;
  health: string;
  daysSincePause: number;
  graceDays: number;
  pastGrace: boolean;
  decision: "WOULD_FREEZE" | "SKIP_GRACE" | "SKIP_PROTECTED" | "SKIP_LIVE_SUB" | "SKIP_CREDITS" | "SKIP_BANKR" | "SKIP_SSH_ACTIVE" | "SKIP_LOCKED";
  reason: string;
}

async function main() {
  log("═══════════════════════════════════════════════════════════════");
  log("Phase 3 FREEZE DRY-RUN — read-only");
  log(`Suspended grace:   ${FREEZE_GRACE_SUSPENDED_DAYS}d`);
  log(`Hibernating grace: ${FREEZE_GRACE_HIBERNATING_DAYS}d`);
  log(`Per-run cap:       ${MAX_FREEZE_PER_RUN} (Linode rate limit)`);
  log("═══════════════════════════════════════════════════════════════\n");

  const { data: rows, error } = await supabase
    .from("instaclaw_vms")
    .select(
      "id, name, ip_address, ssh_port, ssh_user, provider_server_id, assigned_to, credit_balance, bankr_token_address, suspended_at, status, health_status, region, lifecycle_locked_at, config_version"
    )
    .in("health_status", ["suspended", "hibernating"])
    .eq("provider", "linode")
    .eq("status", "assigned")
    .not("suspended_at", "is", null)
    .not("provider_server_id", "is", null);

  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }

  const candidates = (rows ?? []) as VmRow[];
  log(`Total candidates from DB query: ${candidates.length}\n`);

  const report: CandidateReport[] = [];

  // Pre-fetch all relevant user emails in one round trip
  const userIds = Array.from(new Set(candidates.map((c) => c.assigned_to).filter(Boolean) as string[]));
  let emailByUserId = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users } = await supabase
      .from("instaclaw_users")
      .select("id, email")
      .in("id", userIds);
    emailByUserId = new Map((users ?? []).map((u: { id: string; email: string }) => [u.id, u.email]));
  }

  let i = 0;
  for (const vm of candidates) {
    i++;
    const userEmail = vm.assigned_to ? emailByUserId.get(vm.assigned_to) ?? null : null;
    const suspendedAt = new Date(vm.suspended_at!);
    const daysSincePause = (Date.now() - suspendedAt.getTime()) / (1000 * 60 * 60 * 24);
    const graceDays = vm.health_status === "hibernating"
      ? FREEZE_GRACE_HIBERNATING_DAYS
      : FREEZE_GRACE_SUSPENDED_DAYS;
    const pastGrace = daysSincePause >= graceDays;

    log(`[${i}/${candidates.length}] ${vm.name} (${vm.ip_address}) — ${vm.health_status} ${Math.floor(daysSincePause)}d / ${graceDays}d grace`);

    const base = {
      vmName: vm.name ?? vm.id,
      vmId: vm.id,
      ip: vm.ip_address,
      userId: vm.assigned_to,
      userEmail,
      health: vm.health_status ?? "?",
      daysSincePause: Math.floor(daysSincePause),
      graceDays,
      pastGrace,
    };

    if (!pastGrace) {
      const r = `inside grace (${Math.floor(daysSincePause)}d / ${graceDays}d)`;
      log(`  → SKIP_GRACE — ${r}`);
      report.push({ ...base, decision: "SKIP_GRACE", reason: r });
      continue;
    }

    if (vm.assigned_to && isProtectedUser(vm.assigned_to)) {
      log(`  → SKIP_PROTECTED — Cooper's account`);
      report.push({ ...base, decision: "SKIP_PROTECTED", reason: "protected user" });
      continue;
    }

    if (vmHasCredits(vm.credit_balance)) {
      log(`  → SKIP_CREDITS — credit_balance=${vm.credit_balance}`);
      report.push({ ...base, decision: "SKIP_CREDITS", reason: `credit_balance=${vm.credit_balance}` });
      continue;
    }

    if (vm.bankr_token_address) {
      log(`  → SKIP_BANKR — active token ${vm.bankr_token_address.slice(0, 10)}...`);
      report.push({ ...base, decision: "SKIP_BANKR", reason: `active bankr token ${vm.bankr_token_address.slice(0, 10)}...` });
      continue;
    }

    if (vm.lifecycle_locked_at) {
      const ageMin = (Date.now() - Date.parse(vm.lifecycle_locked_at)) / 60_000;
      if (ageMin < 15) {
        log(`  → SKIP_LOCKED — ${Math.round(ageMin)}min`);
        report.push({ ...base, decision: "SKIP_LOCKED", reason: `lock age ${Math.round(ageMin)}min` });
        continue;
      }
    }

    const liveSub = vm.assigned_to ? await userHasLiveSubscription(supabase, vm.assigned_to) : false;
    if (liveSub) {
      log(`  → SKIP_LIVE_SUB — user has active/trialing Stripe sub`);
      report.push({ ...base, decision: "SKIP_LIVE_SUB", reason: "active Stripe subscription" });
      continue;
    }

    if (ssh) {
      const activity = await sshHasRecentActivity(vm.ip_address);
      if (activity.active) {
        log(`  → SKIP_SSH_ACTIVE — ${activity.reason}`);
        report.push({ ...base, decision: "SKIP_SSH_ACTIVE", reason: activity.reason });
        continue;
      }
    }

    log(`  → WOULD_FREEZE — past grace, all safety checks pass`);
    report.push({ ...base, decision: "WOULD_FREEZE", reason: "all checks pass" });
  }

  // ── Summary ──
  const wouldFreeze = report.filter((r) => r.decision === "WOULD_FREEZE");
  const summary = {
    total_candidates_from_query: candidates.length,
    would_freeze_total: wouldFreeze.length,
    cap_per_run: MAX_FREEZE_PER_RUN,
    runs_to_clear: Math.ceil(wouldFreeze.length / MAX_FREEZE_PER_RUN),
    skipped_grace: report.filter((r) => r.decision === "SKIP_GRACE").length,
    skipped_protected: report.filter((r) => r.decision === "SKIP_PROTECTED").length,
    skipped_live_sub: report.filter((r) => r.decision === "SKIP_LIVE_SUB").length,
    skipped_credits: report.filter((r) => r.decision === "SKIP_CREDITS").length,
    skipped_bankr: report.filter((r) => r.decision === "SKIP_BANKR").length,
    skipped_ssh_active: report.filter((r) => r.decision === "SKIP_SSH_ACTIVE").length,
    skipped_locked: report.filter((r) => r.decision === "SKIP_LOCKED").length,
    estimated_monthly_savings_usd: wouldFreeze.length * 28.5, // ~$29 saved per VM, ~$0.50 image cost
  };

  if (jsonMode) {
    console.log(JSON.stringify({ summary, report: report.filter((r) => r.decision === "WOULD_FREEZE") }, null, 2));
    return;
  }

  log("\n═══════════════════════════════════════════════════════════════");
  log("SUMMARY");
  log("═══════════════════════════════════════════════════════════════");
  for (const [k, v] of Object.entries(summary)) {
    log(`  ${k.padEnd(35)} ${v}`);
  }

  if (wouldFreeze.length > 0) {
    log("\nWould freeze (next cron tick will pick first 5):");
    for (let n = 0; n < wouldFreeze.length; n++) {
      const r = wouldFreeze[n];
      const marker = n < MAX_FREEZE_PER_RUN ? "→ NEXT TICK" : "  later runs";
      log(`  ${marker} ${r.vmName.padEnd(20)} ${r.ip.padEnd(16)} ${r.userEmail ?? "(no email)"} — ${r.health} ${r.daysSincePause}d`);
    }
  }

  log("\nNo freezes will execute until vmLifecycleV2Enabled is flipped to true in instaclaw_admin_settings.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
