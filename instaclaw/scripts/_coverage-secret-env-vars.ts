/**
 * Coverage tool for SECRET_ENV_VAR_SOURCES distribution across the fleet.
 *
 * Per Rule 27 ("Coverage Dashboards — Build the Query Before Shipping"):
 * every fleet-wide resource needs a coverage query operators can run in
 * <10 seconds. SECRET_ENV_VAR_SOURCES has had three additions in two days
 * (GBRAIN_ANTHROPIC_API_KEY, EDGEOS_BEARER_TOKEN, BRAVE_API_KEY) — this
 * tool surfaces:
 *
 *   1. DB view:      `secret_version` distribution across assigned+healthy VMs,
 *                    joint with config_version. Answers "how far is the
 *                    rollout?". Constant cost (one Supabase query).
 *
 *   2. On-disk view: SSH-probe a sample of N VMs (default 10, random),
 *                    grep ~/.openclaw/.env for each SECRET_ENV_VAR_SOURCES
 *                    key. Reports presence + a 10-char value prefix so
 *                    operators can spot stale values vs current. Respects
 *                    `partnerGate` (edge_city-only keys only checked on
 *                    edge_city VMs).
 *
 *   3. Drift summary: how many sampled VMs have each key missing, broken
 *                    down by current vs stale prefix.
 *
 * SECRET_ENV_VAR_SOURCES is re-declared below because the canonical version
 * at `lib/vm-reconcile.ts` is not exported. **If the canonical list changes,
 * mirror the change here.** A future cleanup is to export the canonical list.
 *
 * Usage:
 *   npx tsx instaclaw/scripts/_coverage-secret-env-vars.ts
 *   npx tsx instaclaw/scripts/_coverage-secret-env-vars.ts --sample=20
 *   npx tsx instaclaw/scripts/_coverage-secret-env-vars.ts --vm=vm-050
 *   npx tsx instaclaw/scripts/_coverage-secret-env-vars.ts --json
 */

import { readFileSync } from "fs";
import { Client } from "ssh2";

// ── Rule 18: load both env files ─────────────────────────────────────────────
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
  } catch { /* optional */ }
}
if (!process.env.SSH_PRIVATE_KEY_B64 || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("FATAL: SSH_PRIVATE_KEY_B64 or SUPABASE_SERVICE_ROLE_KEY missing");
  process.exit(2);
}
const SSH_KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const SUPABASE_URL = "https://qvrnuyzfqjrsjljcqbub.supabase.co";

// ── Canonical version: keep in sync with lib/vm-reconcile.ts ─────────────────
const SECRET_VERSION = 2;
interface SecretEnvVarSource {
  envKey: string;
  vercelKey?: string;
  label: string;
  partnerGate?: string;
}
const SECRET_ENV_VAR_SOURCES: SecretEnvVarSource[] = [
  { envKey: "GBRAIN_ANTHROPIC_API_KEY", label: "gbrain Anthropic project key" },
  { envKey: "EDGEOS_BEARER_TOKEN", label: "EdgeOS attendee directory JWT", partnerGate: "edge_city" },
  { envKey: "BRAVE_API_KEY", vercelKey: "BRAVE_SEARCH_API_KEY", label: "Brave Search API key" },
];

// ── CLI ──────────────────────────────────────────────────────────────────────
interface Args { sample: number; vmName: string | null; jsonOnly: boolean; }
function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string, def?: string): string | undefined => {
    const eq = a.find((x) => x.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = a.indexOf(flag);
    return i >= 0 && i + 1 < a.length ? a[i + 1] : def;
  };
  return {
    sample: parseInt(get("--sample", "10")!, 10),
    vmName: get("--vm") ?? null,
    jsonOnly: a.includes("--json"),
  };
}

// ── SSH helpers (mirror _repro-orphan-tool-use.ts pattern) ───────────────────
function sshConnect(host: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({ host, port: 22, username: "openclaw", privateKey: SSH_KEY, readyTimeout: 10_000 });
  });
}
function sshExec(c: Client, cmd: string, timeoutMs = 12_000):
  Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", code = -1, resolved = false;
    const tt = setTimeout(() => {
      if (!resolved) { resolved = true; resolve({ stdout, stderr: "TIMEOUT", code: -1 }); }
    }, timeoutMs);
    c.exec(cmd, (err, stream) => {
      if (err) { if (!resolved) { resolved = true; clearTimeout(tt); resolve({ stdout, stderr: String(err), code: -2 }); } return; }
      stream.on("data", (d: Buffer) => { stdout += d.toString(); });
      stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      stream.on("exit", (cc: number) => { code = cc; });
      stream.on("close", () => { if (!resolved) { resolved = true; clearTimeout(tt); resolve({ stdout, stderr, code }); } });
    });
  });
}

