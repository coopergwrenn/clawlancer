/**
 * Canary — drive a single edge_city VM through stepIndexProvision via the
 * deployed `/api/admin/reconcile-vm` route, then verify end-to-end.
 *
 * Why hit the deployed route instead of running reconcileVM locally:
 *   INDEX_NETWORK_ID + INDEX_NETWORK_MASTER_KEY are Encrypted-type Vercel env
 *   vars that don't pull cleanly via `vercel env pull` — the values are
 *   redacted to empty. The cleanest path to a real canary is to invoke the
 *   admin route over HTTPS; the route runs server-side on Vercel where the
 *   env vars resolve.
 *
 * Pre-state: prints index_user_id / index_api_key / index_provisioned_at
 *   for the target VM (expect: all NULL on first run).
 *
 * Trigger: POST /api/admin/reconcile-vm { vmId, strict: false, dryRun: false }
 *   The reconcile-vm route runs auditVMConfig() which calls reconcileVM(),
 *   which runs every step including stepIndexProvision.
 *
 * Post-state: re-reads the DB row + SSHs to the VM and:
 *   1. confirms DB columns now populated
 *   2. confirms ~/.openclaw/openclaw.json has mcp.servers.index.transport = "streamable-http"
 *   3. confirms gbrain MCP is still wired (no regression)
 *   4. confirms gateway is active + /health=200
 *
 * Usage:
 *   npx tsx scripts/_canary-index-provision.ts <vm-name-or-id>
 *
 * Default target: vm-050 (Cooper's test agent). Override via CLI arg.
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";

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
    // .env.ssh-key optional
  }
}

const target = process.argv[2] ?? "instaclaw-vm-050";
const PROD_BASE = process.env.CANARY_BASE_URL ?? "https://instaclaw.io";

if (!process.env.ADMIN_API_KEY) {
  console.error("✗ ADMIN_API_KEY not in env. Run `npx vercel env pull .env.local` and try again.");
  process.exit(1);
}
if (!process.env.SSH_PRIVATE_KEY_B64) {
  console.error("✗ SSH_PRIVATE_KEY_B64 not in env. Need .env.ssh-key loaded.");
  process.exit(1);
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface VMRow {
  id: string;
  name: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  partner: string | null;
  assigned_to: string | null;
  config_version: number;
  health_status: string;
  index_user_id: string | null;
  index_api_key: string | null;
  index_provisioned_at: string | null;
  index_provisioned_failed_at: string | null;
}

function pretty(row: VMRow | null) {
  if (!row) {
    console.log("  (no row)");
    return;
  }
  console.log(`  name              : ${row.name}`);
  console.log(`  ip                : ${row.ip_address}`);
  console.log(`  partner           : ${row.partner ?? "(null)"}`);
  console.log(`  assigned_to       : ${row.assigned_to ?? "(null)"}`);
  console.log(`  config_version    : ${row.config_version}`);
  console.log(`  health_status     : ${row.health_status}`);
  console.log(`  index_user_id     : ${row.index_user_id ?? "(null)"}`);
  console.log(`  index_api_key     : ${row.index_api_key ? "ix_" + row.index_api_key.slice(3, 8) + "…" : "(null)"}`);
  console.log(`  index_provisioned : ${row.index_provisioned_at ?? "(null)"}`);
  console.log(`  index_failed_at   : ${row.index_provisioned_failed_at ?? "(null)"}`);
}

async function loadVM(): Promise<VMRow> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(target);
  const q = sb
    .from("instaclaw_vms")
    .select(
      "id, name, ip_address, ssh_port, ssh_user, partner, assigned_to, config_version, health_status, index_user_id, index_api_key, index_provisioned_at, index_provisioned_failed_at",
    );
  const { data, error } = isUuid
    ? await q.eq("id", target).single()
    : await q.eq("name", target).single();
  if (error || !data) {
    throw new Error(`could not find VM "${target}": ${error?.message ?? "no rows"}`);
  }
  return data as unknown as VMRow;
}

async function probeVM(ip: string, sshUser: string, sshPort: number) {
  const ssh = new NodeSSH();
  const privateKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
  await ssh.connect({ host: ip, username: sshUser, port: sshPort, privateKey, readyTimeout: 10000 });
  try {
    const indexT = await ssh.execCommand(
      `jq -r '.mcp.servers.index.transport // "MISSING"' "$HOME/.openclaw/openclaw.json"`,
    );
    const indexU = await ssh.execCommand(
      `jq -r '.mcp.servers.index.url // "MISSING"' "$HOME/.openclaw/openclaw.json"`,
    );
    const indexK = await ssh.execCommand(
      `jq -r '.mcp.servers.index.headers["x-api-key"] // "MISSING"' "$HOME/.openclaw/openclaw.json"`,
    );
    const gbrainT = await ssh.execCommand(
      `jq -r '.mcp.servers.gbrain.transport // "MISSING"' "$HOME/.openclaw/openclaw.json"`,
    );
    const gwStatus = await ssh.execCommand(
      `systemctl --user is-active openclaw-gateway 2>/dev/null || echo dead`,
    );
    const gwHealth = await ssh.execCommand(
      `curl -sf -o /dev/null -w "%{http_code}" http://localhost:18789/health || echo conn-fail`,
    );
    return {
      indexTransport: (indexT.stdout || "").trim(),
      indexUrl: (indexU.stdout || "").trim(),
      indexKeyPrefix: (indexK.stdout || "").trim().slice(0, 8),
      gbrainTransport: (gbrainT.stdout || "").trim(),
      gatewayStatus: (gwStatus.stdout || "").trim(),
      gatewayHealth: (gwHealth.stdout || "").trim(),
    };
  } finally {
    ssh.dispose();
  }
}

async function main() {
  console.log(`\n=== Canary: stepIndexProvision via ${PROD_BASE} ===`);
  console.log(`Target: ${target}\n`);

  // ── Pre-state ──
  console.log("Pre-state (DB):");
  const pre = await loadVM();
  pretty(pre);

  if (pre.partner !== "edge_city") {
    console.error(`\n✗ ${pre.name} is partner=${pre.partner ?? "null"}, not edge_city. Cannot canary.`);
    process.exit(2);
  }
  if (!pre.assigned_to) {
    console.error(`\n✗ ${pre.name} has no assigned_to. Cannot provision.`);
    process.exit(3);
  }

  console.log("\nPre-state (disk SSH probe):");
  let preDisk;
  try {
    preDisk = await probeVM(pre.ip_address, pre.ssh_user, pre.ssh_port);
    console.log(`  index.transport   : ${preDisk.indexTransport}`);
    console.log(`  index.url         : ${preDisk.indexUrl}`);
    console.log(`  index.key (prefix): ${preDisk.indexKeyPrefix}`);
    console.log(`  gbrain.transport  : ${preDisk.gbrainTransport}`);
    console.log(`  gateway status    : ${preDisk.gatewayStatus}`);
    console.log(`  /health           : ${preDisk.gatewayHealth}`);
  } catch (err: any) {
    console.error(`✗ SSH probe failed: ${err.message}`);
    process.exit(4);
  }

  // ── Trigger reconcile via deployed admin route ──
  console.log(`\nTriggering: POST ${PROD_BASE}/api/admin/reconcile-vm ...`);
  const t0 = Date.now();
  const res = await fetch(`${PROD_BASE}/api/admin/reconcile-vm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": process.env.ADMIN_API_KEY!,
    },
    body: JSON.stringify({ vmId: pre.id, strict: false, dryRun: false }),
  });
  const elapsed = Math.round((Date.now() - t0) / 1000);
  const bodyText = await res.text();
  console.log(`Response: ${res.status} (${elapsed}s)`);
  if (!res.ok) {
    console.error(`✗ admin/reconcile-vm failed:\n${bodyText.slice(0, 800)}`);
    process.exit(5);
  }
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    console.error("✗ non-JSON response:", bodyText.slice(0, 400));
    process.exit(6);
  }

  console.log(`\nReconcile result summary:`);
  console.log(`  fixed[${body.fixed?.length ?? 0}]:        ${(body.fixed ?? []).filter((s: string) => /index/i.test(s)).join(", ") || "(none about index)"}`);
  console.log(`  warnings[${body.warnings?.length ?? 0}]:     ${(body.warnings ?? []).filter((s: string) => /index/i.test(s)).join(", ") || "(none about index)"}`);
  console.log(`  errors[${body.errors?.length ?? 0}]:       ${(body.errors ?? []).slice(0, 3).join(" | ") || "(none)"}`);
  console.log(`  strictErrors[${body.strictErrors?.length ?? 0}]: ${(body.strictErrors ?? []).slice(0, 2).join(" | ") || "(none)"}`);
  console.log(`  canaryHealthy:      ${body.canaryHealthy}`);

  // ── Post-state (DB) ──
  console.log("\nPost-state (DB):");
  const post = await loadVM();
  pretty(post);

  // ── Post-state (disk) ──
  console.log("\nPost-state (disk SSH probe):");
  const postDisk = await probeVM(post.ip_address, post.ssh_user, post.ssh_port);
  console.log(`  index.transport   : ${postDisk.indexTransport}`);
  console.log(`  index.url         : ${postDisk.indexUrl}`);
  console.log(`  index.key (prefix): ${postDisk.indexKeyPrefix}`);
  console.log(`  gbrain.transport  : ${postDisk.gbrainTransport}`);
  console.log(`  gateway status    : ${postDisk.gatewayStatus}`);
  console.log(`  /health           : ${postDisk.gatewayHealth}`);

  // ── Verdict ──
  console.log("\n=== Verdict ===");
  const checks: Array<[string, boolean, string]> = [
    ["DB.index_user_id populated", !!post.index_user_id, post.index_user_id ?? "(null)"],
    ["DB.index_api_key populated", !!post.index_api_key, post.index_api_key ? "ix_" + post.index_api_key.slice(3, 8) + "…" : "(null)"],
    ["DB.index_provisioned_at set", !!post.index_provisioned_at, post.index_provisioned_at ?? "(null)"],
    ["disk.mcp.servers.index.transport=streamable-http", postDisk.indexTransport === "streamable-http", postDisk.indexTransport],
    ["disk.mcp.servers.index.url is protocol.index.network", /protocol\.index\.network/.test(postDisk.indexUrl), postDisk.indexUrl],
    ["disk gbrain MCP still wired (regression check)", postDisk.gbrainTransport === "streamable-http", postDisk.gbrainTransport],
    ["gateway active", postDisk.gatewayStatus === "active", postDisk.gatewayStatus],
    ["/health = 200", postDisk.gatewayHealth === "200", postDisk.gatewayHealth],
  ];
  let pass = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(50)} ${detail}`);
    if (ok) pass++;
  }
  console.log(`\n  ${pass}/${checks.length} checks passed.`);
  if (pass === checks.length) {
    console.log("\n  CANARY GREEN. Safe to roll out to remaining edge_city VMs via reconcile-fleet cron.");
    process.exit(0);
  } else {
    console.log("\n  CANARY HAS FAILURES. Investigate before fleet rollout.");
    process.exit(7);
  }
}

main().catch((err) => {
  console.error("✗ canary threw:", err);
  process.exit(99);
});
