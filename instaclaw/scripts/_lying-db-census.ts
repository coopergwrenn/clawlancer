/**
 * Lying-DB census — probe ALL cv>=88 VMs and classify by 6-point check.
 *
 * Output: lying-DB rate + per-VM classification, written to
 *   instaclaw/docs/lying-db-census-<date>.md
 *
 * Used to:
 *   - Get real fleet-wide rate (CLAUDE.md P1-1 elevated priority)
 *   - Surface VMs needing Phase C reset (consensus terminal)
 *   - Establish per-shape root-cause hypothesis (which reconciler step failed)
 *
 * Taxonomy (from CLAUDE.md P1-1):
 *   - HONEST                : all 6 pass
 *   - TOTAL_LIE             : TasksMax != 120 AND prctl_pkg missing AND drop-in missing
 *                              (neither v86 nor v87 applied; cv claims everything)
 *   - PARTIAL_LIE_DROPIN    : TasksMax OK, prctl drop-in PRESENT, prctl pkg MISSING
 *                              (drop-in landed but npm install half failed silently)
 *   - PARTIAL_LIE_OTHER     : any other failure combination
 *   - SCHEMA_ZERO_LIE       : TasksMax in (4666, 33%-of-pids), no v86 override.conf at all
 *                              (provisioning bumped cv before reconciler ran)
 *   - UNREACHABLE           : SSH timeout or connection error
 */
import { readFileSync, writeFileSync } from "fs";
import { Client } from "ssh2";
import { createClient } from "@supabase/supabase-js";
for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local", "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key"]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const SSH_KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function exec(host: string, cmd: string, t = 25_000): Promise<string> {
  return new Promise((resolve) => {
    const c = new Client(); let o = "";
    const tt = setTimeout(() => { try { c.end(); } catch {} resolve("[ssh timeout]"); }, t);
    c.on("ready", () => c.exec(cmd, (e, s) => {
      if (e) { clearTimeout(tt); c.end(); return resolve("err: " + e.message); }
      s.on("data", (d: Buffer) => o += d.toString());
      s.stderr.on("data", (d: Buffer) => o += d.toString());
      s.on("close", () => { clearTimeout(tt); c.end(); resolve(o); });
    }));
    c.on("error", (e) => { clearTimeout(tt); resolve("conn err: " + e.message); });
    c.connect({ host, port: 22, username: "openclaw", privateKey: SSH_KEY, readyTimeout: 8_000 });
  });
}

const PROBE = `set +e
source ~/.nvm/nvm.sh 2>/dev/null
T=$(systemctl --user show -p TasksMax --value openclaw-gateway 2>/dev/null)
G=$(command -v gcc >/dev/null 2>&1 && echo PRESENT || echo MISSING)
P=$(npm ls -g --depth=0 prctl-subreaper 2>/dev/null | grep -oE 'prctl-subreaper@[0-9]+\\.[0-9]+\\.[0-9]+' || echo MISSING)
D=$(test -f $HOME/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf && echo PRESENT || echo MISSING)
A=$(systemctl --user is-active openclaw-gateway 2>/dev/null)
H=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null || echo none)
OC=$(openclaw --version 2>/dev/null | head -1 | grep -oE 'OpenClaw [0-9]+\\.[0-9]+\\.[0-9]+' | head -c 40)
echo "T=$T|G=$G|P=$P|D=$D|A=$A|H=$H|OC=$OC"`;

type Shape = "HONEST" | "TOTAL_LIE" | "PARTIAL_LIE_DROPIN" | "PARTIAL_LIE_OTHER" | "SCHEMA_ZERO_LIE" | "UNREACHABLE";

interface Probe {
  vmName: string;
  ip: string;
  cv: number;
  tier: string;
  partner: string | null;
  ownerEmail: string;
  createdAt: string;
  // probe results
  tasksMax: string;
  gcc: string;
  prctlPkg: string;
  prctlDropin: string;
  gwActive: string;
  gwHealth: string;
  openclawVer: string;
  // verdict
  shape: Shape;
  reasons: string[];
}

