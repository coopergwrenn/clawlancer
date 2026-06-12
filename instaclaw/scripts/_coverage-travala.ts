/**
 * Coverage query for the Travala "Travel Agent" booking skill (Rule 27).
 *
 * Answers, in ~10s, "what fraction of the fleet has the booking skill on disk,
 * and what's the booking-enable + OAuth-secret state?" — the question that's
 * load-bearing during any incident on the booking path.
 *
 * Three checks:
 *   1. SSH (sampled VMs): SKILL.md + travala-search.mjs + travala-book.mjs present
 *      under ~/.openclaw/skills/travala/.
 *   2. DB: how many assigned VMs have travala_booking_enabled = true (the per-VM
 *      card toggle). Gracefully degrades if the column isn't applied yet.
 *   3. OAuth secret: TRAVALA_OAUTH_CLIENT_SECRET verifier status (shape + live mint).
 *
 * PRE-DEPLOY (P2): the skill isn't on the fleet yet, so "absent everywhere" is the
 * EXPECTED state — the script reports informationally and exits 0. After P3 fleet
 * rollout, run with --expect-deployed to make absence a hard failure (exit 1).
 *
 * Run: `npx tsx scripts/_coverage-travala.ts`
 *   --sample N        : SSH sample size (default 5)
 *   --all             : SSH-probe every healthy+assigned VM (slow)
 *   --expect-deployed : treat skill-absent as FAIL (post-P3 audit mode)
 *
 * PRD: instaclaw/docs/prd/travala-x402-booking-2026-06-10.md §14-I.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // env file optional
  }
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SSH_KEY_B64 = process.env.SSH_PRIVATE_KEY_B64;
if (!SSH_KEY_B64) {
  console.error("FATAL: SSH_PRIVATE_KEY_B64 not set; need .env.ssh-key");
  process.exit(2);
}
const SSH_KEY = Buffer.from(SSH_KEY_B64, "base64").toString("utf-8");

const argv = process.argv.slice(2);
const sampleArg = argv.find((a) => a.startsWith("--sample="));
const SAMPLE = sampleArg ? parseInt(sampleArg.split("=")[1], 10) : 5;
const ALL = argv.includes("--all");
const EXPECT_DEPLOYED = argv.includes("--expect-deployed");

type ProbeResult = {
  name: string;
  ip: string;
  status: "PASS" | "FAIL" | "ERROR";
  detail: string;
};

const SKILL_DIR = "~/.openclaw/skills/travala";

async function probe(name: string, ip: string): Promise<ProbeResult> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: ip, username: "openclaw", privateKey: SSH_KEY, readyTimeout: 8000, tryKeyboard: false });
    // 3 expected artifacts; echo a digit per present file.
    const r = await ssh.execCommand(
      `s=0; ` +
        `[ -f ${SKILL_DIR}/SKILL.md ] && s=$((s+1)); ` +
        `[ -f ${SKILL_DIR}/scripts/travala-book.mjs ] && s=$((s+4)); ` +
        `[ -f ${SKILL_DIR}/scripts/travala-search.mjs ] && s=$((s+2)); ` +
        `echo $s`,
    );
    ssh.dispose();
    const bits = parseInt(r.stdout.trim(), 10);
    if (Number.isNaN(bits)) return { name, ip, status: "ERROR", detail: `parse-fail: ${r.stdout.slice(0, 60)}` };
    const skill = !!(bits & 1), book = !!(bits & 4), search = !!(bits & 2);
    if (skill && book && search) return { name, ip, status: "PASS", detail: "skill+book+search" };
    if (bits === 0) return { name, ip, status: "FAIL", detail: "not deployed" };
    return { name, ip, status: "FAIL", detail: `partial: skill=${skill} book=${book} search=${search}` };
  } catch (err) {
    try { ssh.dispose(); } catch { /* noop */ }
    return { name, ip, status: "ERROR", detail: String(err).slice(0, 100) };
  }
}

