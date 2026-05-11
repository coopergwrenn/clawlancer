/**
 * Canary fast-track for the v92 SOUL.md partner-stub migration.
 *
 * What it does (per VM):
 *   1. Read SOUL.md current size + content
 *   2. Run the SAME Python script that stepRewriteSoulPartnerSections runs,
 *      with the SAME config (backup path, stubs, markers)
 *   3. Report status (patched / already-patched / old-not-found / verify-failed)
 *   4. Write INSTACLAW_OVERLAY.md for edge_city VMs (sha-verified)
 *   5. Verify final SOUL.md size + presence of markers
 *   6. Optionally bump cv to 92 in DB (with --bump-cv flag)
 *
 * This is a CANARY validation tool, not a replacement for the reconciler.
 * Use to verify the migration works on one VM before relying on natural cron.
 *
 * Usage:
 *   npx tsx scripts/_canary-v92-soul-stub.ts --vm instaclaw-vm-354 --dry-run
 *   npx tsx scripts/_canary-v92-soul-stub.ts --vm instaclaw-vm-354
 *   npx tsx scripts/_canary-v92-soul-stub.ts --vm instaclaw-vm-354 --bump-cv
 */
import * as path from "path";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { connectSSH } from "../lib/ssh";
import {
  SOUL_STUB_EDGE,
  SOUL_STUB_CONSENSUS,
  SOUL_STUB_EDGE_MARKER,
  SOUL_STUB_CONSENSUS_MARKER,
  PARTNER_V80_MARKER,
  EDGE_INSTACLAW_OVERLAY_MD,
} from "../lib/partner-content";
import { BOOTSTRAP_MAX_CHARS } from "../lib/vm-manifest";
require("dotenv").config({ path: path.join(__dirname, "..", ".env.ssh-key") });

const PATCH_PY = `import json, os, re, sys

cfg = json.loads(sys.stdin.read())
path = os.path.expanduser(cfg["soul_path"])

def out(d):
    print(json.dumps(d))
    sys.exit(0)

if not os.path.exists(path):
    out({"status": "missing"})

with open(path) as f:
    content = f.read()
original = content

# Rule 22 backup BEFORE any modification.
if cfg.get("backup_path"):
    bp = os.path.expanduser(cfg["backup_path"])
    os.makedirs(os.path.dirname(bp), exist_ok=True)
    with open(bp, "w") as f:
        f.write(original)

def replace_section(text, old_header, new_section, new_marker):
    # v93: APPEND when section missing (not "old-not-found" skip).
    # See lib/vm-reconcile.ts replace_or_append_section for rationale.
    if new_marker in text:
        return text, "already-patched"
    pat = re.compile(r'^## ' + re.escape(old_header) + r'\\s*$', re.MULTILINE)
    m = pat.search(text)
    if not m:
        return text.rstrip() + new_section, "appended"
    start = m.start()
    after = text[m.end():]
    nxt = re.search(r'^## ', after, re.MULTILINE)
    end = m.end() + nxt.start() if nxt else len(text)
    return text[:start] + new_section + text[end:], "patched"

edge_status = "skipped"
if cfg["apply_edge"]:
    content, edge_status = replace_section(
        content, "Edge Esmeralda 2026",
        cfg["edge_stub"], cfg["edge_marker"],
    )

cons_status = "skipped"
if cfg["apply_consensus"]:
    content, cons_status = replace_section(
        content, "Consensus 2026 Miami",
        cfg["consensus_stub"], cfg["consensus_marker"],
    )

if content != original:
    tmp = path + ".v92patch.tmp"
    with open(tmp, "w") as f:
        f.write(content)
    os.rename(tmp, path)

with open(path) as f:
    final = f.read()
edge_should_have_marker = cfg["apply_edge"] and edge_status in ("patched", "appended")
cons_should_have_marker = cfg["apply_consensus"] and cons_status in ("patched", "appended")
if edge_should_have_marker and cfg["edge_marker"] not in final:
    out({"status": "verify-failed-edge", "edge": edge_status, "consensus": cons_status})
if cons_should_have_marker and cfg["consensus_marker"] not in final:
    out({"status": "verify-failed-consensus", "edge": edge_status, "consensus": cons_status})

out({
    "status": "ok",
    "edge": edge_status,
    "consensus": cons_status,
    "size_bytes": len(final),
    "v80_marker_present": cfg["v80_marker"] in final,
    "over_budget": len(final) > cfg["budget"],
})
`;