function classify(p: Probe): { shape: Shape; reasons: string[] } {
  const reasons: string[] = [];
  if (p.tasksMax === "" || p.tasksMax === "[ssh timeout]" || p.tasksMax.includes("err")) return { shape: "UNREACHABLE", reasons: ["SSH/probe failed"] };

  const tasksMaxOk = p.tasksMax === "120";
  const gccOk = p.gcc === "PRESENT";
  const prctlPkgOk = p.prctlPkg !== "MISSING" && p.prctlPkg.length > 0;
  const prctlDropinOk = p.prctlDropin === "PRESENT";
  const gwOk = p.gwActive === "active" && p.gwHealth === "200";

  if (!tasksMaxOk) reasons.push(`TasksMax=${p.tasksMax} (want 120)`);
  if (!gccOk) reasons.push(`gcc missing`);
  if (!prctlPkgOk) reasons.push(`prctl-subreaper pkg missing`);
  if (!prctlDropinOk) reasons.push(`prctl-subreaper drop-in missing`);
  if (!gwOk) reasons.push(`gateway active=${p.gwActive} health=${p.gwHealth}`);

  if (tasksMaxOk && gccOk && prctlPkgOk && prctlDropinOk && gwOk) {
    return { shape: "HONEST", reasons };
  }

  // SCHEMA_ZERO_LIE: TasksMax is a SYSTEMD DEFAULT (4666, large, NOT 120 or 75) — means no override.conf at all
  if (p.tasksMax && !["120", "75"].includes(p.tasksMax) && parseInt(p.tasksMax, 10) > 1000) {
    return { shape: "SCHEMA_ZERO_LIE", reasons: [`TasksMax=${p.tasksMax} (systemd default, no override.conf)`, ...reasons.filter((r) => !r.startsWith("TasksMax="))] };
  }

  // TOTAL_LIE: TasksMax=75 (v75 vintage, no v86 applied) AND prctl pkg missing AND dropin missing
  if (p.tasksMax === "75" && !prctlPkgOk && !prctlDropinOk) {
    return { shape: "TOTAL_LIE", reasons };
  }

  // PARTIAL_LIE_DROPIN: TasksMax OK, dropin PRESENT, pkg MISSING
  if (tasksMaxOk && prctlDropinOk && !prctlPkgOk) {
    return { shape: "PARTIAL_LIE_DROPIN", reasons };
  }

  return { shape: "PARTIAL_LIE_OTHER", reasons };
}

async function probeOne(vm: any, emailById: Map<string, string>): Promise<Probe> {
  const out = await exec(vm.ip_address, PROBE, 25_000);
  const m: Record<string, string> = {};
  const line = out.split("\n").find((l) => l.startsWith("T=")) ?? "";
  for (const part of line.split("|")) {
    const [k, v] = part.split("=");
    if (k && v !== undefined) m[k] = v;
  }
  const p: Probe = {
    vmName: vm.name,
    ip: vm.ip_address,
    cv: vm.config_version,
    tier: vm.tier ?? "?",
    partner: vm.partner,
    ownerEmail: emailById.get(vm.assigned_to) ?? "<unknown>",
    createdAt: vm.created_at?.slice(0, 10) ?? "?",
    tasksMax: m.T ?? "",
    gcc: m.G ?? "",
    prctlPkg: m.P ?? "",
    prctlDropin: m.D ?? "",
    gwActive: m.A ?? "",
    gwHealth: m.H ?? "",
    openclawVer: m.OC ?? "",
    shape: "UNREACHABLE",
    reasons: [],
  };
  const c = classify(p);
  p.shape = c.shape;
  p.reasons = c.reasons;
  return p;
}

async function batched<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) {
    const batch = items.slice(i, i + n);
    const results = await Promise.all(batch.map(fn));
    out.push(...results);
    process.stdout.write(`  probed ${Math.min(i + n, items.length)}/${items.length}\n`);
  }
  return out;
}

