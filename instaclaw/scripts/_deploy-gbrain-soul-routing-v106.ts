/**
 * v106 deploy script: gbrain SOUL routing block.
 *
 * Mirrors stepDeployGbrainSoulRouting from lib/vm-reconcile.ts byte-for-byte
 * (uses the SAME constants from workspace-templates-v2.ts). Lets us
 * canary vm-050 first, verify, and roll out to 8 other edge_city VMs
 * sequentially with per-VM identity-preservation verification.
 *
 * Why bypass the reconciler: tighter control + sequential ordering + faster
 * feedback than waiting for the cron's 3-min batches. After this runs
 * successfully, the v106 reconciler step is a no-op (marker present →
 * idempotent skip) and exists purely for ongoing safety + future VM
 * onboarding.
 *
 * Per-VM flow:
 *   1. Capture pre-deploy SOUL.md sha + identity-content sha (content
 *      BEFORE the `## Memory Persistence (CRITICAL)` anchor).
 *   2. Save pre-deploy SOUL.md to local backup (defense in depth on top
 *      of the reconciler's per-VM ~/.openclaw/backups/ backup).
 *   3. SSH the Python transform (same as reconciler step) with cfg JSON.
 *   4. Verify: marker present, identity sha unchanged.
 *   5. Print per-VM pass/fail.
 *
 * Usage:
 *   cd instaclaw
 *   npx tsx scripts/_deploy-gbrain-soul-routing-v106.ts vm-050             # one VM
 *   npx tsx scripts/_deploy-gbrain-soul-routing-v106.ts vm-050 vm-354 ...  # several
 *   npx tsx scripts/_deploy-gbrain-soul-routing-v106.ts --all              # all 9 edge VMs
 *   npx tsx scripts/_deploy-gbrain-soul-routing-v106.ts --dry-run vm-050   # dry run
 */

import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";
import {
  GBRAIN_SOUL_ROUTING_V1_SECTION,
  GBRAIN_SOUL_ROUTING_V1_BEGIN_MARKER,
  GBRAIN_SOUL_ROUTING_V1_KNOWN_OK_SHAS,
  GBRAIN_SOUL_ROUTING_V1_REQUIRED_SENTINELS,
  GBRAIN_SOUL_ROUTING_V1_START_ANCHOR,
  GBRAIN_SOUL_ROUTING_V1_END_ANCHOR,
} from "../lib/workspace-templates-v2";

