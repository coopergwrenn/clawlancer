/**
 * One-shot remediation for the 15 half-installed canary VMs (post 2026-05-19
 * Bug A+F discovery). Retrofits Phase C2 (patch) + Phase I (cron + ExecStop)
 * deliverables that install-gbrain.sh silently skipped because the TS
 * reconciler didn't upload the companion files.
 *
 * Why a one-shot vs reconciler-rerun:
 *   - The 15 active cohort VMs are at cv=108 (current manifest). The
 *     reconciler's `lt(config_version, manifest.version)` filter excludes
 *     them from the candidate pool. They can't naturally re-run stepGbrain
 *     until manifest bumps.
 *   - File-drift cron will deploy the updated vm-watchdog.py (Bug B fix)
 *     but doesn't run stepGbrain. So the cron is no help for retrofitting
 *     pglite-checkpoint.sh + the patch.
 *   - We could cv-decrement all 15 to force re-reconcile, but that's
 *     heavier (re-runs all reconciler steps for each VM, ~3-5 min/VM
 *     fleet-wide) and depends on the reconciler's candidate-pool ordering.
 *
 * Per-VM flow (mirrors install-gbrain.sh Phase C2 + Phase I exactly):
 *   1. Upload pglite-checkpoint.sh to /tmp/
 *   2. Upload 0001-add-checkpoint-mcp-tool.patch to /tmp/
 *   3. Apply patch to ~/gbrain/ (idempotent — already-applied is OK)
 *   4. Restart gbrain.service so it picks up the new src/core/checkpoint-operation.ts
 *   5. Install cron script to ~/.openclaw/scripts/pglite-checkpoint.sh
 *   6. Add crontab entry (idempotent)
 *   7. Install 20-execstop-checkpoint.conf systemd drop-in
 *   8. daemon-reload (so the drop-in takes effect)
 *   9. Test-run the checkpoint script to seed pg_control freshness
 *  10. Verify: cron in crontab, drop-in present, last log entry "ok"
 *
 * Usage:
 *   cd instaclaw
 *   npx tsx scripts/_remediate-phase-c2-and-i.ts --dry-run   # preview
 *   npx tsx scripts/_remediate-phase-c2-and-i.ts             # run for real
 *   npx tsx scripts/_remediate-phase-c2-and-i.ts vm-733      # one VM
 *
 * Defaults: the 15 ACTIVE canary VMs (with gbrain.service active).
 * The 2 NEVER-installed (vm-602, vm-634) need full reinstall — handled
 * separately via cv-decrement → reconciler picks them up with the new
 * upload paths.
 */

import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";
import {
  PGLITE_CHECKPOINT_SH,
  GBRAIN_CHECKPOINT_PATCH,
} from "../lib/gbrain-scripts-content";

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

// 15 active cohort VMs (cohort minus vm-602 and vm-634 which never installed)
const ACTIVE_COHORT = [
  "instaclaw-vm-073", "instaclaw-vm-295", "instaclaw-vm-320", "instaclaw-vm-517",
  "instaclaw-vm-561", "instaclaw-vm-733", "instaclaw-vm-855", "instaclaw-vm-872",
  "instaclaw-vm-880", "instaclaw-vm-893", "instaclaw-vm-904", "instaclaw-vm-912",
  "instaclaw-vm-913", "instaclaw-vm-929", "instaclaw-vm-935",
];

interface RemediateResult {
  name: string;
  ip: string;
  ok: boolean;
  steps: string[];
  errors: string[];
}

