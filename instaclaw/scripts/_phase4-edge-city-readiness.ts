/**
 * Phase 4b pre-flight: probe the 5 edge_city VMs for the known-unknowns
 * called out in docs/prd/gbrain-fleet-rollout-2026-05-12.md §10.
 *
 * Probes per VM:
 *   - Disk free (gbrain install needs ≥10GB free per PRD §5.3)
 *   - Bun version (skipped Phase B if already installed)
 *   - OpenClaw version (should be 2026.4.26 fleet-wide)
 *   - gcc + unzip present (build-essential + Phase B prereq)
 *   - GBRAIN_ANTHROPIC_API_KEY landed in .env (verifies stepEnvVarPush)
 *   - OPENAI_API_KEY length (sanity)
 *   - Existing gbrain install (idempotency signal)
 *   - Gateway active + /health=200
 *   - SOUL.md size (informational)
 *
 * Read-only. No mutations.
 */
import { readFileSync } from "fs";
import * as path from "path";
import { Client } from "ssh2";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const SSH_KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function ssh(host: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({ host, port: 22, username: "openclaw", privateKey: SSH_KEY, readyTimeout: 10_000 });
  });
}

function exec(c: Client, cmd: string, t: number): Promise<string> {
  return new Promise((resolve) => {
    let o = "";
    const tt = setTimeout(() => resolve(o + "\n[TIMEOUT]"), t);
    c.exec(cmd, (e, s) => {
      if (e) { clearTimeout(tt); return resolve("err: " + e.message); }
      s.on("data", (d: Buffer) => o += d.toString());
      s.stderr.on("data", (d: Buffer) => o += d.toString());
      s.on("close", () => { clearTimeout(tt); resolve(o); });
    });
  });
}

function upload(c: Client, content: string, p: string): Promise<void> {
  return new Promise((resolve, reject) => {
    c.sftp((e, sftp) => {
      if (e) return reject(e);
      const w = sftp.createWriteStream(p, { mode: 0o755 });
      w.on("close", () => resolve());
      w.on("error", reject);
      w.end(content);
    });
  });
}

interface VmProbe {
  vmName: string;
  ip: string;
  raw: string;
  parsed: Record<string, string>;
  err?: string;
}

function parseLine(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Tokens are "k=v" or "k=\"v with spaces\""
  const re = /(\w+)=(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out[m[1]] = m[2] ?? m[3] ?? "";
  }
  return out;
}