(async () => {
  console.log("Lying-DB census — probing ALL cv>=88 assigned VMs\n");

  // 1. Pull all cv >= 88 healthy assigned VMs
  const { data: vms } = await sb.from("instaclaw_vms")
    .select("name,ip_address,tier,partner,assigned_to,config_version,health_status,health_fail_count,last_health_check,created_at")
    .eq("status", "assigned").eq("provider", "linode")
    .gte("config_version", 88);
  if (!vms) { console.error("DB query failed"); process.exit(1); }

  // Only probe healthy ones (suspended/hibernating gateways aren't running so probe is moot)
  const healthy = (vms as any[]).filter((v) => v.health_status === "healthy" && v.health_fail_count === 0);
  console.log(`${vms.length} VMs at cv>=88; ${healthy.length} healthy (probing those)`);
  console.log(`Skipping ${vms.length - healthy.length} non-healthy (suspended/hibernating).\n`);

  // 2. Resolve owner emails
  const userIds = Array.from(new Set(healthy.map((v) => v.assigned_to).filter(Boolean)));
  const { data: users } = await sb.from("instaclaw_users").select("id,email").in("id", userIds);
  const emailById = new Map((users ?? []).map((u: any) => [u.id, u.email]));

  // 3. Probe in parallel batches of 10
  const t0 = Date.now();
  const probes = await batched(healthy, 10, (v) => probeOne(v, emailById));
  console.log(`\nProbed ${probes.length} VMs in ${Math.round((Date.now() - t0) / 1000)}s\n`);

  // 4. Group by shape
  const byShape: Record<Shape, Probe[]> = {
    HONEST: [], TOTAL_LIE: [], PARTIAL_LIE_DROPIN: [], PARTIAL_LIE_OTHER: [], SCHEMA_ZERO_LIE: [], UNREACHABLE: [],
  };
  for (const p of probes) byShape[p.shape].push(p);

  console.log("══ Shape distribution ══");
  for (const s of Object.keys(byShape) as Shape[]) {
    const n = byShape[s].length;
    const pct = ((n / probes.length) * 100).toFixed(1);
    console.log(`  ${s.padEnd(22)} ${String(n).padStart(3)} (${pct}%)`);
  }
  const lying = probes.length - byShape.HONEST.length - byShape.UNREACHABLE.length;
  const lyingPct = ((lying / (probes.length - byShape.UNREACHABLE.length)) * 100).toFixed(1);
  console.log(`\n  TOTAL LYING-DB (excluding unreachable): ${lying}/${probes.length - byShape.UNREACHABLE.length} (${lyingPct}%)\n`);

  // 5. Per-VM listing (lying ones only, grouped by shape)
  for (const s of ["TOTAL_LIE", "PARTIAL_LIE_DROPIN", "PARTIAL_LIE_OTHER", "SCHEMA_ZERO_LIE", "UNREACHABLE"] as Shape[]) {
    const list = byShape[s];
    if (list.length === 0) continue;
    console.log(`══ ${s} (${list.length}) ══`);
    for (const p of list) {
      console.log(`  ${p.vmName.padEnd(20)} ip=${p.ip.padEnd(16)} cv=${p.cv} tier=${p.tier.padEnd(8)} owner=${p.ownerEmail.padEnd(35)} created=${p.createdAt}`);
      console.log(`     T=${p.tasksMax} G=${p.gcc} P=${p.prctlPkg || "MISSING"} D=${p.prctlDropin} A=${p.gwActive} H=${p.gwHealth}`);
      if (p.reasons.length > 0) console.log(`     reasons: ${p.reasons.join(", ")}`);
    }
    console.log("");
  }

  // 6. Write markdown report for consensus terminal
  const date = new Date().toISOString().slice(0, 10);
  const reportPath = `/Users/cooperwrenn/wild-west-bots/instaclaw/docs/lying-db-census-${date}.md`;
  const lines: string[] = [];
  lines.push(`# Lying-DB census — ${date}`);
  lines.push("");
  lines.push(`Total VMs at cv>=88 (assigned): **${vms.length}**`);
  lines.push(`Healthy + probed: **${probes.length}**`);
  lines.push(`Lying-DB rate: **${lying}/${probes.length - byShape.UNREACHABLE.length} (${lyingPct}%)** (excluding unreachable)`);
  lines.push("");
  lines.push("## Shape distribution");
  lines.push("");
  lines.push("| Shape | Count | % |");
  lines.push("|---|---|---|");
  for (const s of Object.keys(byShape) as Shape[]) {
    const n = byShape[s].length;
    const pct = ((n / probes.length) * 100).toFixed(1);
    lines.push(`| ${s} | ${n} | ${pct}% |`);
  }
  lines.push("");

  for (const s of ["TOTAL_LIE", "PARTIAL_LIE_DROPIN", "PARTIAL_LIE_OTHER", "SCHEMA_ZERO_LIE", "UNREACHABLE"] as Shape[]) {
    const list = byShape[s];
    if (list.length === 0) continue;
    lines.push(`## ${s} (${list.length} VMs)`);
    lines.push("");
    lines.push("| VM | IP | cv | tier | owner | created | T | G | P | D | A | H |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const p of list) {
      lines.push(`| ${p.vmName} | ${p.ip} | ${p.cv} | ${p.tier} | ${p.ownerEmail} | ${p.createdAt} | ${p.tasksMax} | ${p.gcc} | ${p.prctlPkg || "MISSING"} | ${p.prctlDropin} | ${p.gwActive} | ${p.gwHealth} |`);
    }
    lines.push("");
  }

  lines.push("## Honest VMs (for reference)");
  lines.push("");
  lines.push(`${byShape.HONEST.length} VMs passed all 6 checks. Names:`);
  lines.push("");
  for (const p of byShape.HONEST) lines.push(`- ${p.vmName} (${p.tier}, cv=${p.cv})`);
  lines.push("");

  lines.push("## For consensus terminal");
  lines.push("");
  lines.push("All non-HONEST VMs should be candidates for Phase C cohort reset (drop cv to a pre-bug version so reconciler re-processes). Specifically:");
  lines.push("");
  for (const s of ["TOTAL_LIE", "PARTIAL_LIE_DROPIN", "PARTIAL_LIE_OTHER", "SCHEMA_ZERO_LIE"] as Shape[]) {
    if (byShape[s].length === 0) continue;
    lines.push(`### ${s} — recommend reset to cv=${s === "TOTAL_LIE" ? "82" : "86"}`);
    for (const p of byShape[s]) {
      lines.push(`- \`${p.vmName}\` (${p.tier}, ${p.ownerEmail}) — ${p.reasons.join("; ")}`);
    }
    lines.push("");
  }

  writeFileSync(reportPath, lines.join("\n"));
  console.log(`\nReport written: ${reportPath}`);
})();
