/**
 * Audit every v67-marked VM and reset config_version to match actual on-disk
 * state. The fleet patch script (_fleet-patch-v67-soul.ts) over-bumped
 * config_version to 67 for VMs that had only had SOUL.md/CAPABILITIES.md
 * patched — Node + OpenClaw were still on the older versions.
 *
 * Truth table:
 *   Node 22.22.2  + OpenClaw 2026.4.26 + v67 marker  → keep 67
 *   Node 22.22.2  + OpenClaw 2026.4.26               → 66 (no SOUL.md fix)
 *   Node 22.22.2 OR OpenClaw 2026.4.26               → 65 (partial)
 *   neither                                           → 63 (stock pre-v64)
 */
import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.join(__dirname, "../.env.ssh-key") });
dotenv.config({ path: path.join(__dirname, "../.env.local") });

import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";

const argv = process.argv.slice(2);
const isExecute = argv.includes("--execute");
const concurrency = 10;

const SSH_KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

interface VMRow {
  id: string;
  name: string | null;
  ip_address: string;
  config_version: number | null;
}

async function audit(vm: VMRow): Promise<{ vm: VMRow; node: string; openclaw: string; marker: number; targetVersion: number; err?: string }> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: vm.ip_address, port: 22, username: "openclaw", privateKey: SSH_KEY, readyTimeout: 12_000 });
    const r = await ssh.execCommand(
      `export NVM_DIR=$HOME/.nvm && . $NVM_DIR/nvm.sh 2>/dev/null; ` +
      `echo "NODE:$(node --version 2>&1)"; ` +
      `echo "OPENCLAW:$(openclaw --version 2>&1 | head -1)"; ` +
      `echo "MARKER:$(grep -c 'Token launches deploy on Base mainnet' ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo 0)"`,
    );
    const lines: Record<string, string> = {};
    for (const ln of r.stdout.split("\n")) {
      const idx = ln.indexOf(":");
      if (idx > 0) lines[ln.slice(0, idx)] = ln.slice(idx + 1).trim();
    }
    const node = lines.NODE || "?";
    const openclaw = lines.OPENCLAW || "?";
    const marker = parseInt(lines.MARKER || "0", 10) || 0;
    const nodeOk = node.includes("22.22.2");
    const openclawOk = openclaw.includes("2026.4.26");
    const markerOk = marker > 0;
    let target: number;
    if (nodeOk && openclawOk && markerOk) target = 67;
    else if (nodeOk && openclawOk) target = 66;
    else if (nodeOk || openclawOk) target = 65;
    else target = 63;
    return { vm, node, openclaw, marker, targetVersion: target };
  } catch (err) {
    return { vm, node: "?", openclaw: "?", marker: 0, targetVersion: vm.config_version ?? 0, err: (err instanceof Error ? err.message : String(err)).slice(0, 120) };
  } finally {
    try { ssh.dispose(); } catch { /* noop */ }
  }
}

(async () => {
  console.log(`mode: ${isExecute ? "EXECUTE" : "DRY-RUN"}, concurrency=${concurrency}`);
  const { data: vms } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, config_version")
    .eq("status", "assigned").eq("provider", "linode").eq("health_status", "healthy")
    .gte("config_version", 65)
    .not("ip_address", "is", null);
  const pool = (vms ?? []) as VMRow[];
  console.log(`auditing ${pool.length} VMs at config_version >= 65...`);

  let next = 0;
  const results: Awaited<ReturnType<typeof audit>>[] = [];
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= pool.length) return;
      results.push(await audit(pool[i]));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const buckets: Record<number, number> = {};
  const moves: { id: string; name: string | null; from: number; to: number }[] = [];
  for (const r of results) {
    buckets[r.targetVersion] = (buckets[r.targetVersion] ?? 0) + 1;
    if (r.targetVersion !== r.vm.config_version) {
      moves.push({ id: r.vm.id, name: r.vm.name, from: r.vm.config_version ?? 0, to: r.targetVersion });
    }
  }
  console.log("\nactual on-disk distribution:", buckets);
  console.log(`config_version corrections: ${moves.length}`);
  for (const m of moves.slice(0, 20)) console.log(`  ${m.name}  ${m.from} → ${m.to}`);
  if (moves.length > 20) console.log(`  ... ${moves.length - 20} more ...`);
  const errored = results.filter(r => r.err);
  if (errored.length) {
    console.log(`\nSSH errored on ${errored.length}:`);
    for (const r of errored.slice(0, 10)) console.log(`  ${r.vm.name}  ${r.err}`);
  }

  if (!isExecute) { console.log("\nDRY-RUN — pass --execute to apply"); return; }

  // Apply: bulk-update by target version
  for (const target of new Set(moves.map(m => m.to))) {
    const ids = moves.filter(m => m.to === target).map(m => m.id);
    const { error } = await sb.from("instaclaw_vms").update({ config_version: target }).in("id", ids);
    if (error) console.error(`update to ${target} failed: ${error.message}`);
    else console.log(`  bumped ${ids.length} VMs to config_version=${target}`);
  }
  console.log("done");
})();