(async () => {
  console.log("Phase 4b pre-flight: readiness probe for 5 edge_city VMs\n");

  const { data: vms } = await sb.from("instaclaw_vms")
    .select("name,ip_address,config_version,tier,partner,assigned_to,health_status")
    .eq("partner", "edge_city")
    .eq("status", "assigned")
    .order("created_at", { ascending: true });
  if (!vms || vms.length === 0) {
    console.error("No edge_city VMs found");
    process.exit(1);
  }

  const userIds = Array.from(new Set((vms as any[]).map((v) => v.assigned_to).filter(Boolean)));
  const { data: users } = await sb.from("instaclaw_users").select("id,email").in("id", userIds);
  const emailById = new Map((users ?? []).map((u: any) => [u.id, u.email]));

  // The bash probe lives alongside this TS file in the repo (same scripts/ dir)
  // so it ships with the codebase. Previously read from /tmp/ which was
  // host-specific; this is portable.
  const script = readFileSync(
    path.resolve(__dirname, "edge-city-readiness-probe.sh"),
    "utf-8",
  );

  const results: VmProbe[] = [];
  for (const v of vms as any[]) {
    try {
      const c = await ssh(v.ip_address);
      await upload(c, script, "/tmp/edge-city-readiness-probe.sh");
      await exec(c, "chmod +x /tmp/edge-city-readiness-probe.sh", 5_000);
      const out = await exec(c, "bash /tmp/edge-city-readiness-probe.sh", 20_000);
      c.end();
      const line = out.split("\n").find((l) => l.startsWith("VM_READY")) ?? "";
      results.push({
        vmName: v.name,
        ip: v.ip_address,
        raw: out.trim(),
        parsed: parseLine(line),
      });
    } catch (e: any) {
      results.push({
        vmName: v.name,
        ip: v.ip_address,
        raw: "",
        parsed: {},
        err: String(e?.message ?? e),
      });
    }
  }

  // Compact table
  console.log(`${"VM".padEnd(22)} ${"cv".padStart(3)} ${"tier".padEnd(8)} ${"disk_GB".padStart(7)} ${"bun".padEnd(8)} ${"openclaw".padEnd(20)} ${"anth_key".padStart(8)} ${"openai".padStart(6)} ${"gbrain".padEnd(8)} ${"mcp".padStart(3)} ${"gw".padEnd(8)} ${"owner"}`);
  console.log("─".repeat(160));
  for (const r of results) {
    const v = (vms as any[]).find((x) => x.name === r.vmName);
    const owner = emailById.get(v?.assigned_to) ?? "?";
    if (r.err) {
      console.log(`${r.vmName.padEnd(22)} ${String(v?.config_version ?? "?").padStart(3)} ${(v?.tier ?? "?").padEnd(8)} SSH-ERR: ${r.err.slice(0, 80)}`);
      continue;
    }
    const p = r.parsed;
    console.log(
      `${r.vmName.padEnd(22)} ${String(v?.config_version).padStart(3)} ${(v?.tier ?? "?").padEnd(8)} ` +
      `${(p.disk_free_gb ?? "?").padStart(7)} ${(p.bun ?? "?").padEnd(8)} ${(p.openclaw ?? "?").padEnd(20)} ` +
      `${(p.anthropic_key_len ?? "0").padStart(8)} ${(p.openai_key_len ?? "0").padStart(6)} ` +
      `${(p.gbrain_version ?? "?").padEnd(8)} ${(p.gbrain_mcp ?? "0").padStart(3)} ` +
      `${(p.gateway_active === "active" && p.gateway_health === "200" ? "✓ a+200" : `${p.gateway_active}+${p.gateway_health}`).padEnd(8)} ` +
      `${owner}`,
    );
  }

  console.log("\n══ Readiness summary ══");
  let readyCount = 0;
  let blockers: string[] = [];
  for (const r of results) {
    if (r.err) { blockers.push(`${r.vmName}: SSH error`); continue; }
    const p = r.parsed;
    const diskGB = parseInt(p.disk_free_gb ?? "0", 10);
    const anthropicKeyOk = parseInt(p.anthropic_key_len ?? "0", 10) > 20;
    const openaiKeyOk = parseInt(p.openai_key_len ?? "0", 10) > 20;
    const openclawOk = (p.openclaw ?? "").includes("2026.4.26");
    const gatewayOk = p.gateway_active === "active" && p.gateway_health === "200";
    const alreadyGbrained = p.gbrain_version === "0.28.1" && p.gbrain_mcp === "1";
    const issues: string[] = [];
    if (diskGB < 10) issues.push(`disk_low(${diskGB}GB)`);
    if (!anthropicKeyOk) issues.push("anthropic_key_missing");
    if (!openaiKeyOk) issues.push("openai_key_missing");
    if (!openclawOk) issues.push(`openclaw=${p.openclaw}`);
    if (!gatewayOk) issues.push(`gw=${p.gateway_active}+${p.gateway_health}`);
    if (alreadyGbrained) {
      console.log(`  ${r.vmName}: ✓ ALREADY GBRAINED (v${p.gbrain_version}, mcp registered)`);
      readyCount++;
    } else if (issues.length === 0) {
      console.log(`  ${r.vmName}: ✓ ready for Phase 4b install`);
      readyCount++;
    } else {
      console.log(`  ${r.vmName}: ✗ BLOCKED — ${issues.join(", ")}`);
      blockers.push(`${r.vmName}: ${issues.join(", ")}`);
    }
  }

  console.log(`\n${readyCount}/${results.length} edge_city VMs ready (or already gbrained)`);
  if (blockers.length > 0) {
    console.log(`\n${blockers.length} VM(s) need attention before Phase 4b:`);
    for (const b of blockers) console.log(`  - ${b}`);
  }

  // Anthropic key distribution status (stepEnvVarPush observability)
  const withKey = results.filter((r) => parseInt(r.parsed.anthropic_key_len ?? "0", 10) > 20).length;
  console.log(`\nstepEnvVarPush status: ${withKey}/${results.length} edge_city VMs have GBRAIN_ANTHROPIC_API_KEY in .env.`);
  console.log(`(Reconciler propagates over ~3.5h post-deploy. Re-run this probe periodically to track coverage.)`);
})();