try {
  for (const f of [
    "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
    "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
  ]) {
    const env = readFileSync(f, "utf-8");
    for (const l of env.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }
} catch {}

// ── Sentinel guard (Rule 23) — fail loudly if canonical block is broken ──
const missingSentinels = GBRAIN_SOUL_ROUTING_V1_REQUIRED_SENTINELS.filter(
  (s) => !GBRAIN_SOUL_ROUTING_V1_SECTION.includes(s),
);
if (missingSentinels.length) {
  console.error(`FATAL: canonical block missing sentinels: ${missingSentinels.join(", ")}`);
  process.exit(2);
}

const PATCH_PY = `
import base64, hashlib, json, os, sys

cfg = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))

soul_path = os.path.expanduser(cfg["soul_path"])
backup_path = os.path.expanduser(cfg["backup_path"])

def out(d):
    print(json.dumps(d))
    sys.exit(0)

if not os.path.exists(soul_path):
    out({"status": "missing"})

with open(soul_path, "r", encoding="utf-8") as f:
    content = f.read()

if cfg["begin_marker"] in content:
    out({"status": "already-present"})

start_idx = content.find(cfg["start_anchor"])
end_idx = content.find(cfg["end_anchor"])
if start_idx < 0 or end_idx < 0 or end_idx <= start_idx:
    out({
        "status": "anchors_missing",
        "start_found": start_idx >= 0,
        "end_found": end_idx >= 0,
    })

current_section = content[start_idx:end_idx]
current_sha = hashlib.sha256(current_section.encode("utf-8")).hexdigest()
if current_sha not in cfg["known_ok_shas"]:
    snippet = current_section[:200].replace("\\n", " ")
    out({
        "status": "drift_detected",
        "sha": current_sha,
        "snippet": snippet,
    })

os.makedirs(os.path.dirname(backup_path), exist_ok=True)
with open(backup_path, "w", encoding="utf-8") as f:
    f.write(content)

new_content = content[:start_idx] + cfg["canonical_section"] + content[end_idx:]

tmp = soul_path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    f.write(new_content)
os.replace(tmp, soul_path)

with open(soul_path, "r", encoding="utf-8") as f:
    final = f.read()
if cfg["begin_marker"] not in final:
    out({"status": "verify_failed", "final_size": len(final)})

out({
    "status": "ok",
    "size_before": len(content),
    "size_after": len(new_content),
    "section_sha_before": current_sha,
})
`;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function getEdgeVMs(): Promise<Array<{ name: string; ip: string }>> {
  const sb = createClient(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data } = await sb.from("instaclaw_vms")
    .select("name,ip_address")
    .eq("partner", "edge_city")
    .eq("health_status", "healthy")
    .eq("status", "assigned")
    .order("name");
  return (data ?? []).map((d) => ({ name: d.name, ip: d.ip_address }));
}

async function deployOne(name: string, ip: string, dryRun: boolean, localBackupDir: string) {
  console.log(`\n=== ${name} (${ip}) ===`);
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: ip, username: "openclaw",
      privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8"),
      readyTimeout: 12000,
    });

    // ── Step 1: pull SOUL.md, compute pre-deploy shas + identity sha ──
    const sftp: any = await new Promise((res, rej) => {
      (ssh.connection as any).sftp((err: any, s: any) => err ? rej(err) : res(s));
    });
    const remoteSoul = "/home/openclaw/.openclaw/workspace/SOUL.md";
    const localPre = `${localBackupDir}/${name}-SOUL.md.pre-v106`;
    await new Promise<void>((res, rej) => {
      sftp.fastGet(remoteSoul, localPre, (e: any) => e ? rej(e) : res());
    });
    const soulPre = readFileSync(localPre, "utf-8");
    const soulPreSha = sha256(soulPre);
    const anchorIdx = soulPre.indexOf(GBRAIN_SOUL_ROUTING_V1_START_ANCHOR);
    const identityPre = anchorIdx >= 0 ? soulPre.slice(0, anchorIdx) : soulPre;
    const identityPreSha = sha256(identityPre);
    console.log(`  pre-deploy SOUL size:    ${soulPre.length}`);
    console.log(`  pre-deploy SOUL sha:     ${soulPreSha.slice(0, 16)}`);
    console.log(`  pre-deploy identity sha: ${identityPreSha.slice(0, 16)}`);
    console.log(`  pre-deploy section anchor at: ${anchorIdx}`);

    if (anchorIdx < 0) {
      console.log(`  ✗ SKIP: section anchor not found on this VM (heavily customized SOUL.md?)`);
      ssh.dispose();
      return { name, status: "anchor_missing" };
    }

    // ── Step 2: build cfg + run Python (or dry-run) ──
    const ts = Date.now();
    const cfg = {
      soul_path: "~/.openclaw/workspace/SOUL.md",
      backup_path: `~/.openclaw/backups/v106-gbrain-soul-routing-${ts}/SOUL.md`,
      canonical_section: GBRAIN_SOUL_ROUTING_V1_SECTION,
      start_anchor: GBRAIN_SOUL_ROUTING_V1_START_ANCHOR,
      end_anchor: GBRAIN_SOUL_ROUTING_V1_END_ANCHOR,
      begin_marker: GBRAIN_SOUL_ROUTING_V1_BEGIN_MARKER,
      known_ok_shas: [...GBRAIN_SOUL_ROUTING_V1_KNOWN_OK_SHAS],
    };
    const cfgB64 = Buffer.from(JSON.stringify(cfg), "utf-8").toString("base64");

    if (dryRun) {
      console.log(`  [dry-run] would replace section, backup to ${cfg.backup_path}`);
      ssh.dispose();
      return { name, status: "dry_run" };
    }

    const scriptB64 = Buffer.from(PATCH_PY, "utf-8").toString("base64");
    const cmd = `python3 <(echo '${scriptB64}' | base64 -d) '${cfgB64}'`;
    const r = await ssh.execCommand(cmd);

    if (r.code !== 0) {
      console.log(`  ✗ FAILED: rc=${r.code} stderr=${r.stderr.slice(0, 200)}`);
      ssh.dispose();
      return { name, status: "exec_failed" };
    }

    const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] ?? "";
    let parsed: any = {};
    try { parsed = JSON.parse(lastLine); } catch {
      console.log(`  ✗ FAILED: could not parse stdout=${lastLine.slice(0, 200)}`);
      ssh.dispose();
      return { name, status: "parse_failed" };
    }
    console.log(`  python result: ${JSON.stringify(parsed)}`);

    if (parsed.status === "drift_detected") {
      console.log(`  ✗ DRIFT: observed sha=${parsed.sha.slice(0, 16)} — section was customized. SKIPPED. (Reconciler will alert.)`);
      ssh.dispose();
      return { name, status: "drift", sha: parsed.sha };
    }
    if (parsed.status !== "ok") {
      console.log(`  ✗ UNEXPECTED status: ${parsed.status}`);
      ssh.dispose();
      return { name, status: parsed.status };
    }

    // ── Step 3: pull post-deploy SOUL.md, verify marker + identity sha ──
    const localPost = `${localBackupDir}/${name}-SOUL.md.post-v106`;
    await new Promise<void>((res, rej) => {
      sftp.fastGet(remoteSoul, localPost, (e: any) => e ? rej(e) : res());
    });
    const soulPost = readFileSync(localPost, "utf-8");
    const soulPostSha = sha256(soulPost);
    const anchorPostIdx = soulPost.indexOf(GBRAIN_SOUL_ROUTING_V1_BEGIN_MARKER);
    const identityPostIdx = anchorPostIdx; // BEGIN_MARKER lives where the start anchor was
    const identityPost = identityPostIdx >= 0 ? soulPost.slice(0, identityPostIdx) : soulPost;
    const identityPostSha = sha256(identityPost);

    const markerOk = soulPost.includes(GBRAIN_SOUL_ROUTING_V1_BEGIN_MARKER);
    const identityOk = identityPostSha === identityPreSha;

    console.log(`  post-deploy SOUL size:   ${soulPost.length} (delta ${soulPost.length - soulPre.length})`);
    console.log(`  post-deploy SOUL sha:    ${soulPostSha.slice(0, 16)}`);
    console.log(`  post-deploy identity sha:${identityPostSha.slice(0, 16)} ${identityOk ? "✓ MATCH" : "✗ DRIFT"}`);
    console.log(`  marker present:          ${markerOk ? "✓" : "✗"}`);

    ssh.dispose();
    if (!markerOk || !identityOk) {
      return { name, status: "verify_failed", markerOk, identityOk };
    }
    return { name, status: "ok", sizeDelta: soulPost.length - soulPre.length };
  } catch (e: any) {
    console.log(`  ✗ FATAL: ${e.message}`);
    try { ssh.dispose(); } catch {}
    return { name, status: "exception", error: e.message };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const allFlag = args.includes("--all");
  const targets = args.filter((a) => !a.startsWith("--"));

  let vmList: Array<{ name: string; ip: string }>;
  if (allFlag) {
    vmList = await getEdgeVMs();
  } else if (targets.length > 0) {
    const allVms = await getEdgeVMs();
    vmList = targets.map((t) => {
      const found = allVms.find((v) => v.name === t || v.name === `instaclaw-${t}`);
      if (!found) {
        console.error(`Unknown VM: ${t}`);
        process.exit(2);
      }
      return found;
    });
  } else {
    console.error("Usage: ... <vm-name> [<vm-name> ...] | --all  [--dry-run]");
    process.exit(2);
  }

  console.log(`Deploying gbrain SOUL routing v106 to ${vmList.length} VM(s):`);
  for (const v of vmList) console.log(`  - ${v.name} (${v.ip})`);
  console.log(`Dry run: ${dryRun}`);

  // Local backup dir
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const localBackupDir = `/tmp/gbrain-soul-routing-v106-${ts}`;
  mkdirSync(localBackupDir, { recursive: true });
  console.log(`Local backups → ${localBackupDir}`);
  writeFileSync(
    `${localBackupDir}/canonical-section.txt`,
    GBRAIN_SOUL_ROUTING_V1_SECTION,
  );

  const results: any[] = [];
  for (const vm of vmList) {
    const r = await deployOne(vm.name, vm.ip, dryRun, localBackupDir);
    results.push(r);
    if (r.status !== "ok" && r.status !== "dry_run" && !dryRun) {
      console.log(`\n  ! Stopping at first failure. Subsequent VMs left untouched.`);
      console.log(`  ! Investigate ${vm.name}, then re-run with remaining VMs.`);
      break;
    }
  }

  console.log("\n=== Summary ===");
  for (const r of results) {
    const tag = r.status === "ok" ? "✓" : (r.status === "dry_run" ? "·" : "✗");
    console.log(`  ${tag} ${r.name}: ${r.status}`);
  }
  writeFileSync(`${localBackupDir}/summary.json`, JSON.stringify(results, null, 2));
  console.log(`\nSummary saved to ${localBackupDir}/summary.json`);

  const failures = results.filter((r) => r.status !== "ok" && r.status !== "dry_run");
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
