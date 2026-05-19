/**
 * Force-deploy EDGE_INSTACLAW_OVERLAY_MD to all edge_city VMs immediately,
 * bypassing the reconcile-fleet cron's batched candidate-pull queue.
 *
 * Use case: pre-launch, when a copy fix needs to land on the 9 edge VMs
 * within minutes (not hours). The reconciler runs at CONFIG_AUDIT_BATCH_SIZE=1
 * per 3-min tick — slow for time-sensitive copy fixes.
 *
 * This script mirrors the logic in stepDeployEdgeOverlay() at
 * lib/vm-reconcile.ts:8126 exactly:
 *   - Same source-of-truth (EDGE_INSTACLAW_OVERLAY_MD from
 *     lib/partner-content.ts) — no copy-paste of content
 *   - SHA-verified: skips VMs already at expected sha
 *   - Atomic write: .tmp + mv (no half-written file ever observable)
 *   - Post-write verify: re-reads sha and compares before claiming success
 *   - Idempotent: safe to re-run; collapses to "already-correct" on every
 *     VM the second time
 *
 * Safety guards:
 *   - Only targets partner=edge_city AND status=assigned AND health=healthy
 *   - Skips VMs whose ~/.openclaw/skills/edge-esmeralda/ dir doesn't exist
 *     (Rule 39 — warning, not error, so script doesn't bail on one stragler)
 *   - Backs up the previous file to ~/cron-backups/INSTACLAW_OVERLAY.md.<ts>.bak
 *     on the VM before overwriting (manual rollback path)
 *   - Atomic. Connection drops mid-call leave the file at the OLD content,
 *     not corrupted
 *
 * Usage:
 *   tsx scripts/_force-edge-overlay-deploy.ts --dry-run   # report only
 *   tsx scripts/_force-edge-overlay-deploy.ts             # actually deploy
 *
 * Exits 0 if all VMs end at expected sha; non-zero otherwise.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import crypto from "crypto";
import { connectSSH } from "../lib/ssh";
import { EDGE_INSTACLAW_OVERLAY_MD } from "../lib/partner-content";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env.ssh-key") });

const REMOTE_PATH = "/home/openclaw/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md";

interface VmRow {
  id: string;
  name: string;
  ip_address: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  partner: string | null;
  health_status: string | null;
  status: string | null;
}

interface Result {
  vm: string;
  ip: string;
  before_sha: string;
  after_sha: string;
  status: "deployed" | "already-correct" | "skill-dir-missing" | "failed";
  detail?: string;
}

async function deployOne(vm: VmRow, expectedSha: string, expectedB64: string, dryRun: boolean): Promise<Result> {
  if (!vm.ip_address) return { vm: vm.name, ip: "?", before_sha: "—", after_sha: "—", status: "failed", detail: "no ip_address" };

  const ssh = await connectSSH(vm);
  try {
    // ── Pre-check: skill dir must exist ──
    const dirCheck = await ssh.execCommand(
      `[ -d /home/openclaw/.openclaw/skills/edge-esmeralda ] && echo OK || echo MISSING`
    );
    if ((dirCheck.stdout || "").trim() !== "OK") {
      return { vm: vm.name, ip: vm.ip_address, before_sha: "—", after_sha: "—", status: "skill-dir-missing",
               detail: "~/.openclaw/skills/edge-esmeralda/ does not exist — clone may have failed; agent works without overlay" };
    }

    // ── Read current sha ──
    const existing = await ssh.execCommand(
      `[ -f ${REMOTE_PATH} ] && sha256sum ${REMOTE_PATH} | awk '{print $1}' || echo MISSING`
    );
    const beforeSha = (existing.stdout || "").trim();

    if (beforeSha === expectedSha) {
      return { vm: vm.name, ip: vm.ip_address, before_sha: beforeSha.slice(0, 12), after_sha: beforeSha.slice(0, 12), status: "already-correct" };
    }

    if (dryRun) {
      return { vm: vm.name, ip: vm.ip_address, before_sha: beforeSha.slice(0, 12), after_sha: expectedSha.slice(0, 12), status: "deployed",
               detail: "[dry-run] would deploy" };
    }

    // ── Backup + atomic write + verify (mirrors stepDeployEdgeOverlay) ──
    // Step 1: backup the old file (in case we need to investigate "what changed")
    if (beforeSha !== "MISSING" && beforeSha.length === 64) {
      await ssh.execCommand(
        `mkdir -p ~/cron-backups && cp ${REMOTE_PATH} ~/cron-backups/INSTACLAW_OVERLAY.md.$(date +%s).bak`
      );
    }

    // Step 2: atomic write via .tmp + mv (so a connection drop never leaves a half-written file)
    const write = await ssh.execCommand(
      `echo '${expectedB64}' | base64 -d > ${REMOTE_PATH}.tmp && mv ${REMOTE_PATH}.tmp ${REMOTE_PATH} && chmod 0644 ${REMOTE_PATH}`
    );
    if (write.code !== 0) {
      return { vm: vm.name, ip: vm.ip_address, before_sha: beforeSha.slice(0, 12), after_sha: "—", status: "failed",
               detail: `write failed: ${(write.stderr || write.stdout).slice(0, 200)}` };
    }

    // Step 3: re-read sha and verify (Rule 10 — verify after every config-set-equivalent write)
    const verify = await ssh.execCommand(`sha256sum ${REMOTE_PATH} | awk '{print $1}'`);
    const afterSha = (verify.stdout || "").trim();
    if (afterSha !== expectedSha) {
      return { vm: vm.name, ip: vm.ip_address, before_sha: beforeSha.slice(0, 12), after_sha: afterSha.slice(0, 12), status: "failed",
               detail: `verify mismatch: wrote ${expectedSha.slice(0, 12)} but on-disk reads ${afterSha.slice(0, 12)}` };
    }
    return { vm: vm.name, ip: vm.ip_address, before_sha: beforeSha.slice(0, 12), after_sha: afterSha.slice(0, 12), status: "deployed" };
  } finally {
    ssh.dispose();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const expectedSha = crypto.createHash("sha256").update(EDGE_INSTACLAW_OVERLAY_MD).digest("hex");
  const expectedB64 = Buffer.from(EDGE_INSTACLAW_OVERLAY_MD, "utf-8").toString("base64");
  console.log(`Expected sha:    ${expectedSha.slice(0, 16)}…`);
  console.log(`Expected bytes:  ${Buffer.byteLength(EDGE_INSTACLAW_OVERLAY_MD, "utf-8")}`);
  console.log(`Mode:            ${dryRun ? "DRY-RUN (no changes)" : "LIVE (will write atomic + verify)"}`);
  console.log("");

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const { data, error } = await sb.from("instaclaw_vms")
    .select("*")
    .eq("partner", "edge_city")
    .eq("status", "assigned")
    .eq("health_status", "healthy")
    .order("name");
  if (error) { console.error("supabase err:", error.message); process.exit(2); }
  const vms = (data ?? []) as VmRow[];

  console.log(`Targets: ${vms.length} edge_city VMs`);
  console.log("");
  console.log("vm".padEnd(22) + "ip".padEnd(18) + "before_sha".padEnd(14) + "after_sha".padEnd(14) + "status");
  console.log("─".repeat(80));

  const results: Result[] = [];
  for (const vm of vms) {
    process.stdout.write(`${vm.name.padEnd(22)}`);
    try {
      const r = await deployOne(vm, expectedSha, expectedB64, dryRun);
      results.push(r);
      console.log(
        `${(r.ip || "?").padEnd(18)}${(r.before_sha || "—").padEnd(14)}${(r.after_sha || "—").padEnd(14)}${r.status}` +
        (r.detail ? `  (${r.detail})` : "")
      );
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      results.push({ vm: vm.name, ip: vm.ip_address || "?", before_sha: "—", after_sha: "—", status: "failed", detail });
      console.log(`${(vm.ip_address || "?").padEnd(18)}—             —             ✗ ${detail.slice(0, 60)}`);
    }
  }

  console.log("");
  console.log("─".repeat(80));
  const deployed = results.filter((r) => r.status === "deployed").length;
  const correct = results.filter((r) => r.status === "already-correct").length;
  const missing = results.filter((r) => r.status === "skill-dir-missing").length;
  const failed = results.filter((r) => r.status === "failed").length;
  console.log(`SUMMARY: deployed=${deployed} already-correct=${correct} skill-dir-missing=${missing} failed=${failed}${dryRun ? " (dry-run)" : ""}`);

  if (failed > 0) {
    console.log("");
    console.log("FAILURES:");
    for (const r of results.filter((r) => r.status === "failed")) {
      console.log(`  ${r.vm}: ${r.detail}`);
    }
    process.exit(1);
  }
  if (missing > 0) {
    console.log("");
    console.log(`⚠ ${missing} VM(s) missing the skill dir — overlay can't deploy without it (clone failure?):`);
    for (const r of results.filter((r) => r.status === "skill-dir-missing")) {
      console.log(`  ${r.vm} (${r.ip})`);
    }
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(99); });