async function remediateOne(ip: string, name: string, dryRun: boolean): Promise<RemediateResult> {
  const result: RemediateResult = { name, ip, ok: false, steps: [], errors: [] };
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: ip, username: "openclaw",
      privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8"),
      readyTimeout: 15_000,
    });

    if (dryRun) {
      // Just probe current state
      const probe = await ssh.execCommand(
        "ls ~/.openclaw/scripts/pglite-checkpoint.sh 2>/dev/null | wc -l; " +
        "crontab -l 2>/dev/null | grep -c pglite-checkpoint; " +
        "ls ~/.config/systemd/user/gbrain.service.d/20-execstop-checkpoint.conf 2>/dev/null | wc -l; " +
        "test -f ~/gbrain/src/core/checkpoint-operation.ts && echo PATCHED || echo NOT_PATCHED",
      );
      result.steps.push(`probe: ${probe.stdout.replace(/\n/g, " | ")}`);
      result.ok = true;
      ssh.dispose();
      return result;
    }

    // Step 1+2: upload pglite-checkpoint.sh + patch
    const upScript = await ssh.execCommand(
      "cat > /tmp/pglite-checkpoint.sh && chmod +x /tmp/pglite-checkpoint.sh",
      { stdin: PGLITE_CHECKPOINT_SH },
    );
    if (upScript.code !== 0) {
      result.errors.push(`upload script failed: ${upScript.stderr.slice(0, 200)}`);
      ssh.dispose();
      return result;
    }
    result.steps.push("upload pglite-checkpoint.sh → /tmp/");

    const upPatch = await ssh.execCommand(
      "cat > /tmp/0001-add-checkpoint-mcp-tool.patch",
      { stdin: GBRAIN_CHECKPOINT_PATCH },
    );
    if (upPatch.code !== 0) {
      result.errors.push(`upload patch failed: ${upPatch.stderr.slice(0, 200)}`);
      ssh.dispose();
      return result;
    }
    result.steps.push("upload patch → /tmp/");

    // Step 3: apply patch (idempotent — Phase C2 idempotency logic)
    const applyPatch = await ssh.execCommand(`
cd $HOME/gbrain
HAS_FILE=0
HAS_IMPORT=0
[ -f "$HOME/gbrain/src/core/checkpoint-operation.ts" ] && HAS_FILE=1
grep -q "import { checkpoint } from './checkpoint-operation.ts'" "$HOME/gbrain/src/core/operations.ts" 2>/dev/null && HAS_IMPORT=1
if [ "$HAS_FILE" = "1" ] && [ "$HAS_IMPORT" = "1" ]; then
  echo "already_applied"
elif git apply --check /tmp/0001-add-checkpoint-mcp-tool.patch 2>/dev/null; then
  git apply --verbose /tmp/0001-add-checkpoint-mcp-tool.patch 2>&1 | tail -3
  RC=\${PIPESTATUS[0]}
  if [ "$RC" -ne 0 ]; then
    echo "apply_failed_rc=$RC"
    exit 31
  fi
  # verify-after-apply
  [ -f "$HOME/gbrain/src/core/checkpoint-operation.ts" ] && HAS_FILE=1
  grep -q "import { checkpoint } from './checkpoint-operation.ts'" "$HOME/gbrain/src/core/operations.ts" && HAS_IMPORT=1
  if [ "$HAS_FILE" = "1" ] && [ "$HAS_IMPORT" = "1" ]; then
    echo "applied_ok"
  else
    echo "verify_failed file=$HAS_FILE import=$HAS_IMPORT"
    exit 31
  fi
else
  echo "patch_check_failed file=$HAS_FILE import=$HAS_IMPORT"
  exit 30
fi
`);
    if (applyPatch.code !== 0) {
      result.errors.push(`patch apply: rc=${applyPatch.code} stdout=${applyPatch.stdout.trim()} stderr=${applyPatch.stderr.slice(0, 200)}`);
      ssh.dispose();
      return result;
    }
    result.steps.push(`patch: ${applyPatch.stdout.trim().split("\n").pop()}`);

    // Step 4: restart gbrain.service so it picks up new checkpoint-operation.ts
    // Per Rule 54: gbrain restart sends SIGKILL (per unit's KillSignal=SIGKILL).
    // Acceptable here — we want the new operation registered. The checkpoint
    // cron + ExecStop hook we're about to install handles future stops safely.
    const restartGb = await ssh.execCommand(
      "export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user restart gbrain.service && " +
      "sleep 8 && systemctl --user is-active gbrain.service && " +
      "curl -sf -o /dev/null -w '/health=%{http_code}' http://127.0.0.1:3131/health",
    );
    if (restartGb.code !== 0) {
      result.errors.push(`gbrain restart: ${restartGb.stderr.slice(0, 200)}`);
      ssh.dispose();
      return result;
    }
    result.steps.push(`gbrain restart: ${restartGb.stdout.trim()}`);

    // Step 5-8: install cron + drop-in (mirror Phase I body exactly)
    const phaseI = await ssh.execCommand(`
mkdir -p "$HOME/.openclaw/scripts" "$HOME/.openclaw/logs" "$HOME/.config/systemd/user/gbrain.service.d"
cp /tmp/pglite-checkpoint.sh "$HOME/.openclaw/scripts/pglite-checkpoint.sh"
chmod +x "$HOME/.openclaw/scripts/pglite-checkpoint.sh"

# crontab (idempotent)
if ! crontab -l 2>/dev/null | grep -q "pglite-checkpoint.sh"; then
  (crontab -l 2>/dev/null; echo "*/30 * * * * bash $HOME/.openclaw/scripts/pglite-checkpoint.sh") | crontab -
  echo "cron_installed"
else
  echo "cron_already_present"
fi

# ExecStop drop-in
cat > "$HOME/.config/systemd/user/gbrain.service.d/20-execstop-checkpoint.conf" <<EOF
[Service]
ExecStop=$HOME/.openclaw/scripts/pglite-checkpoint.sh
TimeoutStopSec=30
EOF

export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user daemon-reload 2>&1 | tail -3

# Test run to seed pg_control freshness
bash "$HOME/.openclaw/scripts/pglite-checkpoint.sh" 2>&1 | tail -1
LAST=$(tail -1 "$HOME/.openclaw/logs/pglite-checkpoint.log" 2>/dev/null || echo "no_log")
echo "test_run: $LAST"
`);
    if (phaseI.code !== 0) {
      result.errors.push(`Phase I install: rc=${phaseI.code} stderr=${phaseI.stderr.slice(0, 200)}`);
      ssh.dispose();
      return result;
    }
    result.steps.push(`phase I: ${phaseI.stdout.trim().split("\n").join(" | ")}`);

    // Step 10: final verification
    const verify = await ssh.execCommand(`
export XDG_RUNTIME_DIR=/run/user/$(id -u)
echo "cron_count=$(crontab -l 2>/dev/null | grep -c pglite-checkpoint)"
echo "dropin_present=$(test -f ~/.config/systemd/user/gbrain.service.d/20-execstop-checkpoint.conf && echo y || echo n)"
echo "execstop_in_effective=$(systemctl --user show gbrain.service --property=ExecStop --value | grep -c pglite-checkpoint)"
echo "patch_present=$(test -f ~/gbrain/src/core/checkpoint-operation.ts && echo y || echo n)"
echo "gbrain_state=$(systemctl --user is-active gbrain.service 2>&1 | head -1)"
echo "gbrain_health=$(curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:3131/health 2>/dev/null || echo 000)"
`);
    result.steps.push(`verify: ${verify.stdout.trim().split("\n").join(" | ")}`);

    // Parse verify to confirm everything landed
    const allGood =
      /cron_count=1/.test(verify.stdout) &&
      /dropin_present=y/.test(verify.stdout) &&
      /execstop_in_effective=1/.test(verify.stdout) &&
      /patch_present=y/.test(verify.stdout) &&
      /gbrain_state=active/.test(verify.stdout) &&
      /gbrain_health=200/.test(verify.stdout);
    result.ok = allGood;
    if (!allGood) result.errors.push("verify gates failed; see steps above");
  } catch (e: any) {
    result.errors.push(`ssh err: ${String(e.message).slice(0, 200)}`);
  } finally {
    try { ssh.dispose(); } catch {}
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const explicit = args.filter((a) => !a.startsWith("--"));

  const sb = createClient(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const targetNames = explicit.length > 0
    ? explicit.map((n) => n.startsWith("instaclaw-") ? n : `instaclaw-${n}`)
    : [...ACTIVE_COHORT];

  const { data } = await sb.from("instaclaw_vms")
    .select("name, ip_address")
    .in("name", targetNames);
  if (!data) { console.error("query failed"); process.exit(1); }

  console.log(`Remediating ${data.length} VM(s)${dryRun ? " (DRY RUN)" : ""}:`);
  for (const v of data) console.log(`  - ${v.name} (${v.ip_address})`);
  console.log("");

  // Sequential to avoid concurrent gbrain restarts overloading anything.
  const results: RemediateResult[] = [];
  for (const v of data) {
    console.log(`=== ${v.name} ===`);
    const r = await remediateOne(v.ip_address, v.name, dryRun);
    for (const s of r.steps) console.log(`  · ${s}`);
    for (const e of r.errors) console.log(`  ! ${e}`);
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
    console.log("");
    results.push(r);
  }

  const successes = results.filter((r) => r.ok).length;
  console.log(`Summary: ${successes}/${results.length} succeeded`);
  process.exit(successes === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
