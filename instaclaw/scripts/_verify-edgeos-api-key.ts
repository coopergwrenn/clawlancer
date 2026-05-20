#!/usr/bin/env tsx
/**
 * _verify-edgeos-api-key.ts — verify D3 (per-VM EDGEOS_API_KEY) rollout.
 *
 * For every partner=edge_city VM, this checks the FOUR places the
 * `eos_live_*` key must agree (per CLAUDE.md Rules 34 + 58):
 *
 *   1. instaclaw_vms.edgeos_api_key (DB)               — populated, eos_live_*
 *   2. ~/.openclaw/.env:EDGEOS_API_KEY (on-disk)       — populated, eos_live_*
 *   3. DB value == on-disk value (cross-consumer match per Rule 58)
 *   4. Shape sanity: starts with `eos_live_` (Rule 49 fingerprint check)
 *
 * Why these four:
 *   - DB only → reconciler ran but configureOpenClaw never deployed the
 *     value to disk. The skill's events:read call would 401 on the VM.
 *   - Disk only → mint succeeded + .env got written, but the DB persist
 *     failed. Next configure cycle would try to re-mint (creating an
 *     orphan EdgeOS key) and re-deploy.
 *   - DB + disk mismatch → silent rotation that left one consumer stale.
 *     Same shape as the 2026-05-18 gbrain bearer mismatch incident.
 *   - Shape wrong → something deployed a stale value (e.g., the bearer
 *     instead of an api-key).
 *
 * Usage:
 *   npx tsx scripts/_verify-edgeos-api-key.ts                 # all edge VMs
 *   npx tsx scripts/_verify-edgeos-api-key.ts --vm=vm-050     # single VM
 *
 * Exit codes:
 *   0 — every edge VM passes all 4 checks
 *   1 — at least one VM fails one or more checks
 *   2 — missing env / Supabase unreachable
 */

import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";

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
  console.error("missing env: need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SSH_PRIVATE_KEY_B64");
  process.exit(2);
}

const SINGLE_VM = process.argv.find((a) => a.startsWith("--vm="))?.split("=")[1];
const SSH_KEY = Buffer.from(SSH_KEY_B64, "base64").toString("utf-8");

interface VmRow {
  name: string;
  ip_address: string;
  edgeos_api_key: string | null;
}

interface CheckResult {
  vm: string;
  ip: string;
  db_present: boolean;
  db_shape_ok: boolean;
  disk_present: boolean;
  disk_shape_ok: boolean;
  match: boolean;
  ssh_ok: boolean;
  detail: string;
}

async function fetchEdgeVms(): Promise<VmRow[]> {
  let url =
    `${SUPABASE_URL}/rest/v1/instaclaw_vms?partner=eq.edge_city&select=name,ip_address,edgeos_api_key&order=name`;
  if (SINGLE_VM) url += `&name=eq.${encodeURIComponent(SINGLE_VM)}`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) {
    const body = await res.text();
    // 42703 = column does not exist (pre-migration). Distinguish loudly.
    if (/edgeos_api_key/.test(body) && /column/.test(body)) {
      console.error("Supabase rejects `edgeos_api_key` column — migration not applied yet.");
      console.error("Apply pending_migrations/20260520190000_vm_edgeos_api_key.sql in Studio first.");
      process.exit(2);
    }
    throw new Error(`Supabase ${res.status}: ${body}`);
  }
  return (await res.json()) as VmRow[];
}

