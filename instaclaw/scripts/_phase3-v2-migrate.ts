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
import { VM_MANIFEST } from "@/lib/vm-manifest";
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
  // vm-075 dropped 2026-05-13 — became unhealthy overnight (gateway active but /health=000).
  // Replaced with vm-310 (same tier/partner profile, healthy, V1, 54GB free, owner ari.keranen).
  "instaclaw-vm-310", // starter, no partner (REPLACEMENT FOR vm-075)
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

  // ── Acquire cron lock FIRST ──
  // Pre-flight takes ~2s; Vercel cron's gap window is <2s. If pre-flight runs before
  // lock acquisition, by the time we try to grab the lock Vercel has it back.
  // Acquiring first means pre-flight runs UNDER the lock — slightly higher cost
  // (lock held while we abort on a bad pre-flight) but eliminates the race.
  log("=== ACQUIRE CRON LOCK ===");
  const acquired = await tryAcquireCronLock("reconcile-fleet", 30 * 60, `phase3-${vmArg}-${Date.now()}`);
  if (!acquired) { log("FAIL: cron lock held"); process.exit(1); }
  log("cron lock acquired (30min)");

  // ── Pre-flight via SSH (lock now held — pre-flight failure must release) ──
  let preflightOk = false;
  try {
    log("=== PRE-FLIGHT ===");
    const ssh = new NodeSSH();
    await ssh.connect({ host: vm.ip_address, username: "openclaw", privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8"), readyTimeout: 15000 });
    const DBUS = "export XDG_RUNTIME_DIR=/run/user/$(id -u) && export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus";

    const preGw = (await ssh.execCommand(`${DBUS} && systemctl --user is-active openclaw-gateway`)).stdout.trim();
    const preHealth = (await ssh.execCommand("curl -sS -m 3 -o /dev/null -w '%{http_code}' http://localhost:18789/health")).stdout.trim();
    log(`pre gateway=${preGw} health=${preHealth}`);
    if (preGw !== "active" || preHealth !== "200") { log("FAIL: gateway not healthy"); ssh.dispose(); throw new Error("preflight-gateway"); }

    const v2Check = await ssh.execCommand("grep -l INSTACLAW_SOUL_V2 ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo NO_V2");
    if (v2Check.stdout.includes("INSTACLAW_SOUL_V2")) { log("SKIP: already V2"); ssh.dispose(); preflightOk = false; await releaseCronLock("reconcile-fleet"); process.exit(0); }
    log("confirmed V1");

    // Pre-flight inspect of existing AGENTS.md (could be user-created on V1)
    const existingAgents = await ssh.execCommand("test -f ~/.openclaw/workspace/AGENTS.md && wc -c < ~/.openclaw/workspace/AGENTS.md || echo MISSING");
    const existingAgentsSize = existingAgents.stdout.trim();
    log(`existing AGENTS.md: ${existingAgentsSize}`);
    if (existingAgentsSize !== "MISSING" && parseInt(existingAgentsSize, 10) > 0) {
      log(`WARN: AGENTS.md (${existingAgentsSize} bytes) exists on V1 VM. V2 migration WILL overwrite it. Tar backup captures it; recovery requires manual extract from workspace-pre-soul-v2-migration.tar.gz.`);
    }

    // SOUL.md custom-section inspection. stepMigrateSoulV2 only extracts `## My Identity` and
    // `## Learned Preferences`; other custom `## *` sections survive in the tar backup but
    // are dropped from the running V2 SOUL.md.
    const soulHeaders = await ssh.execCommand("grep -E '^## ' ~/.openclaw/workspace/SOUL.md 2>/dev/null | sort -u");
    log(`SOUL.md ## headers: ${soulHeaders.stdout.replace(/\n/g, ' | ')}`);

    const freeRes = await ssh.execCommand("df -BG /home/openclaw | tail -1 | awk '{print $4}' | sed 's/G//'");
    const freeGb = parseInt(freeRes.stdout.trim(), 10);
    log(`free disk: ${freeGb}GB`);
    if (freeGb < 2) { log("FAIL: <2GB free disk"); ssh.dispose(); throw new Error("preflight-disk"); }

    ssh.dispose();
    preflightOk = true;
  } catch (e: any) {
    log(`Pre-flight aborted: ${e.message}`);
    await releaseCronLock("reconcile-fleet");
    process.exit(1);
  }

  let postOk = false;
  try {
    // ── Run reconcileVM with V2 enabled + this VM whitelisted ──
    process.env.RECONCILE_SOUL_MIGRATION_ENABLED = "true";
    process.env.RECONCILE_SOUL_MIGRATION_VM_IDS = vm.id;
    log(`=== RUN reconcileVM(strict=false, dryRun=${dryRun}) ===`);
    const t0 = Date.now();
    const result = await reconcileVM(vm as any, VM_MANIFEST, { dryRun, strict: false });
    const elapsed = Math.round((Date.now() - t0) / 1000);
    log(`reconcile done in ${elapsed}s: fixed=${result.fixed.length} alreadyCorrect=${result.alreadyCorrect.length} errors=${result.errors.length}`);
    if (result.fixed.length > 0) log("  fixed items: " + result.fixed.map(f => f.slice(0, 90)).slice(0, 10).join(" | "));
    if (result.errors.length > 0) {
      log("  errors: " + result.errors.map(e => e.slice(0, 200)).join("\n           "));
      throw new Error("reconcile returned errors");
    }
    if (dryRun) { log("DRY RUN — skipping post-flight verify"); postOk = true; return; }

    // ── Post-flight verify ──
    // FIX #3: retry SSH connect once before treating connection failure as a migration fail.
    // A bare network blip during reconnect should not trigger rollback of a successful migration.
    log("=== POST-FLIGHT VERIFY ===");
    const ssh2 = new NodeSSH();
    let ssh2Connected = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await ssh2.connect({ host: vm.ip_address, username: "openclaw", privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8"), readyTimeout: 15000 });
        ssh2Connected = true;
        break;
      } catch (e: any) {
        log(`post-flight SSH connect attempt ${attempt} failed: ${e.message}`);
        if (attempt < 2) { await new Promise(r => setTimeout(r, 5000)); }
      }
    }
    if (!ssh2Connected) throw new Error("post-flight SSH connect failed twice — cannot verify, rolling back as safety measure");

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

    // FIX #2: verify tar backup exists AND has non-trivial size (>1KB).
    // A zero-byte / corrupted tar would silently fail on rollback. Validate before declaring success.
    const tarSize = (await ssh2.execCommand("stat -c '%s' ~/.openclaw/workspace-pre-soul-v2-migration.tar.gz 2>/dev/null || echo 0")).stdout.trim();
    const tarBytes = parseInt(tarSize, 10);
    log(`tar backup size: ${tarBytes} bytes`);
    if (tarBytes < 1024) throw new Error(`tar backup too small (${tarBytes} bytes) — rollback would fail; treating as migration failure`);
    // Additional sanity: tar file integrity
    const tarTest = await ssh2.execCommand("tar tzf ~/.openclaw/workspace-pre-soul-v2-migration.tar.gz > /dev/null 2>&1; echo $?");
    log(`tar integrity check: exit=${tarTest.stdout.trim()}`);
    if (tarTest.stdout.trim() !== "0") throw new Error("tar backup is corrupt — rollback would fail");

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
