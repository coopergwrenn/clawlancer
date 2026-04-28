/**
 * Permanent ops tool: audit configureOpenClaw deploys vs actual VM state.
 *
 * Usage:
 *   npx tsx scripts/_full-configureOpenClaw-audit.ts                  # 5 stratified samples
 *   npx tsx scripts/_full-configureOpenClaw-audit.ts --vm vm-561      # single VM
 *   npx tsx scripts/_full-configureOpenClaw-audit.ts --all            # whole fleet (slow)
 *   npx tsx scripts/_full-configureOpenClaw-audit.ts --filter='no'    # only show failing items
 *
 * Pairs with scripts/_audit_remote.sh (uploaded via SFTP, executed remotely,
 * emits structured key=value output).
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { resolve, join } from "path";

const envLocal = readFileSync(resolve(".", ".env.local"), "utf-8");
for (const l of envLocal.split("\n")) {
  const m = l.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const envVercel = readFileSync(resolve(".", ".env.vercel"), "utf-8");
let sshKeyB64 = "";
for (const l of envVercel.split("\n")) {
  const m = l.match(/^SSH_PRIVATE_KEY_B64=(.*)$/);
  if (m) { sshKeyB64 = m[1].trim().replace(/^["']|["']$/g, ""); break; }
}
const SSH_KEY = Buffer.from(sshKeyB64, "base64").toString("utf-8");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const AUDIT_SCRIPT = readFileSync(join(process.cwd(), "scripts/_audit_remote.sh"));

const argVm = process.argv.find(a => a.startsWith("--vm"))?.split("=")[1] || (process.argv.includes("--vm") ? process.argv[process.argv.indexOf("--vm") + 1] : null);
const argAll = process.argv.includes("--all");
const failingOnly = process.argv.some(a => a.includes("--filter") && a.includes("no"));

interface AuditRow { vm: string; ip: string; data: Record<string, string>; err?: string; created: string; tier: string; }

async function audit(vm: any): Promise<AuditRow> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: vm.ip_address, port: 22, username: "openclaw", privateKey: SSH_KEY, readyTimeout: 12000 });
    const sftp = await ssh.requestSFTP();
    await new Promise<void>((res, rej) => sftp.writeFile("/tmp/_audit.sh", AUDIT_SCRIPT, (err) => err ? rej(err) : res()));
    sftp.end();
    const r = await ssh.execCommand("bash /tmp/_audit.sh; rm -f /tmp/_audit.sh");
    ssh.dispose();
    const data: Record<string, string> = {};
    for (const line of r.stdout.split("\n")) {
      const m = line.match(/^([^=]+)=(.*)$/);
      if (m) data[m[1].trim()] = m[2].trim();
    }
    return { vm: vm.name, ip: vm.ip_address, data, created: vm.created_at?.slice(0,10) || "?", tier: vm.tier || "?" };
  } catch (e: any) {
    try { ssh.dispose(); } catch {}
    return { vm: vm.name, ip: vm.ip_address, data: {}, err: (e.message || "?").slice(0, 80), created: "?", tier: "?" };
  }
}

(async () => {
  let sample: any[];
  if (argVm) {
    const name = argVm.startsWith("instaclaw-") ? argVm : `instaclaw-${argVm}`;
    const { data: vm } = await sb.from("instaclaw_vms").select("name, ip_address, created_at, tier").eq("name", name).single();
    if (!vm) { console.error("VM not found: " + name); return; }
    sample = [vm];
  } else {
    const { data: pool } = await sb
      .from("instaclaw_vms")
      .select("name, ip_address, created_at, tier")
      .eq("status", "assigned")
      .eq("health_status", "healthy")
      .like("name", "instaclaw-vm-%")
      .not("gateway_token", "is", null);
    if (!pool || pool.length < 5) { console.error("not enough VMs"); return; }
    pool.sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (argAll) {
      sample = pool;
    } else {
      const idx = [0, Math.floor(pool.length * 0.25), Math.floor(pool.length * 0.5), Math.floor(pool.length * 0.75), pool.length - 1];
      sample = idx.map(i => pool[i]);
    }
  }

  console.log(`Auditing ${sample.length} VM(s):`);
  for (const v of sample) console.log(`  ${v.name.padEnd(22)} ${v.ip_address.padEnd(17)} created=${(v.created_at||"").slice(0, 10)}  tier=${v.tier}`);
  console.log("");

  const rows: AuditRow[] = [];
  const queue = [...sample];
  while (queue.length) {
    const batch = queue.splice(0, 10);
    const r = await Promise.all(batch.map(audit));
    rows.push(...r);
    if (sample.length > 10) process.stderr.write(`  audited ${rows.length}/${sample.length}\r`);
  }

  const allKeys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.data)) allKeys.add(k);
  const keys = Array.from(allKeys);

  const sections: Record<string, string[]> = {};
  for (const k of keys) {
    const sec = k.split(".")[0];
    (sections[sec] ||= []).push(k);
  }

  const cw = 11;
  const vmLabels = rows.map(r => r.vm.replace("instaclaw-vm-", "").padEnd(cw));

  console.log("\n" + "═".repeat(40 + cw * rows.length + 4));
  console.log(`CONFIGUREOPENCLAW DEPLOY AUDIT — ${rows.length} VMs`);
  console.log("═".repeat(40 + cw * rows.length + 4));
  console.log(`  ${"deploy item".padEnd(38)}  ${vmLabels.join("")}`);
  console.log(`  ${"─".repeat(38)}  ${rows.map(()=>"─".repeat(cw-1)+" ").join("")}`);

  const sectionOrder = ["scripts", "home", "ws", "cfg", "skill", "sysd", "cron", "port", "tls", "bin", "nvm", "npm", "host", "gw"];
  for (const sec of sectionOrder) {
    if (!sections[sec]) continue;
    const sectionKeys = sections[sec].sort();
    const filtered = failingOnly ? sectionKeys.filter(k => rows.some(r => r.data[k] === "no")) : sectionKeys;
    if (filtered.length === 0) continue;
    console.log(`  [${sec}]`);
    for (const k of filtered) {
      const cells = rows.map(r => {
        const v = r.data[k];
        if (v === "yes") return "✓".padEnd(cw);
        if (v === "no") return "✗".padEnd(cw);
        if (v === undefined) return "-".padEnd(cw);
        return v.slice(0, cw - 2).padEnd(cw);
      });
      console.log(`  ${k.padEnd(38)}  ${cells.join("")}`);
    }
  }

  const errs = rows.filter(r => r.err);
  if (errs.length) {
    console.log("\nSSH/audit errors:");
    for (const e of errs) console.log(`  ${e.vm}: ${e.err}`);
  }

  if (rows.length > 1) {
    console.log("\n" + "─".repeat(60));
    console.log("Per-VM red counts:");
    for (const r of rows) {
      const reds = Object.entries(r.data).filter(([, v]) => v === "no").map(([k]) => k);
      console.log(`  ${r.vm.padEnd(22)} created=${r.created} tier=${r.tier.padEnd(8)} ${reds.length} red`);
    }

    console.log("\nMost-broken deploys (red count out of " + rows.length + "):");
    const byKey: Array<[string, number]> = [];
    for (const k of keys) {
      const n = rows.filter(r => r.data[k] === "no").length;
      if (n > 0) byKey.push([k, n]);
    }
    byKey.sort((a, b) => b[1] - a[1]);
    for (const [k, n] of byKey) console.log(`  ${n}/${rows.length}  ${k}`);
  }
})();
