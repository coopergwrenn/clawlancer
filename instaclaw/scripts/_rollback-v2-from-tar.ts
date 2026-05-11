/**
 * Emergency rollback of V2 SOUL.md migration on one or more VMs.
 *
 * Restores SOUL.md / AGENTS.md / TOOLS.md / IDENTITY.md from the per-VM
 * `~/.openclaw/workspace-pre-soul-v2-migration.tar.gz` backup that
 * stepMigrateSoulV2 created during the fresh-migration path.
 *
 * Per CLAUDE.md Rule 22: trim, never nuke. This rollback is destructive on
 * the 4 V2 files but PRESERVES all other workspace state (memory/, MEMORY.md,
 * USER.md, agent-written files, etc.) by NOT doing a full workspace tar
 * extract. It extracts the tar to a temp dir, copies only the 4 V2-managed
 * files back, deletes any V2 file that didn't exist in V1.
 *
 * Usage:
 *   npx tsx scripts/_rollback-v2-from-tar.ts <vm-name>
 *   npx tsx scripts/_rollback-v2-from-tar.ts --vms=name1,name2,name3
 *   npx tsx scripts/_rollback-v2-from-tar.ts --all-v2  (rollback every V2 VM)
 *
 * Options:
 *   --dry-run    show what would happen; don't write
 *   --yes        skip per-VM confirmation prompt
 *
 * Safety:
 *   1. Verifies the tar file exists and is ≥ 1024 bytes BEFORE touching files.
 *   2. Saves the current V2 SOUL.md/AGENTS.md/TOOLS.md/IDENTITY.md to
 *      `~/.openclaw/v2-rollback-snapshot-<ts>/` BEFORE overwriting (so any
 *      V2-era agent edits to IDENTITY.md aren't silently destroyed).
 *   3. Uses `gzip -t` + `tar -tzf` validation before extracting.
 *   4. Atomic-extracts to a tmp dir, copies files individually, then cleans up.
 *   5. Restarts the openclaw-gateway after rollback and verifies /health=200.
 *   6. Per-VM-isolated. A failure on one VM doesn't block others.
 *
 * Post-rollback state:
 *   - SOUL.md = V1 content (as it was BEFORE the V2 migration)
 *   - AGENTS.md / TOOLS.md / IDENTITY.md = V1 content if those files existed
 *     pre-V2, otherwise DELETED (legacy V1 had AGENTS.md tiny, TOOLS.md and
 *     IDENTITY.md mostly absent — tar reflects actual prior state)
 *   - Other workspace files unchanged
 *   - The manifest's `append_if_marker_absent` rules will re-apply legacy
 *     V1 supplements (INTELLIGENCE_INTEGRATED, etc.) on the next reconciler
 *     tick. SOUL.md will grow back toward the pre-V2 size within minutes.
 *
 * Caveats:
 *   - If the tar is older than the current V2 content (e.g., V2 has been live
 *     for days and the user customized IDENTITY.md), the user's V2-era edits
 *     to IDENTITY.md are PRESERVED in the v2-rollback-snapshot-<ts>/ dir.
 *     They're not auto-merged into the V1 IDENTITY.md.
 *   - If the tar file is missing entirely, rollback fails for that VM. The
 *     only remaining recovery is the snapshot bake or a manual file restore.
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";
import * as readline from "readline";

// ── env loading (CLAUDE.md Rule 18) ──
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

import { SOUL_V2_MARKER } from "../lib/workspace-templates-v2";

const sshKey = Buffer.from(
  process.env.SSH_PRIVATE_KEY_B64!,
  "base64",
).toString("utf-8");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ── args ──
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const autoYes = args.includes("--yes");
const allV2 = args.includes("--all-v2");
const explicitVms =
  args
    .find((a) => a.startsWith("--vms="))
    ?.split("=")[1]
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [];
const positionalVm = args.find((a) => !a.startsWith("--"));
if (positionalVm) explicitVms.push(positionalVm);

if (explicitVms.length === 0 && !allV2) {
  console.error("Usage: npx tsx scripts/_rollback-v2-from-tar.ts <vm-name> [--dry-run] [--yes]");
  console.error("       npx tsx scripts/_rollback-v2-from-tar.ts --vms=name1,name2");
  console.error("       npx tsx scripts/_rollback-v2-from-tar.ts --all-v2");
  process.exit(64);
}

async function prompt(q: string): Promise<string> {
  if (autoYes) return "yes";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(q, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    });
  });
}

type VmRow = {
  id: string;
  name: string;
  ipv4_address: string;
  partner: string | null;
  health_status: string;
};

async function rollbackOne(vm: VmRow): Promise<{ ok: boolean; messages: string[] }> {
  const messages: string[] = [];
  const ok = (m: string) => messages.push(`✓ ${m}`);
  const bad = (m: string) => messages.push(`✗ ${m}`);

  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ipv4_address,
      username: "openclaw",
      privateKey: sshKey,
      readyTimeout: 12_000,
    });
    ok("SSH connected");
  } catch (e) {
    return { ok: false, messages: [`✗ SSH connect: ${(e as Error).message}`] };
  }

  try {
    // ── 1. Pre-check: is this VM actually at V2? ──
    const v2Check = await ssh.execCommand(
      `grep -qF "${SOUL_V2_MARKER}" ~/.openclaw/workspace/SOUL.md 2>/dev/null && echo V2 || echo V1_OR_MISSING`,
    );
    const v2State = (v2Check.stdout || "").trim();
    if (v2State !== "V2") {
      return {
        ok: true,
        messages: [`~ SOUL.md is ${v2State} — already not at V2, nothing to roll back`],
      };
    }
    ok("SOUL.md is V2 — proceeding with rollback");

    // ── 2. Verify tar exists and is valid ──
    const tarPath = "~/.openclaw/workspace-pre-soul-v2-migration.tar.gz";
    const tarChk = await ssh.execCommand(
      `if [ ! -f ${tarPath} ]; then echo MISSING; exit 0; fi; ` +
        `SIZE=$(wc -c < ${tarPath}); ` +
        `if [ "$SIZE" -lt 1024 ]; then echo "TOO_SMALL size=$SIZE"; exit 0; fi; ` +
        `if ! gzip -t ${tarPath} 2>/dev/null; then echo "CORRUPT"; exit 0; fi; ` +
        `if ! tar -tzf ${tarPath} >/dev/null 2>&1; then echo "TAR_INVALID"; exit 0; fi; ` +
        `echo "OK size=$SIZE"`,
    );
    const tarStatus = (tarChk.stdout || "").trim();
    if (!tarStatus.startsWith("OK")) {
      bad(`tar backup ${tarStatus} — rollback impossible without manual file recovery`);
      return { ok: false, messages };
    }
    ok(`tar backup ${tarStatus}`);

    // ── 3. Dry-run output ──
    if (dryRun) {
      messages.push("~ dry-run: would restore SOUL/AGENTS/TOOLS/IDENTITY from tar and restart gateway");
      return { ok: true, messages };
    }

    // ── 4. Save current V2 state to snapshot dir ──
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshotDir = `~/.openclaw/v2-rollback-snapshot-${ts}`;
    const snap = await ssh.execCommand(
      `mkdir -p ${snapshotDir} && ` +
        `for f in SOUL.md AGENTS.md TOOLS.md IDENTITY.md; do ` +
        `if [ -f ~/.openclaw/workspace/$f ]; then cp ~/.openclaw/workspace/$f ${snapshotDir}/$f; fi; ` +
        `done && echo OK`,
    );
    if (!(snap.stdout || "").includes("OK")) {
      bad(`snapshot pre-rollback V2 state failed: ${snap.stderr?.slice(0, 100)}`);
      return { ok: false, messages };
    }
    ok(`V2 state snapshotted to ${snapshotDir}`);

    // ── 5. Extract tar to temp dir + selective restore ──
    // Restores only the 4 V2-managed files. Other workspace files (memory/,
    // MEMORY.md, USER.md, agent-written content) are untouched per Rule 22.
    const restoreScript = [
      `TMPDIR=$(mktemp -d /tmp/v2-restore.XXXXXX)`,
      `cd "$TMPDIR" || exit 1`,
      `if ! tar xzf ${tarPath} 2>&1; then echo "EXTRACT_FAILED"; rm -rf "$TMPDIR"; exit 2; fi`,
      `if [ ! -d "$TMPDIR/workspace" ]; then echo "NO_WORKSPACE_DIR"; rm -rf "$TMPDIR"; exit 3; fi`,
      `for f in SOUL.md AGENTS.md TOOLS.md IDENTITY.md; do`,
      `  SRC="$TMPDIR/workspace/$f"`,
      `  DST=~/.openclaw/workspace/$f`,
      `  if [ -f "$SRC" ]; then`,
      `    cp "$SRC" "$DST" && echo "RESTORED $f"`,
      `  else`,
      `    rm -f "$DST" && echo "REMOVED $f (not in V1)"`,
      `  fi`,
      `done`,
      `rm -rf "$TMPDIR"`,
      `echo "RESTORE_OK"`,
    ].join("\n");

    const restore = await ssh.execCommand(restoreScript);
    const restoreOut = (restore.stdout || "").trim();
    if (restore.code !== 0 || !restoreOut.includes("RESTORE_OK")) {
      bad(`tar restore failed code=${restore.code}: ${restoreOut.slice(0, 200)} stderr=${(restore.stderr || "").slice(0, 100)}`);
      return { ok: false, messages };
    }
    for (const line of restoreOut.split("\n")) {
      if (line.startsWith("RESTORED ") || line.startsWith("REMOVED ")) {
        messages.push(`  · ${line}`);
      }
    }
    ok("tar files restored");

    // ── 6. Verify V2 marker is gone ──
    const verify = await ssh.execCommand(
      `grep -qF "${SOUL_V2_MARKER}" ~/.openclaw/workspace/SOUL.md 2>/dev/null && echo STILL_V2 || echo V1_OR_GONE`,
    );
    if ((verify.stdout || "").trim() !== "V1_OR_GONE") {
      bad(`SOUL.md STILL has V2 marker after restore — restore did not land`);
      return { ok: false, messages };
    }
    ok("SOUL.md V2 marker gone");

    // ── 7. Restart gateway and verify health ──
    const restart = await ssh.execCommand(
      `systemctl --user restart openclaw-gateway 2>&1`,
    );
    if (restart.code !== 0) {
      bad(`gateway restart failed: ${(restart.stderr || restart.stdout).slice(0, 100)}`);
      return { ok: false, messages };
    }
    ok("gateway restart initiated");

    // Poll for active + /health=200 up to 30s
    let healthy = false;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      const gw = await ssh.execCommand(
        `systemctl --user is-active openclaw-gateway 2>/dev/null || echo inactive`,
      );
      const h = await ssh.execCommand(
        `curl -sf -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null || echo 000`,
      );
      if ((gw.stdout || "").trim() === "active" && (h.stdout || "").trim() === "200") {
        healthy = true;
        ok(`gateway healthy after ${(i + 1) * 5}s`);
        break;
      }
    }
    if (!healthy) {
      bad("gateway NOT healthy 30s after restart — investigate manually");
      return { ok: false, messages };
    }

    return { ok: true, messages };
  } finally {
    ssh.dispose();
  }
}

async function main() {
  console.log("══ V2 SOUL.md ROLLBACK ══");
  console.log(`  dryRun: ${dryRun}`);
  console.log(`  autoYes: ${autoYes}`);

  // Resolve VM list
  let vms: VmRow[] = [];
  if (allV2) {
    // Can't query "has SOUL_V2_MARKER" from DB; need SSH probe. For now,
    // pull all healthy assigned VMs and let rollbackOne short-circuit on V1 VMs.
    const { data } = await sb
      .from("instaclaw_vms")
      .select("id,name,ipv4_address,partner,health_status")
      .eq("health_status", "healthy")
      .not("assigned_to", "is", null)
      .order("name");
    vms = (data ?? []) as never;
    console.log(`  --all-v2: ${vms.length} candidate VMs (V1 VMs will short-circuit)`);
  } else {
    const { data } = await sb
      .from("instaclaw_vms")
      .select("id,name,ipv4_address,partner,health_status")
      .in("name", explicitVms);
    vms = (data ?? []) as never;
    console.log(`  cohort: ${vms.length}/${explicitVms.length} VMs resolved`);
  }

  if (vms.length === 0) {
    console.error("FATAL: no VMs to roll back");
    process.exit(2);
  }

  if (!dryRun) {
    console.log("\nThis will:");
    console.log("  1. Restore SOUL/AGENTS/TOOLS/IDENTITY.md from each VM's pre-V2 tar backup");
    console.log("  2. Snapshot the current V2 state to ~/.openclaw/v2-rollback-snapshot-<ts>/");
    console.log("  3. Restart each VM's openclaw-gateway");
    const ans = await prompt(`\nProceed with ROLLBACK on ${vms.length} VM(s)? [yes/no] `);
    if (ans !== "yes" && ans !== "y") {
      console.log("Aborted.");
      process.exit(1);
    }
  }

  let okCount = 0;
  let failCount = 0;
  const failures: string[] = [];

  for (const vm of vms) {
    console.log(`\n── ${vm.name} (${vm.ipv4_address}) partner=${vm.partner ?? "null"} ──`);
    const start = Date.now();
    let res;
    try {
      res = await rollbackOne(vm);
    } catch (e) {
      res = { ok: false, messages: [`✗ rollback threw: ${(e as Error).message}`] };
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    for (const m of res.messages) console.log(`  ${m}`);
    console.log(`  (${elapsed}s) → ${res.ok ? "OK" : "FAILED"}`);
    if (res.ok) okCount++;
    else {
      failCount++;
      failures.push(`${vm.name}: ${res.messages.filter((m) => m.startsWith("✗")).join("; ")}`);
    }
  }

  console.log(`\n══ Rollback summary ══`);
  console.log(`  ok:     ${okCount}`);
  console.log(`  failed: ${failCount}`);
  if (failures.length > 0) {
    console.log(`\n  Failures:`);
    for (const f of failures) console.log(`    ${f}`);
  }
  process.exit(failCount > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
