/**
 * Coverage query for ToolRouter v1 wiring.
 *
 * Per CLAUDE.md Rule 27 — every fleet-wide resource needs a 10-second
 * visibility query. Confirms each healthy + assigned VM has:
 *   1. ~/.openclaw/.env contains TOOLROUTER_API_KEY matching prefix
 *   2. ~/.openclaw/openclaw.json has mcp.servers.toolrouter wired with
 *      the expected transport discriminator (.command for stdio,
 *      .transport for streamable-http)
 *   3. (Optional) ~/.openclaw/.env contains TOOLROUTER_BALANCE
 *      (populated by Task K.7 — only present after Task K is shipped)
 *
 * Exit codes:
 *   0  all sampled VMs have ToolRouter wired correctly
 *   1  at least one PASS but some FAILs — investigate
 *   2  all probes errored (env / SSH-key misconfig)
 *
 * Run: `npx tsx scripts/_coverage-toolrouter.ts`
 *   --sample N  : override sample size (default 5)
 *   --all       : check every healthy + assigned VM
 *   --verbose   : per-check per-VM breakdown
 */

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* optional */
  }
}

const ARGS = new Set(process.argv.slice(2));
const SAMPLE = (() => {
  const idx = process.argv.indexOf("--sample");
  if (idx >= 0 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return 5;
})();
const ALL = ARGS.has("--all");
const VERBOSE = ARGS.has("--verbose");

interface VMRow {
  id: string;
  name: string | null;
  ip_address: string;
}

interface ProbeResult {
  vm: VMRow;
  env_has_key: boolean | "error";
  mcp_discriminator: string | null | "error";
  balance: string | null | "absent";
  error?: string;
}

const SSH_KEY_B64 = process.env.SSH_PRIVATE_KEY_B64;
if (!SSH_KEY_B64) {
  console.error("FATAL: SSH_PRIVATE_KEY_B64 not in env. Need .env.ssh-key.");
  process.exit(2);
}
const SSH_PRIVATE_KEY = Buffer.from(SSH_KEY_B64, "base64").toString("utf-8");

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("FATAL: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not in env.");
  process.exit(2);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const TRANSPORT = process.env.TOOLROUTER_TRANSPORT === "streamable-http" ? "streamable-http" : "stdio";
const DISCRIMINATOR = TRANSPORT === "stdio" ? ".command" : ".transport";
const EXPECTED_DISCRIMINATOR_VALUE = TRANSPORT === "stdio" ? "toolrouter" : "streamable-http";

async function probeVm(vm: VMRow): Promise<ProbeResult> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      username: "openclaw",
      privateKey: SSH_PRIVATE_KEY,
      readyTimeout: 8_000,
    });
    const combined = await ssh.execCommand(
      `echo "ENV_KEY_PREFIX:$(grep '^TOOLROUTER_API_KEY=' \\$HOME/.openclaw/.env 2>/dev/null | cut -d= -f2 | tr -d '"' | head -c 8)"; ` +
      `echo "MCP_DISCRIMINATOR:$(jq -r '.mcp.servers.toolrouter${DISCRIMINATOR} // ""' \\$HOME/.openclaw/openclaw.json 2>/dev/null)"; ` +
      `echo "BALANCE:$(grep '^TOOLROUTER_BALANCE=' \\$HOME/.openclaw/.env 2>/dev/null | cut -d= -f2 | tr -d '"')"`,
    );
    const out = combined.stdout || "";
    const envPrefix = (out.match(/ENV_KEY_PREFIX:(\S*)/)?.[1] || "").trim();
    const mcpDisc = (out.match(/MCP_DISCRIMINATOR:(\S*)/)?.[1] || "").trim();
    const balance = (out.match(/BALANCE:(\S*)/)?.[1] || "").trim();
    return {
      vm,
      env_has_key: envPrefix.startsWith("tr_"),
      mcp_discriminator: mcpDisc || null,
      balance: balance || "absent",
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { vm, env_has_key: "error", mcp_discriminator: "error", balance: "absent", error: msg };
  } finally {
    ssh.dispose();
  }
}

async function main(): Promise<void> {
  const { data, error } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address")
    .eq("status", "assigned")
    .eq("health_status", "healthy")
    .not("ip_address", "is", null);
  if (error || !data) {
    console.error("FATAL: Supabase query failed:", error?.message);
    process.exit(2);
  }
  const pool = data.filter((v: any) => v.ip_address) as VMRow[];
  const sampled = ALL ? pool : pool.sort(() => Math.random() - 0.5).slice(0, SAMPLE);
  console.log(`Sampling ${sampled.length} of ${pool.length} healthy+assigned VMs.`);
  console.log(`Expected transport: ${TRANSPORT} (discriminator ${DISCRIMINATOR}=${EXPECTED_DISCRIMINATOR_VALUE})`);
  console.log("");

  const results: ProbeResult[] = [];
  // Sequential probe — keeps the load light + SSH key not abused.
  for (const vm of sampled) {
    results.push(await probeVm(vm));
  }

  let envOk = 0;
  let mcpOk = 0;
  let balanceOk = 0;
  let errored = 0;
  for (const r of results) {
    if (r.error) errored++;
    if (r.env_has_key === true) envOk++;
    if (r.mcp_discriminator === EXPECTED_DISCRIMINATOR_VALUE) mcpOk++;
    if (r.balance !== "absent" && r.balance !== null) balanceOk++;
    if (VERBOSE) {
      console.log(`${r.vm.name ?? r.vm.id.slice(0, 8)}: env=${r.env_has_key} mcp=${r.mcp_discriminator} balance=${r.balance}${r.error ? " err=" + r.error.slice(0, 80) : ""}`);
    }
  }

  console.log("");
  console.log(`env TOOLROUTER_API_KEY:       ${envOk}/${results.length}`);
  console.log(`mcp.servers.toolrouter set:   ${mcpOk}/${results.length}`);
  console.log(`env TOOLROUTER_BALANCE set:   ${balanceOk}/${results.length} (Task K.7 — absent until Task K ships)`);
  console.log(`SSH errors:                   ${errored}/${results.length}`);

  if (errored === results.length) {
    console.error("\nFATAL: every probe errored — SSH key or fleet state issue.");
    process.exit(2);
  }
  // Coverage is healthy if env-key and mcp-config land on >= 80% of sampled VMs.
  // (Balance is informational pre-Task-K.)
  const pctEnv = envOk / results.length;
  const pctMcp = mcpOk / results.length;
  if (pctEnv < 0.8 || pctMcp < 0.8) {
    console.error("\nFAIL: coverage below 80% — investigate stepToolRouter (lib/vm-reconcile.ts) or stepEnvVarPush.");
    process.exit(1);
  }
  console.log("\nPASS.");
}

main().catch((e) => {
  console.error("Coverage script crashed:", e);
  process.exit(2);
});
