#!/usr/bin/env tsx
/**
 * _verify-openclaw-patches.ts — read-only coverage for every custom OpenClaw
 * dist patch across the fleet (or a sample, or one VM).
 *
 * THIS IS THE HEADLINE TOOL. It is the mechanism CLAUDE.md Rule 71 relies on to
 * answer "did the last OpenClaw upgrade silently disable any of our patches?"
 *
 * For each VM × each registry patch it reports one status:
 *   applied        — sentinel present at the expected count (patch is LIVE) ✓
 *   missing        — pristine, anchors present (patch CAN be re-applied) ⚠ (fleet patch = bad)
 *   anchor-drift   — anchors gone; upstream changed the file shape — RE-ANCHOR ✗
 *   native-fixed   — upstream now does this itself; patch is redundant (delete it) ℹ
 *   target-missing — the file wasn't found (wrong version? package layout change) ✗
 *   no-transform   — registry stub (queue) — body not captured yet ℹ
 *   ssh-fail       — VM unreachable
 *
 * Exit codes:
 *   0 — every fleet-rollout patch is "applied" on every reachable VM
 *   1 — at least one fleet-rollout patch is missing/drifted/target-missing
 *   2 — missing env / Supabase unreachable
 *
 * Usage:
 *   npx tsx scripts/_verify-openclaw-patches.ts                 # sample 8 healthy+assigned VMs
 *   npx tsx scripts/_verify-openclaw-patches.ts --all           # every healthy+assigned VM
 *   npx tsx scripts/_verify-openclaw-patches.ts --sample=20     # sample N
 *   npx tsx scripts/_verify-openclaw-patches.ts --vm=instaclaw-vm-1019
 *   npx tsx scripts/_verify-openclaw-patches.ts --id=pi-ai-reasoning-router
 *
 * RUN THIS after any OPENCLAW_PINNED_VERSION bump. An "anchor-drift" or
 * "missing" on pi-ai-reasoning-router means the reasoning router is silently
 * OFF fleet-wide — exactly the failure the 4.26→5.22 bump risks.
 */

import { readFileSync } from "node:fs";
import { NodeSSH } from "node-ssh";
import {
  verifyOpenClawPatches,
  PATCHES,
  type PatchResult,
  type PatchStatus,
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

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SSH_KEY_B64 = process.env.SSH_PRIVATE_KEY_B64!;
if (!SUPABASE_URL || !SUPABASE_KEY || !SSH_KEY_B64) {
  console.error("missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SSH_PRIVATE_KEY_B64");
  process.exit(2);
}
const SSH_KEY = Buffer.from(SSH_KEY_B64, "base64").toString("utf-8");

const argVm = process.argv.find((a) => a.startsWith("--vm="))?.split("=")[1];
const argId = process.argv.find((a) => a.startsWith("--id="))?.split("=")[1];
const argSample = process.argv.find((a) => a.startsWith("--sample="))?.split("=")[1];
const argAll = process.argv.includes("--all");
const SAMPLE_N = argSample ? parseInt(argSample, 10) : 8;
const ids = argId ? [argId] : undefined;

interface VmRow {
  name: string;
  ip_address: string;
}

async function fetchVms(): Promise<VmRow[]> {
  let url = `${SUPABASE_URL}/rest/v1/instaclaw_vms?select=name,ip_address&order=name`;
  if (argVm) {
    url += `&name=eq.${encodeURIComponent(argVm)}`;
  } else {
    url += `&status=eq.assigned&health_status=eq.healthy`;
  }
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  let rows = (await res.json()) as VmRow[];
  rows = rows.filter((r) => r.ip_address);
  if (!argVm && !argAll) {
    // Deterministic sample (stride) so reruns hit the same VMs.
    const stride = Math.max(1, Math.floor(rows.length / SAMPLE_N));
    rows = rows.filter((_, i) => i % stride === 0).slice(0, SAMPLE_N);
  }
  return rows;
}

const ICON: Record<PatchStatus, string> = {
  applied: "✓",
  "applied-now": "✓",
  missing: "⚠",
  "anchor-drift": "✗",
  "native-fixed": "ℹ",
  "target-missing": "✗",
  "no-transform": "·",
  "ssh-fail": "?",
  "verify-failed": "✗",
  "skipped-rollout": "·",
  "dry-run": "·",
};

async function verifyVm(vm: VmRow): Promise<PatchResult[]> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      username: "openclaw",
      privateKey: SSH_KEY,
      readyTimeout: 8000,
    });
    const results = await verifyOpenClawPatches(ssh, { ids });
    ssh.dispose();
    return results;
  } catch (e) {
    try {
      ssh.dispose();
    } catch {}
    return (ids ? PATCHES.filter((p) => ids.includes(p.id)) : PATCHES).map((p) => ({
      id: p.id,
      status: "ssh-fail" as PatchStatus,
      detail: (e as Error).message.slice(0, 80),
    }));
  }
}

