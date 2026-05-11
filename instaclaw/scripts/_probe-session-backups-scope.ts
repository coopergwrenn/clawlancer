/**
 * Fleet-wide probe of session-backups bloat (P1 follow-up to vm-512
 * incident, fix shipped 567f653b).
 *
 * Per VM: count files + total size in ~/.openclaw/session-backups/.
 * Output sorted by file count desc — top offenders surface first.
 *
 * The 567f653b fix prevents NEW runaway creation. Existing backlogs will
 * self-purge as the 7-day retention window expires. This probe surfaces
 * the existing scope so we know who's most at risk for ENOSPC in the
 * meantime.
 */
import { readFileSync } from "fs";
import { Client } from "ssh2";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}
const KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function exec(host: string, cmd: string, t = 15_000): Promise<string> {
  return new Promise((resolve) => {
    const c = new Client();
    let o = "";
    const tt = setTimeout(() => { try { c.end(); } catch { /* noop */ } resolve("[T]"); }, t);
    c.on("ready", () => c.exec(cmd, (e, s) => {
      if (e) { clearTimeout(tt); c.end(); return resolve("err: " + e.message); }
      s.on("data", (d: Buffer) => { o += d.toString(); });
      s.stderr.on("data", (d: Buffer) => { o += d.toString(); });
      s.on("close", () => { clearTimeout(tt); c.end(); resolve(o); });
    }));
    c.on("error", (e) => { clearTimeout(tt); resolve("cerr: " + e.message); });
    c.connect({ host, port: 22, username: "openclaw", privateKey: KEY, readyTimeout: 8_000 });
  });
}

const PROBE = `set +e
COUNT=$(find ~/.openclaw/session-backups -type f 2>/dev/null | wc -l)
SIZE_MB=$(du -sm ~/.openclaw/session-backups 2>/dev/null | awk '{print $1}')
DISK_USE=$(df / | awk 'NR==2 {print $5}' | tr -d '%')
DISK_AVAIL_GB=$(df -BG / | awk 'NR==2 {print $4}' | tr -d 'G')
echo "RES|count=$COUNT|size_mb=$SIZE_MB|disk_pct=$DISK_USE|disk_avail_gb=$DISK_AVAIL_GB"
`;

interface R {
  name: string;
  count: number;
  sizeMB: number;
  diskPct: number;
  diskAvailGB: number;
  err?: string;
}

async function main() {
  const t0 = Date.now();
  const { data: vms } = await sb
    .from("instaclaw_vms")
    .select("name, ip_address")
    .eq("status", "assigned")
    .eq("provider", "linode")
    .eq("health_status", "healthy");
  if (!vms) { console.error("DB query failed"); process.exit(1); }
  console.log(`Probing ${vms.length} healthy assigned VMs (concurrency=10)...\n`);

  const results: R[] = [];
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= vms.length) return;
      const vm = vms[i];
      const out = await exec(vm.ip_address, PROBE);
      const r: R = { name: vm.name, count: -1, sizeMB: -1, diskPct: -1, diskAvailGB: -1 };
      if (out.startsWith("[T]") || out.startsWith("err:") || out.startsWith("cerr:")) {
        r.err = out.slice(0, 80);
      } else {
        const line = out.split("\n").find((l) => l.startsWith("RES|")) ?? "";
        const parts: Record<string, string> = {};
        for (const p of line.replace(/^RES\|/, "").split("|")) {
          const [k, v] = p.split("=");
          if (k && v !== undefined) parts[k] = v;
        }
        r.count = parseInt(parts.count ?? "-1", 10);
        r.sizeMB = parseInt(parts.size_mb ?? "-1", 10);
        r.diskPct = parseInt(parts.disk_pct ?? "-1", 10);
        r.diskAvailGB = parseInt(parts.disk_avail_gb ?? "-1", 10);
      }
      results.push(r);
    }
  }
  await Promise.all(Array.from({ length: 10 }, () => worker()));

  console.log(`Probed ${results.length} VMs in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const reached = results.filter((r) => !r.err);
  const sorted = [...reached].sort((a, b) => b.count - a.count);

  console.log(`=== Top 25 by backup file count ===`);
  console.log(`${"name".padEnd(22)} ${"count".padStart(8)}  ${"size_MB".padStart(8)}  ${"disk%".padStart(5)}  ${"avail_GB".padStart(8)}`);
  for (const r of sorted.slice(0, 25)) {
    console.log(`${r.name.padEnd(22)} ${String(r.count).padStart(8)}  ${String(r.sizeMB).padStart(8)}  ${String(r.diskPct).padStart(5)}  ${String(r.diskAvailGB).padStart(8)}`);
  }

  // Bucket counts
  const buckets = [
    { name: ">100K files", filter: (r: R) => r.count > 100_000 },
    { name: "10K-100K files", filter: (r: R) => r.count > 10_000 && r.count <= 100_000 },
    { name: "1K-10K files", filter: (r: R) => r.count > 1_000 && r.count <= 10_000 },
    { name: "<1K files", filter: (r: R) => r.count >= 0 && r.count <= 1_000 },
    { name: "disk >85% used", filter: (r: R) => r.diskPct > 85 },
    { name: "disk >70% used", filter: (r: R) => r.diskPct > 70 && r.diskPct <= 85 },
    { name: "<5GB free", filter: (r: R) => r.diskAvailGB < 5 },
  ];
  console.log(`\n=== Distribution ===`);
  for (const b of buckets) {
    console.log(`  ${b.name.padEnd(20)} ${reached.filter(b.filter).length}`);
  }

  if (results.some((r) => r.err)) {
    console.log(`\nUnreachable: ${results.filter((r) => r.err).length}`);
  }
}

main().then(() => process.exit(0));