async function readEnvFromVM(vm: VmRow): Promise<{ ssh_ok: boolean; value: string | null; raw: string }> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      username: "openclaw",
      privateKey: SSH_KEY,
      readyTimeout: 8000,
    });
    const out = await ssh.execCommand(
      "grep '^EDGEOS_API_KEY=' ~/.openclaw/.env 2>/dev/null | head -1"
    );
    ssh.dispose();
    const line = out.stdout.trim();
    if (!line) return { ssh_ok: true, value: null, raw: "" };
    const m = line.match(/^EDGEOS_API_KEY=(.*)$/);
    return { ssh_ok: true, value: m?.[1]?.replace(/^["']|["']$/g, "") ?? null, raw: line };
  } catch (e) {
    try { ssh.dispose(); } catch {}
    return { ssh_ok: false, value: null, raw: (e as Error).message };
  }
}

async function checkVm(vm: VmRow): Promise<CheckResult> {
  const dbVal = vm.edgeos_api_key ?? "";
  const dbPresent = dbVal.length > 0;
  const dbShapeOk = dbPresent && /^eos_live_[A-Za-z0-9_\-]+$/.test(dbVal);

  const disk = await readEnvFromVM(vm);
  const diskVal = disk.value ?? "";
  const diskPresent = diskVal.length > 0;
  const diskShapeOk = diskPresent && /^eos_live_[A-Za-z0-9_\-]+$/.test(diskVal);
  const match = dbPresent && diskPresent && dbVal === diskVal;

  const issues: string[] = [];
  if (!dbPresent) issues.push("db_missing");
  else if (!dbShapeOk) issues.push("db_shape");
  if (!disk.ssh_ok) issues.push("ssh_fail");
  else if (!diskPresent) issues.push("disk_missing");
  else if (!diskShapeOk) issues.push("disk_shape");
  if (dbPresent && diskPresent && !match) issues.push("mismatch");

  return {
    vm: vm.name,
    ip: vm.ip_address,
    db_present: dbPresent,
    db_shape_ok: dbShapeOk,
    disk_present: diskPresent,
    disk_shape_ok: diskShapeOk,
    match,
    ssh_ok: disk.ssh_ok,
    detail: issues.length === 0 ? "all 4 checks pass" : issues.join(","),
  };
}

function fmt(b: boolean): string {
  return b ? "✓" : "✗";
}

async function main() {
  const vms = await fetchEdgeVms();
  if (vms.length === 0) {
    console.error(SINGLE_VM ? `no edge_city VM named "${SINGLE_VM}"` : "no edge_city VMs in DB");
    process.exit(2);
  }

  console.log(`\nVerifying EDGEOS_API_KEY across ${vms.length} edge_city VM(s)\n`);
  console.log(
    "vm                  ip               db   shape  disk  shape  match  detail",
  );
  console.log(
    "─────────────────── ──────────────── ──── ─────  ────  ─────  ─────  ────────────────",
  );

  const results: CheckResult[] = [];
  for (const vm of vms) {
    const r = await checkVm(vm);
    results.push(r);
    console.log(
      `${r.vm.padEnd(19)} ${r.ip.padEnd(16)}  ${fmt(r.db_present)}     ${fmt(r.db_shape_ok)}     ${fmt(r.disk_present)}     ${fmt(r.disk_shape_ok)}     ${fmt(r.match)}    ${r.detail}`,
    );
  }

  const passing = results.filter((r) => r.detail === "all 4 checks pass").length;
  const failing = results.length - passing;
  console.log("\n========================");
  console.log(`  ${passing} pass, ${failing} fail / ${results.length} total`);
  console.log("========================\n");

  if (failing === 0) {
    console.log("D3 is healthy fleet-wide. Every edge VM has a per-VM eos_live_* key");
    console.log("that matches between DB and ~/.openclaw/.env.");
  } else {
    console.log("D3 failures detected. Common shapes:");
    console.log("  db_missing  → mint never ran (column not migrated, or no EDGEOS_BEARER_TOKEN)");
    console.log("  disk_missing → mint succeeded but configureOpenClaw never reached the .env step");
    console.log("  mismatch    → DB and disk drifted; one consumer was updated without the other");
    console.log("  ssh_fail    → VM unreachable; can't verify disk side");
    console.log("  *_shape     → value present but doesn't look like an eos_live_* key");
  }
  process.exit(failing > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("verify-edgeos-api-key threw:", e);
  process.exit(2);
});