async function main() {
  const vms = await fetchVms();
  if (vms.length === 0) {
    console.error(argVm ? `no VM named "${argVm}"` : "no matching VMs");
    process.exit(2);
  }
  const selected = ids ? PATCHES.filter((p) => ids.includes(p.id)) : PATCHES;

  console.log(`\nOpenClaw patch coverage — ${vms.length} VM(s), ${selected.length} patch(es)\n`);
  console.log("legend: ✓ applied  ⚠ missing  ✗ drift/missing-file/fail  ℹ native-fixed/stub\n");

  // header
  const idCols = selected.map((p) => p.id);
  console.log(
    "vm".padEnd(22) + idCols.map((id) => id.slice(0, 14).padEnd(15)).join(""),
  );
  console.log("─".repeat(22 + idCols.length * 15));

  // track worst status per fleet-rollout patch for exit code
  const fleetBad: string[] = [];
  const detailLines: string[] = [];

  for (const vm of vms) {
    const results = await verifyVm(vm);
    const byId = new Map(results.map((r) => [r.id, r]));
    const cells = selected.map((p) => {
      const r = byId.get(p.id);
      const icon = r ? ICON[r.status] : "?";
      return `${icon} ${(r?.status ?? "?").slice(0, 12)}`.padEnd(15);
    });
    console.log(vm.name.padEnd(22) + cells.join(""));

    for (const p of selected) {
      const r = byId.get(p.id);
      if (!r) continue;
      if (
        p.rollout === "fleet" &&
        (r.status === "missing" ||
          r.status === "anchor-drift" ||
          r.status === "target-missing" ||
          r.status === "verify-failed")
      ) {
        fleetBad.push(`${vm.name}/${p.id}: ${r.status} — ${r.detail}`);
      }
      if (r.status === "anchor-drift" || r.status === "native-fixed") {
        detailLines.push(`${vm.name}/${p.id} [${r.status}]: ${r.detail}`);
      }
    }
  }

  if (detailLines.length) {
    console.log("\nnotable:");
    for (const l of detailLines) console.log(`  • ${l}`);
  }

  console.log("\n════════════════════════════════════");
  if (fleetBad.length === 0) {
    console.log("  every fleet-rollout patch is applied on every reachable VM ✓");
    console.log("════════════════════════════════════\n");
    process.exit(0);
  } else {
    console.log(`  ${fleetBad.length} fleet-patch problem(s):`);
    for (const b of fleetBad) console.log(`   ✗ ${b}`);
    console.log("════════════════════════════════════");
    console.log("\nIf a fleet patch shows anchor-drift after a version bump, the upstream");
    console.log("file shape changed — re-anchor it (see openclaw-upgrade-runbook.md) and");
    console.log("re-run. If it shows 'missing', re-apply via _apply-openclaw-patches.ts or");
    console.log("trigger a reconcile.\n");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("verify-openclaw-patches threw:", e);
  process.exit(2);
});