async function main() {
  console.log(`\n=== Travala booking-skill coverage — ${new Date().toISOString()} ===`);
  console.log(EXPECT_DEPLOYED ? "(mode: --expect-deployed — absence is FAIL)\n" : "(mode: informational — pre-P3 deploy; absence is expected)\n");

  // ── 1. SSH presence sample ──
  const { data, error } = await sb
    .from("instaclaw_vms")
    .select("name,ip_address")
    .eq("status", "assigned")
    .eq("health_status", "healthy")
    .not("ip_address", "is", null);
  if (error) { console.error(`Supabase error: ${error.message}`); process.exit(2); }
  const candidates = (data ?? []).filter((v) => v.ip_address);

  let results: ProbeResult[] = [];
  if (candidates.length === 0) {
    console.log("No healthy + assigned VMs with ip_address — skipping SSH probe.\n");
  } else {
    const picks = ALL ? candidates : [...candidates].sort(() => Math.random() - 0.5).slice(0, Math.min(SAMPLE, candidates.length));
    console.log(`Population: ${candidates.length} healthy+assigned VMs. SSH-probing ${picks.length} (${ALL ? "ALL" : `sample ${SAMPLE}`}).\n`);
    results = await Promise.all(picks.map((v) => probe(v.name!, v.ip_address!)));
    const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
    console.log(pad("VM", 22) + pad("IP", 18) + pad("STATUS", 8) + "DETAIL");
    console.log("-".repeat(70));
    for (const r of results.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(pad(r.name, 22) + pad(r.ip, 18) + pad(r.status, 8) + r.detail);
    }
    const pass = results.filter((r) => r.status === "PASS").length;
    const fail = results.filter((r) => r.status === "FAIL").length;
    const err = results.filter((r) => r.status === "ERROR").length;
    console.log(`\nSSH summary: ${pass} PASS / ${fail} FAIL / ${err} ERROR  (of ${results.length})\n`);
  }

  // ── 2. DB: per-VM booking-enable count (graceful if column not applied) ──
  let enabledCount: number | null = null;
  try {
    const { count, error: cErr } = await sb
      .from("instaclaw_vms")
      .select("id", { count: "exact", head: true })
      .eq("status", "assigned")
      .eq("travala_booking_enabled", true);
    if (cErr) throw cErr;
    enabledCount = count ?? 0;
  } catch (e) {
    console.log(`DB: travala_booking_enabled count unavailable (${String((e as Error).message).slice(0, 80)})`);
    console.log("    → likely the column migration isn't applied yet (pending_migrations/20260610190000_vm_travala_booking_enabled.sql).\n");
  }
  if (enabledCount !== null) {
    console.log(`DB: ${enabledCount} assigned VM(s) have travala_booking_enabled = true.\n`);
  }

  // ── 3. Global emergency kill switch state ──
  try {
    const { data: ks } = await sb
      .from("instaclaw_admin_settings")
      .select("bool_value")
      .eq("setting_key", "travala_booking_kill_switch")
      .maybeSingle();
    console.log(`Global kill switch (travala_booking_kill_switch): ${ks?.bool_value === true ? "ENGAGED (all bookings halted)" : "not engaged"}\n`);
  } catch {
    console.log("Global kill switch: row absent (not engaged — safe default).\n");
  }

  // ── 4. OAuth secret state (shape + live mint, best-effort) ──
  try {
    const { mintTravalaToken } = await import("../lib/travala-mcp");
    const secret = process.env.TRAVALA_OAUTH_CLIENT_SECRET;
    if (!secret) {
      console.log("OAuth secret: TRAVALA_OAUTH_CLIENT_SECRET not set in this env (set in Vercel prod for the live path).");
    } else {
      const r = await mintTravalaToken("mcp:read mcp:book", secret);
      console.log(`OAuth secret: mint smoke test → ${r.ok ? "OK (mcp:book token minted)" : `${r.status}${r.http_code ? ` http=${r.http_code}` : ""}`}`);
    }
  } catch (e) {
    console.log(`OAuth secret: verifier unavailable (${String((e as Error).message).slice(0, 80)})`);
  }
  console.log();

  // ── Exit code ──
  const sshFails = results.filter((r) => r.status === "FAIL").length;
  if (EXPECT_DEPLOYED && sshFails > 0) {
    console.error(`✗ ${sshFails} sampled VM(s) missing the booking skill. After P3, the reconciler's extraSkillFiles + file-drift should heal; if persistent, re-run the deploy.`);
    process.exit(1);
  }
  console.log(EXPECT_DEPLOYED ? "✓ All sampled VMs have the booking skill." : "✓ Informational run complete (pre-P3 deploy).");
  process.exit(0);
}

main().catch((err) => { console.error("FATAL:", err); process.exit(2); });