// ── Supabase ─────────────────────────────────────────────────────────────────
interface VmRow {
  id: string; name: string; ip_address: string | null;
  config_version: number | null; secret_version: number | null;
  health_status: string | null; status: string | null; partner: string | null;
}
async function sb(query: string): Promise<VmRow[]> {
  const h = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
  };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/instaclaw_vms?${query}`, { headers: h });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return await r.json();
}

// ── Phase 1: DB distribution ─────────────────────────────────────────────────
interface DbStats {
  total: number;
  bySecretVersion: Record<string, number>;
  byConfigVersion: Record<string, number>;
  jointSvCv: Record<string, number>;
  byPartner: Record<string, { total: number; bySv: Record<string, number> }>;
  atCurrentSv: number;
  atCurrentCv: number;
  rolloutPercentSv: number;
}
async function dbDistribution(): Promise<{ stats: DbStats; pool: VmRow[] }> {
  const pool = await sb(
    "status=eq.assigned&provider=eq.linode&health_status=eq.healthy" +
    "&select=id,name,ip_address,config_version,secret_version,health_status,status,partner" +
    "&order=name.asc"
  );

  const bySv: Record<string, number> = {};
  const byCv: Record<string, number> = {};
  const jointSvCv: Record<string, number> = {};
  const byPartner: Record<string, { total: number; bySv: Record<string, number> }> = {};
  let atCurrentSv = 0, atCurrentCv = 0;
  for (const v of pool) {
    const sv = v.secret_version ?? "null";
    const cv = v.config_version ?? "null";
    bySv[sv] = (bySv[sv] || 0) + 1;
    byCv[cv] = (byCv[cv] || 0) + 1;
    jointSvCv[`sv=${sv}/cv=${cv}`] = (jointSvCv[`sv=${sv}/cv=${cv}`] || 0) + 1;
    if ((v.secret_version ?? 0) >= SECRET_VERSION) atCurrentSv++;
    if ((v.config_version ?? 0) >= 100) atCurrentCv++;
    const p = v.partner ?? "(none)";
    if (!byPartner[p]) byPartner[p] = { total: 0, bySv: {} };
    byPartner[p].total++;
    byPartner[p].bySv[sv] = (byPartner[p].bySv[sv] || 0) + 1;
  }
  return {
    pool,
    stats: {
      total: pool.length, bySecretVersion: bySv, byConfigVersion: byCv,
      jointSvCv, byPartner, atCurrentSv, atCurrentCv,
      rolloutPercentSv: pool.length === 0 ? 0 : Math.round((atCurrentSv * 1000) / pool.length) / 10,
    },
  };
}

// ── Phase 2: On-disk SSH probe ───────────────────────────────────────────────
interface ProbeResult {
  vm: string; ip: string; partner: string | null;
  secretVersion: number | null;
  keyResults: Record<string, { present: boolean; prefix: string | null; valueLen: number; skipped: string | null }>;
  sshError: string | null;
}

async function probeVm(vm: VmRow): Promise<ProbeResult> {
  const out: ProbeResult = {
    vm: vm.name, ip: vm.ip_address ?? "?",
    partner: vm.partner, secretVersion: vm.secret_version,
    keyResults: {}, sshError: null,
  };
  if (!vm.ip_address) {
    out.sshError = "no ip_address";
    for (const e of SECRET_ENV_VAR_SOURCES) out.keyResults[e.envKey] = { present: false, prefix: null, valueLen: 0, skipped: "no ip" };
    return out;
  }
  let ssh: Client;
  try {
    ssh = await sshConnect(vm.ip_address);
  } catch (e) {
    out.sshError = String(e).slice(0, 100);
    for (const e2 of SECRET_ENV_VAR_SOURCES) out.keyResults[e2.envKey] = { present: false, prefix: null, valueLen: 0, skipped: "ssh fail" };
    return out;
  }
  try {
    // Pull all relevant lines in ONE SSH call (fast)
    const keys = SECRET_ENV_VAR_SOURCES.map((s) => s.envKey).join("|");
    const r = await sshExec(ssh, `grep -E "^(${keys})=" ~/.openclaw/.env 2>/dev/null`, 10_000);
    const present = new Map<string, string>();
    for (const line of r.stdout.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (!m) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, "");
      present.set(m[1], value);
    }
    for (const src of SECRET_ENV_VAR_SOURCES) {
      const skipped = src.partnerGate && vm.partner !== src.partnerGate
        ? `partnerGate=${src.partnerGate} (vm partner=${vm.partner ?? "null"})`
        : null;
      if (skipped) {
        out.keyResults[src.envKey] = { present: false, prefix: null, valueLen: 0, skipped };
        continue;
      }
      const val = present.get(src.envKey);
      out.keyResults[src.envKey] = {
        present: val != null,
        prefix: val ? val.slice(0, 10) : null,
        valueLen: val ? val.length : 0,
        skipped: null,
      };
    }
  } finally {
    ssh.end();
  }
  return out;
}

// ── Phase 3: report ──────────────────────────────────────────────────────────
function shuffle<T>(a: T[]): T[] {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function printReport(stats: DbStats, probes: ProbeResult[], jsonOnly: boolean): void {
  if (jsonOnly) {
    console.log(JSON.stringify({ secretVersion: SECRET_VERSION, dbStats: stats, probes }, null, 2));
    return;
  }

  console.log("");
  console.log("════════════════════════════════════════════════════════════════════════");
  console.log(`  SECRET_ENV_VAR_SOURCES coverage — target SECRET_VERSION=${SECRET_VERSION}`);
  console.log("════════════════════════════════════════════════════════════════════════");
  console.log("");
  console.log(`DB view (assigned + linode + healthy):  ${stats.total} VMs`);
  console.log(`At SECRET_VERSION=${SECRET_VERSION}+:    ${stats.atCurrentSv} / ${stats.total} (${stats.rolloutPercentSv}%)`);
  console.log(`At config_version=100+:                 ${stats.atCurrentCv} / ${stats.total}`);
  console.log("");
  console.log(`secret_version distribution: ${JSON.stringify(stats.bySecretVersion)}`);
  console.log(`config_version distribution: ${JSON.stringify(stats.byConfigVersion)}`);
  console.log("");

  console.log("Joint sv/cv (top 8):");
  const joint = Object.entries(stats.jointSvCv).sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [k, n] of joint) console.log(`  ${pad(k, 20)} ${n}`);
  console.log("");

  console.log("By partner:");
  for (const [p, info] of Object.entries(stats.byPartner)) {
    console.log(`  ${pad(p, 18)} total=${info.total}  sv=${JSON.stringify(info.bySv)}`);
  }
  console.log("");

  if (probes.length === 0) {
    console.log("(no on-disk probes performed; pass --sample=N or --vm=name)");
    return;
  }
  console.log("─────────────────────────────────────────────────────────────────────────");
  console.log(`On-disk probe (${probes.length} VM${probes.length === 1 ? "" : "s"})`);
  console.log("─────────────────────────────────────────────────────────────────────────");

  const headerKeys = SECRET_ENV_VAR_SOURCES.map((s) => pad(s.envKey.slice(-12), 12)).join(" ");
  console.log(`${pad("vm-name", 22)} ${pad("partner", 12)} ${pad("sv", 4)} ${headerKeys}`);
  for (const p of probes) {
    const cols = SECRET_ENV_VAR_SOURCES.map((s) => {
      const r = p.keyResults[s.envKey];
      if (r.skipped) return pad("SKIP", 12);
      if (!r.present) return pad("MISS", 12);
      return pad(`${r.prefix}…${r.valueLen}`, 12);
    }).join(" ");
    console.log(
      `${pad(p.vm, 22)} ${pad(p.partner ?? "(none)", 12)} ${pad(String(p.secretVersion ?? "?"), 4)} ${cols}`,
    );
    if (p.sshError) console.log(`  ↳ SSH error: ${p.sshError}`);
  }
  console.log("");

  // Drift summary
  const drift: Record<string, { miss: number; present: number; prefixes: Record<string, number> }> = {};
  for (const src of SECRET_ENV_VAR_SOURCES) {
    drift[src.envKey] = { miss: 0, present: 0, prefixes: {} };
  }
  for (const p of probes) {
    if (p.sshError) continue;
    for (const src of SECRET_ENV_VAR_SOURCES) {
      const r = p.keyResults[src.envKey];
      if (r.skipped) continue;
      if (!r.present) drift[src.envKey].miss++;
      else {
        drift[src.envKey].present++;
        const pf = r.prefix!;
        drift[src.envKey].prefixes[pf] = (drift[src.envKey].prefixes[pf] || 0) + 1;
      }
    }
  }
  console.log("Drift summary (per key, sampled VMs only):");
  for (const src of SECRET_ENV_VAR_SOURCES) {
    const d = drift[src.envKey];
    const pfStr = Object.entries(d.prefixes)
      .map(([p, n]) => `${p}…×${n}`)
      .join(", ");
    console.log(`  ${pad(src.envKey, 28)} present=${d.present}  miss=${d.miss}  prefixes=[${pfStr}]`);
    if (Object.keys(d.prefixes).length > 1) {
      console.log(`    ⚠ multiple prefixes detected — possible drift (some VMs at old value, some at new)`);
    }
  }
  console.log("");
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs();

  console.error(`Querying Supabase for fleet distribution...`);
  const t0 = Date.now();
  const { stats, pool } = await dbDistribution();
  console.error(`  ${stats.total} VMs in ${Date.now() - t0}ms`);

  let probes: ProbeResult[] = [];
  if (args.vmName) {
    const target = pool.find((v) => v.name === args.vmName || v.name === `instaclaw-${args.vmName}`);
    if (!target) { console.error(`VM not found: ${args.vmName}`); process.exit(2); }
    console.error(`Probing on-disk: ${target.name}...`);
    probes.push(await probeVm(target));
  } else if (args.sample > 0) {
    const targets = shuffle(pool).slice(0, args.sample);
    console.error(`Probing on-disk: ${targets.length} random VMs (parallel)...`);
    probes = await Promise.all(targets.map(probeVm));
  }

  printReport(stats, probes, args.jsonOnly);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack ?? e);
  process.exit(1);
});