function parseArgs() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const bumpCv = argv.includes("--bump-cv");
  const vmIdx = argv.indexOf("--vm");
  const vmName = vmIdx >= 0 ? argv[vmIdx + 1] : null;
  return { dryRun, bumpCv, vmName };
}

(async () => {
  const { dryRun, bumpCv, vmName } = parseArgs();
  if (!vmName) {
    console.error("Usage: --vm <name> [--dry-run] [--bump-cv]");
    process.exit(1);
  }

  const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: vm } = await s.from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, partner, config_version, status")
    .eq("name", vmName)
    .single();
  if (!vm) {
    console.error(`VM ${vmName} not found`);
    process.exit(1);
  }
  if (vm.status !== "assigned") {
    console.error(`VM ${vmName} status=${vm.status}, expected 'assigned'`);
    process.exit(1);
  }
  if (vm.partner !== "edge_city" && vm.partner !== "consensus_2026") {
    console.error(`VM ${vmName} partner=${vm.partner}, not a partner VM — v92 step would no-op`);
    process.exit(1);
  }
  console.log(`Target: ${vm.name} (cv=${vm.config_version} partner=${vm.partner} ip=${vm.ip_address})`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "WRITE"}${bumpCv ? " + bump-cv" : ""}`);

  const applyEdge = vm.partner === "edge_city";
  const applyConsensus = vm.partner === "edge_city" || vm.partner === "consensus_2026";

  const ssh = await connectSSH({
    ip_address: vm.ip_address,
    ssh_port: vm.ssh_port ?? 22,
    ssh_user: vm.ssh_user ?? "openclaw",
  });

  try {
    // Pre-state
    const preSize = await ssh.execCommand("wc -c < ~/.openclaw/workspace/SOUL.md");
    console.log(`\n--- Pre-state ---`);
    console.log(`  SOUL.md size: ${preSize.stdout.trim()} bytes (budget: ${BOOTSTRAP_MAX_CHARS})`);
    const preHasEdge = await ssh.execCommand("grep -c '^## Edge Esmeralda 2026' ~/.openclaw/workspace/SOUL.md || true");
    const preHasCons = await ssh.execCommand("grep -c '^## Consensus 2026 Miami' ~/.openclaw/workspace/SOUL.md || true");
    const preHasV80 = await ssh.execCommand(`grep -c "${PARTNER_V80_MARKER}" ~/.openclaw/workspace/SOUL.md || true`);
    const preHasOverlay = await ssh.execCommand("[ -f ~/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md ] && echo YES || echo NO");
    console.log(`  edge section: ${preHasEdge.stdout.trim()}, consensus section: ${preHasCons.stdout.trim()}, v80 marker: ${preHasV80.stdout.trim()}, overlay file: ${preHasOverlay.stdout.trim()}`);

    if (dryRun) {
      console.log("\n--- DRY-RUN: not executing ---");
      return;
    }

    // Run the SAME Python the reconciler runs
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const cfg = JSON.stringify({
      soul_path: "~/.openclaw/workspace/SOUL.md",
      backup_path: `~/.openclaw/backups/v92-canary-${ts}/SOUL.md`,
      apply_edge: applyEdge,
      apply_consensus: applyConsensus,
      edge_stub: SOUL_STUB_EDGE,
      consensus_stub: SOUL_STUB_CONSENSUS,
      edge_marker: SOUL_STUB_EDGE_MARKER,
      consensus_marker: SOUL_STUB_CONSENSUS_MARKER,
      v80_marker: PARTNER_V80_MARKER,
      budget: BOOTSTRAP_MAX_CHARS,
    });
    const scriptB64 = Buffer.from(PATCH_PY, "utf-8").toString("base64");
    const cfgB64 = Buffer.from(cfg, "utf-8").toString("base64");
    const cmd = `echo '${cfgB64}' | base64 -d | python3 <(echo '${scriptB64}' | base64 -d)`;

    console.log(`\n--- Running Python in-place edit ---`);
    const r = await ssh.execCommand(cmd, { execOptions: { timeout: 30_000 } });
    if (r.code !== 0) {
      console.error(`Python failed rc=${r.code}:\nstderr: ${r.stderr}\nstdout: ${r.stdout}`);
      process.exit(1);
    }
    const lines = r.stdout.split("\n").map(l => l.trim()).filter(Boolean);
    const result = JSON.parse(lines[lines.length - 1]);
    console.log(`  Python result: ${JSON.stringify(result, null, 2)}`);

    // Deploy INSTACLAW_OVERLAY.md for edge_city
    if (applyEdge) {
      console.log(`\n--- Deploying INSTACLAW_OVERLAY.md ---`);
      const expectedSha = createHash("sha256").update(EDGE_INSTACLAW_OVERLAY_MD).digest("hex");
      const dirCheck = await ssh.execCommand("[ -d ~/.openclaw/skills/edge-esmeralda ] && echo OK || echo MISSING");
      if (dirCheck.stdout.trim() !== "OK") {
        console.error("  edge-esmeralda skill dir missing — clone may have failed upstream");
        process.exit(1);
      }
      const b64 = Buffer.from(EDGE_INSTACLAW_OVERLAY_MD, "utf-8").toString("base64");
      const remotePath = "/home/openclaw/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md";
      const write = await ssh.execCommand(`echo '${b64}' | base64 -d > ${remotePath}.tmp && mv ${remotePath}.tmp ${remotePath} && chmod 0644 ${remotePath}`);
      if (write.code !== 0) {
        console.error(`  overlay write failed: ${write.stderr || write.stdout}`);
        process.exit(1);
      }
      const verify = await ssh.execCommand(`sha256sum ${remotePath} | awk '{print $1}'`);
      const verifySha = verify.stdout.trim();
      if (verifySha !== expectedSha) {
        console.error(`  overlay sha mismatch: expected=${expectedSha.slice(0,12)} got=${verifySha.slice(0,12)}`);
        process.exit(1);
      }
      console.log(`  ✓ INSTACLAW_OVERLAY.md deployed (sha=${expectedSha.slice(0,12)})`);
    }

    // Post-state
    console.log(`\n--- Post-state ---`);
    const postSize = await ssh.execCommand("wc -c < ~/.openclaw/workspace/SOUL.md");
    const postHasEdge = await ssh.execCommand("grep -c '^## Edge Esmeralda 2026' ~/.openclaw/workspace/SOUL.md || true");
    const postHasCons = await ssh.execCommand("grep -c '^## Consensus 2026 Miami' ~/.openclaw/workspace/SOUL.md || true");
    const postHasV80 = await ssh.execCommand(`grep -c "${PARTNER_V80_MARKER}" ~/.openclaw/workspace/SOUL.md || true`);
    const postHasEdgeMarker = await ssh.execCommand(`grep -c "${SOUL_STUB_EDGE_MARKER.slice(0, 40)}" ~/.openclaw/workspace/SOUL.md || true`);
    const postHasOverlay = await ssh.execCommand("[ -f ~/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md ] && sha256sum ~/.openclaw/skills/edge-esmeralda/INSTACLAW_OVERLAY.md | awk '{print $1}' || echo MISSING");
    const backupCheck = await ssh.execCommand(`ls -la ~/.openclaw/backups/v92-canary-${ts}/SOUL.md 2>/dev/null || echo NO-BACKUP`);

    console.log(`  SOUL.md size: ${postSize.stdout.trim()} bytes (was ${preSize.stdout.trim()})`);
    console.log(`  edge section count: ${postHasEdge.stdout.trim()}, consensus section count: ${postHasCons.stdout.trim()}`);
    console.log(`  v80 markers: ${postHasV80.stdout.trim()}, edge-stub marker substring: ${postHasEdgeMarker.stdout.trim()}`);
    console.log(`  INSTACLAW_OVERLAY.md sha: ${postHasOverlay.stdout.trim().slice(0, 16)}...`);
    console.log(`  Backup file: ${backupCheck.stdout.trim()}`);

    if (bumpCv) {
      console.log(`\n--- Bumping cv ${vm.config_version} → 92 in DB ---`);
      const { error } = await s.from("instaclaw_vms").update({ config_version: 92 }).eq("id", vm.id);
      if (error) {
        console.error(`  DB update failed: ${error.message}`);
      } else {
        console.log(`  ✓ cv=92`);
      }
    } else {
      console.log(`\n(Skipping cv bump — pass --bump-cv to update DB to v92)`);
    }
  } finally {
    ssh.dispose();
  }
})();
