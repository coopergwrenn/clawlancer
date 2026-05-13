/* eslint-disable */
/**
 * Phase 3 V2 SOUL.md migration — single-VM canary runner.
 *
 * Migrates ONE specified VM from V1 → V2 (writing the trimmed AGENTS.md V2
 * template, byte-exact to vm-733's deployed sha256 0eb8d70b...). Auto-rolls
 * back via tar backup if any post-flight check fails.
 *
 * Authorization: Cooper, 2026-05-12. "start V2 Phase 3 now — pick 5 VMs across
 * different tiers and partners and deploy the trimmed AGENTS.md. monitor each
 * one after deploy ... if any VM has a problem, revert that one VM from the
 * backup and continue with the others."
 *
 * Usage:
 *   npx tsx scripts/_phase3-v2-migrate.ts --vm=instaclaw-vm-075
 *   npx tsx scripts/_phase3-v2-migrate.ts --vm=instaclaw-vm-075 --dry-run
 *
 * NEVER runs without --vm. Refuses if VM not in the explicit Phase 3 cohort.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { reconcileVM } from "@/lib/vm-reconcile";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";

// Load env from both files (Rule 18)
for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  try {
    const env = readFileSync(f, "utf-8");
    for (const l of env.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
}

const EXPECTED_AGENTS_SHA = "0eb8d70beecd6182243345b4ea5eec8295b30a37e560137325eb8d7c3d5a4979";
const COHORT = new Set([
  "instaclaw-vm-075", // starter, no partner
  "instaclaw-vm-337", // pro, no partner
  "instaclaw-vm-073", // power, no partner
  "instaclaw-vm-917", // starter, edge_city
  "instaclaw-vm-517", // pro, no partner
]);

const args = process.argv.slice(2);
const vmArg = args.find(a => a.startsWith("--vm="))?.split("=")[1];
const dryRun = args.includes("--dry-run");
if (!vmArg) { console.error("Usage: --vm=<name>"); process.exit(64); }
if (!COHORT.has(vmArg)) { console.error(`VM ${vmArg} not in Phase 3 cohort`); process.exit(64); }

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] [${vmArg}] ${msg}`);
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: vm, error } = await sb.from("instaclaw_vms").select("*").eq("name", vmArg!).single();
  if (error || !vm) { log(`Lookup failed: ${error?.message}`); process.exit(1); }
  log(`Found: ip=${vm.ip_address} cv=${vm.config_version} partner=${vm.partner} tier=${vm.tier} tg=${vm.telegram_bot_username} owner=${vm.assigned_to}`);

  // ── Pre-flight via SSH ──
  log("=== PRE-FLIGHT ===");
  const ssh = new NodeSSH();
  await ssh.connect({ host: vm.ip_address, username: "openclaw", privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8"), readyTimeout: 15000 });
  const DBUS = "export XDG_RUNTIME_DIR=/run/user/$(id -u) && export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus";

  const preGw = (await ssh.execCommand(`${DBUS} && systemctl --user is-active openclaw-gateway`)).stdout.trim();
  const preHealth = (await ssh.execCommand("curl -sS -m 3 -o /dev/null -w '%{http_code}' http://localhost:18789/health")).stdout.trim();
  log(`pre gateway=${preGw} health=${preHealth}`);
  if (preGw !== "active" || preHealth !== "200") { log("FAIL: gateway not healthy"); ssh.dispose(); process.exit(1); }

  const v2Check = await ssh.execCommand("grep -l INSTACLAW_SOUL_V2 ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo NO_V2");
  if (v2Check.stdout.includes("INSTACLAW_SOUL_V2")) { log("SKIP: already V2"); ssh.dispose(); process.exit(0); }
  log("confirmed V1");

  const freeRes = await ssh.execCommand("df -BG /home/openclaw | tail -1 | awk '{print $4}' | sed 's/G//'");
  const freeGb = parseInt(freeRes.stdout.trim(), 10);
  log(`free disk: ${freeGb}GB`);
  if (freeGb < 2) { log("FAIL: <2GB free disk"); ssh.dispose(); process.exit(1); }

  ssh.dispose();

  // ── Acquire cron lock ──
  log("=== ACQUIRE CRON LOCK ===");
  const acquired = await tryAcquireCronLock("reconcile-fleet", 30 * 60, `phase3-${vmArg}-${Date.now()}`);
  if (!acquired) { log("FAIL: cron lock held"); process.exit(1); }
  log("cron lock acquired (30min)");

  let postOk = false;
  try {
    // ── Run reconcileVM with V2 enabled + this VM whitelisted ──
    process.env.RECONCILE_SOUL_MIGRATION_ENABLED = "true";
    process.env.RECONCILE_SOUL_MIGRATION_VM_IDS = vm.id;
    log(`=== RUN reconcileVM(strict=false, dryRun=${dryRun}) ===`);
    const t0 = Date.now();
    const result = await reconcileVM(vm as any, { dryRun, strict: false } as any);
    const elapsed = Math.round((Date.now() - t0) / 1000);
    log(`reconcile done in ${elapsed}s: fixed=${result.fixed.length} alreadyCorrect=${result.alreadyCorrect.length} errors=${result.errors.length}`);
    if (result.fixed.length > 0) log("  fixed items: " + result.fixed.map(f => f.slice(0, 90)).slice(0, 10).join(" | "));
    if (result.errors.length > 0) {
      log("  errors: " + result.errors.map(e => e.slice(0, 200)).join("\n           "));
      throw new Error("reconcile returned errors");
    }
    if (dryRun) { log("DRY RUN — skipping post-flight verify"); postOk = true; return; }

    // ── Post-flight verify ──
    log("=== POST-FLIGHT VERIFY ===");
    const ssh2 = new NodeSSH();
    await ssh2.connect({ host: vm.ip_address, username: "openclaw", privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8"), readyTimeout: 15000 });

    // V2 markers on all 4 files
    const markerChecks: Record<string, string> = {};
    for (const [name, path] of [["SOUL", "~/.openclaw/workspace/SOUL.md"], ["AGENTS", "~/.openclaw/workspace/AGENTS.md"], ["TOOLS", "~/.openclaw/workspace/TOOLS.md"], ["IDENTITY", "~/.openclaw/workspace/IDENTITY.md"]] as const) {
      const r = await ssh2.execCommand(`grep -l INSTACLAW_${name}_V2 ${path} 2>/dev/null || echo NO_MARKER`);
      markerChecks[name] = r.stdout.trim().includes("NO_MARKER") ? "✗ MISSING" : "✓";
    }
    log("V2 markers: " + JSON.stringify(markerChecks));
    if (Object.values(markerChecks).some(v => v.includes("MISSING"))) throw new Error("V2 markers missing");

    // AGENTS.md sha = trimmed
    const shaRes = await ssh2.execCommand("sha256sum ~/.openclaw/workspace/AGENTS.md | awk '{print $1}'");
    const agentsSha = shaRes.stdout.trim();
    log(`AGENTS.md sha: ${agentsSha} ${agentsSha === EXPECTED_AGENTS_SHA ? "✓ trimmed" : "✗ MISMATCH"}`);
    if (agentsSha !== EXPECTED_AGENTS_SHA) throw new Error(`AGENTS sha mismatch (expected ${EXPECTED_AGENTS_SHA}, got ${agentsSha})`);

    // Tar backup
    const tar = await ssh2.execCommand("ls -la ~/.openclaw/workspace-pre-soul-v2-migration.tar.gz 2>&1 | head -1");
    log(`tar backup: ${tar.stdout.trim()}`);

    // Gateway health (Rule 5)
    let postGw = "", postHealth = "";
    for (let i = 0; i < 15; i++) {
      postGw = (await ssh2.execCommand(`${DBUS} && systemctl --user is-active openclaw-gateway`)).stdout.trim();
      postHealth = (await ssh2.execCommand("curl -sS -m 3 -o /dev/null -w '%{http_code}' http://localhost:18789/health")).stdout.trim();
      if (postGw === "active" && postHealth === "200") break;
      await new Promise(r => setTimeout(r, 2000));
    }
    log(`post gateway=${postGw} health=${postHealth}`);
    if (postGw !== "active" || postHealth !== "200") throw new Error("gateway unhealthy post-migration");

    // Smoke test
    log("=== SMOKE TEST ===");
    const smoke = await ssh2.execCommand(`
TOKEN=$(grep '^GATEWAY_TOKEN=' /home/openclaw/.openclaw/.env | cut -d= -f2)
echo '{"model":"openclaw","messages":[{"role":"user","content":"reply with just the word PONG"}]}' > /tmp/_smoke.json
curl -sS -m 90 -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data-binary "@/tmp/_smoke.json" http://localhost:18789/v1/chat/completions
rm /tmp/_smoke.json
`);
    let smokeContent = "";
    try { smokeContent = (JSON.parse(smoke.stdout) as any)?.choices?.[0]?.message?.content || ""; } catch {}
    const smokeOk = smokeContent.toUpperCase().includes("PONG");
    log(`smoke: ${smokeOk ? "✓ PONG" : "✗ no PONG"} (response: ${JSON.stringify(smokeContent).slice(0, 200)})`);
    if (!smokeOk) log("WARN: smoke didn't return PONG — gateway healthy but agent response off (non-fatal)");

    ssh2.dispose();
    postOk = true;
    log("=== POST-FLIGHT PASSED ===");
  } catch (e: any) {
    log(`!!! MIGRATION FAILED: ${e.message} — initiating rollback`);
    if (dryRun) { log("DRY RUN — skipping rollback"); }
    else {
      const sshRb = new NodeSSH();
      await sshRb.connect({ host: vm.ip_address, username: "openclaw", privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8"), readyTimeout: 15000 });
      const rb = await sshRb.execCommand(`
cd ~/.openclaw
if [ -f workspace-pre-soul-v2-migration.tar.gz ]; then
  TS=$(date +%s)
  mv workspace workspace.broken-$TS
  tar xzf workspace-pre-soul-v2-migration.tar.gz
  ${DBUS} && systemctl --user restart openclaw-gateway
  echo "ROLLBACK done"
else
  echo "ROLLBACK FAILED: no tar backup"
fi
`);
      log(`rollback output: ${rb.stdout.trim()}`);
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const a = (await sshRb.execCommand(`${DBUS} && systemctl --user is-active openclaw-gateway`)).stdout.trim();
        const h = (await sshRb.execCommand("curl -sS -m 3 -o /dev/null -w '%{http_code}' http://localhost:18789/health")).stdout.trim();
        if (a === "active" && h === "200") { log(`ROLLBACK recovered: t=${(i+1)*2}s`); break; }
      }
      sshRb.dispose();
    }
  } finally {
    await releaseCronLock("reconcile-fleet");
    log("cron lock released");
  }

  log(`=== RESULT: ${postOk ? "PASS" : "FAIL+ROLLED-BACK"} ===`);
  process.exit(postOk ? 0 : 1);
}

main().catch(e => { log(`FATAL: ${e.message}\n${e.stack}`); process.exit(2); });
