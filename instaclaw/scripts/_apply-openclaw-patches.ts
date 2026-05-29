#!/usr/bin/env tsx
/**
 * _apply-openclaw-patches.ts — (re)apply custom OpenClaw dist patches to a VM.
 *
 * This is the manual / snapshot-bake / canary apply path. The reconciler has
 * its own apply (stepPiAiReasoningPatch today; future stepOpenClawPatches), so
 * for the normal fleet you do NOT need this — it's for:
 *   - Snapshot bake: after `npm install -g openclaw@<v>` on the bake VM, run
 *     this so the baked image ships with patches already applied.
 *   - Canary: apply a "canary" rollout patch (e.g. queue-collect-batch, once
 *     its body is captured) to a single VM for testing per Rule 64.
 *   - Recovery: re-apply after a manual openclaw reinstall.
 *
 * SAFETY: every apply is idempotent (sentinel-skip), backs up to
 * `<file>.pre-<id>.bak`, writes atomically, verifies, and runs `node --check`
 * with rollback on failure. A patch whose body isn't in the repo (queue stub)
 * REFUSES to apply and prints capture instructions.
 *
 * Default applies only `rollout: "fleet"` patches (currently just
 * pi-ai-reasoning-router). Promotion of canary/parked patches to fleet, and
 * any fleet-wide apply, is a Rule-64 decision — test on vm-1019 first.
 *
 * Usage:
 *   npx tsx scripts/_apply-openclaw-patches.ts --vm=instaclaw-vm-1019            # fleet patches, that VM
 *   npx tsx scripts/_apply-openclaw-patches.ts --vm=... --dry-run                # show what would apply
 *   npx tsx scripts/_apply-openclaw-patches.ts --vm=... --include-canary         # also canary patches
 *   npx tsx scripts/_apply-openclaw-patches.ts --vm=... --id=queue-collect-batch # one patch
 *   npx tsx scripts/_apply-openclaw-patches.ts --ip=1.2.3.4                      # bake VM by IP (no DB)
 *
 * Exit: 0 = all selected patches applied/already-applied/dry-run; 1 = a failure.
 */

import { readFileSync } from "node:fs";
import { NodeSSH } from "node-ssh";
import {
  applyOpenClawPatches,
  type RolloutStage,
  type PatchResult,
} from "../lib/openclaw-patches";

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

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SSH_KEY_B64 = process.env.SSH_PRIVATE_KEY_B64;
if (!SSH_KEY_B64) {
  console.error("missing env: SSH_PRIVATE_KEY_B64 (need instaclaw/.env.ssh-key)");
  process.exit(2);
}
const SSH_KEY = Buffer.from(SSH_KEY_B64, "base64").toString("utf-8");

const argVm = process.argv.find((a) => a.startsWith("--vm="))?.split("=")[1];
const argIp = process.argv.find((a) => a.startsWith("--ip="))?.split("=")[1];
const argId = process.argv.find((a) => a.startsWith("--id="))?.split("=")[1];
const dryRun = process.argv.includes("--dry-run");
const includeCanary = process.argv.includes("--include-canary");
const includeParked = process.argv.includes("--include-parked");

if (!argVm && !argIp) {
  console.error("specify a target: --vm=<name> (resolves IP via DB) or --ip=<addr>");
  process.exit(2);
}

const rollouts: RolloutStage[] = ["fleet"];
if (includeCanary) rollouts.push("canary");
if (includeParked) rollouts.push("parked");

async function resolveIp(): Promise<string> {
  if (argIp) return argIp;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("--vm requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY; or use --ip=");
    process.exit(2);
  }
  const url = `${SUPABASE_URL}/rest/v1/instaclaw_vms?name=eq.${encodeURIComponent(argVm!)}&select=ip_address`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) {
    console.error(`Supabase ${res.status}: ${await res.text()}`);
    process.exit(2);
  }
  const rows = (await res.json()) as { ip_address: string }[];
  if (!rows[0]?.ip_address) {
    console.error(`no IP for VM "${argVm}"`);
    process.exit(2);
  }
  return rows[0].ip_address;
}

async function main() {
  const ip = await resolveIp();
  const label = argVm ?? ip;
  console.log(`\nApplying OpenClaw patches to ${label} (${ip})`);
  console.log(`  rollouts=[${rollouts.join(",")}]${argId ? ` id=${argId}` : ""}${dryRun ? " DRY-RUN" : ""}\n`);

  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: ip, username: "openclaw", privateKey: SSH_KEY, readyTimeout: 8000 });
  } catch (e) {
    console.error(`SSH connect failed: ${(e as Error).message}`);
    process.exit(1);
  }

  let results: PatchResult[];
  try {
    results = await applyOpenClawPatches(ssh, {
      rollouts,
      ids: argId ? [argId] : undefined,
      dryRun,
    });
  } finally {
    ssh.dispose();
  }

  let anyRestart = false;
  let failed = 0;
  for (const r of results) {
    const ok =
      r.status === "applied" ||
      r.status === "applied-now" ||
      r.status === "dry-run" ||
      r.status === "native-fixed" ||
      r.status === "skipped-rollout";
    const mark = ok ? "✓" : r.status === "no-transform" ? "·" : "✗";
    console.log(`  ${mark} ${r.id.padEnd(26)} ${r.status.padEnd(14)} ${r.detail}`);
    if (r.restartNeeded) anyRestart = true;
    if (!ok && r.status !== "no-transform") failed++;
  }

  console.log("\n════════════════════════════════════");
  if (anyRestart && !dryRun) {
    console.log("  ⚠ a patch was applied that needs a gateway restart:");
    console.log(`     ssh openclaw@${ip} 'systemctl --user restart openclaw-gateway'`);
    console.log("     then verify /health=200 (Rule 5).");
  }
  if (failed === 0) {
    console.log("  done — no failures");
    console.log("════════════════════════════════════\n");
    process.exit(0);
  } else {
    console.log(`  ${failed} failure(s) — see ✗ rows above`);
    console.log("════════════════════════════════════\n");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("apply-openclaw-patches threw:", e);
  process.exit(1);
});
