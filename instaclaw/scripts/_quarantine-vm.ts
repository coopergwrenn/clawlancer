#!/usr/bin/env tsx
/**
 * _quarantine-vm.ts — operator-set quarantine that cron CANNOT undo.
 *
 * Usage:
 *   npx tsx scripts/_quarantine-vm.ts set <vm_name>    # quarantine
 *   npx tsx scripts/_quarantine-vm.ts clear <vm_name>  # release
 *   npx tsx scripts/_quarantine-vm.ts list             # show all quarantined
 *
 * Mechanism: writes `operator_quarantined_at = NOW()` (or NULL on clear)
 * on the matching VM row. Cron paths that mutate `status` check
 * `operator_quarantined_at IS NULL` and skip when set. See migration
 * 20260521000000_vm_operator_quarantine.sql and CLAUDE.md
 * "Operator quarantine durability".
 *
 * vm-043 (2026-05-20) was the originating incident — a manually-set
 * status=failed got auto-recovered back to status=ready/assigned by
 * the health-check auto-migration block (route.ts:2779-2783) which
 * didn't have any operator-quarantine gate.
 */
import { readFileSync } from "fs";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
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
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

const [cmd, vmName] = process.argv.slice(2);

async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function findVm(name: string) {
  const res = await sb(
    `instaclaw_vms?name=eq.${encodeURIComponent(name)}&select=id,name,status,health_status,operator_quarantined_at`,
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as Array<{
    id: string;
    name: string;
    status: string | null;
    health_status: string | null;
    operator_quarantined_at: string | null;
  }>;
  return rows[0] ?? null;
}

async function setQuarantine(vmName: string, set: boolean) {
  const vm = await findVm(vmName);
  if (!vm) {
    console.error(`no VM named "${vmName}"`);
    process.exit(1);
  }
  console.log(`Found: ${vm.name} (id=${vm.id.slice(0, 8)}…)`);
  console.log(`  before: status=${vm.status} health=${vm.health_status} quarantined_at=${vm.operator_quarantined_at ?? "(null)"}`);

  const value = set ? new Date().toISOString() : null;
  const res = await sb(`instaclaw_vms?id=eq.${vm.id}`, {
    method: "PATCH",
    body: JSON.stringify({ operator_quarantined_at: value }),
    headers: { Prefer: "return=representation" },
  });
  if (!res.ok) {
    console.error(`update failed ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const after = (await res.json()) as Array<{ operator_quarantined_at: string | null }>;
  console.log(`  after:  quarantined_at=${after[0]?.operator_quarantined_at ?? "(null)"}`);
  console.log(`\n${set ? "QUARANTINED" : "RELEASED"} ✓`);
  if (set) {
    console.log("");
    console.log("Cron paths that respect this:");
    console.log("  - cron/health-check auto-migration (route.ts:2731)");
    console.log("");
    console.log("To release: npx tsx scripts/_quarantine-vm.ts clear " + vmName);
  }
}

async function listQuarantined() {
  const res = await sb(
    "instaclaw_vms?operator_quarantined_at=not.is.null&select=name,status,health_status,operator_quarantined_at&order=operator_quarantined_at",
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as Array<{
    name: string;
    status: string;
    health_status: string;
    operator_quarantined_at: string;
  }>;
  if (rows.length === 0) {
    console.log("(no VMs operator-quarantined)");
    return;
  }
  console.log(`${rows.length} operator-quarantined VM(s):`);
  for (const r of rows) {
    const since = new Date(r.operator_quarantined_at).toISOString().slice(0, 19);
    console.log(`  ${r.name.padEnd(20)} status=${r.status.padEnd(11)} health=${r.health_status.padEnd(15)} since=${since}`);
  }
}

async function main() {
  if (cmd === "list") {
    await listQuarantined();
  } else if (cmd === "set" && vmName) {
    await setQuarantine(vmName, true);
  } else if (cmd === "clear" && vmName) {
    await setQuarantine(vmName, false);
  } else {
    console.error("Usage:");
    console.error("  npx tsx scripts/_quarantine-vm.ts set <vm_name>    # quarantine");
    console.error("  npx tsx scripts/_quarantine-vm.ts clear <vm_name>  # release");
    console.error("  npx tsx scripts/_quarantine-vm.ts list             # show all quarantined");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("threw:", e);
  process.exit(2);
});
