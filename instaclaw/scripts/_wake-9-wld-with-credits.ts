/**
 * P1 wake: 9 WLD users with credit_balance > 0 stuck hibernating.
 *
 * Per VM (sequential, halt on first failure):
 *   1. Re-fetch fresh row, confirm health_status='hibernating' AND credit_balance > 0
 *   2. SSH connectivity check
 *   3. startGateway(vm)
 *   4. Poll `is-active` up to 30s
 *   5. Curl localhost:18789/health → expect 200
 *   6. DB update: health_status='healthy', last_health_check=NOW()
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { startGateway, connectSSH, checkSSHConnectivity, type VMRecord } from "../lib/ssh";

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
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const TARGETS = [
  "instaclaw-vm-331",
  "instaclaw-vm-850",
  "instaclaw-vm-linode-10",
  "instaclaw-vm-769",
  "instaclaw-vm-779",
  "instaclaw-vm-765",
  "instaclaw-vm-763",
  "instaclaw-vm-740",
  "instaclaw-vm-742",
];

function log(prefix: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${prefix} ${msg}`);
}

async function pollIsActive(vm: VMRecord, maxSeconds = 30): Promise<boolean> {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < maxSeconds) {
    const ssh = await connectSSH(vm);
    try {
      const r = await ssh.execCommand("systemctl --user is-active openclaw-gateway");
      if (r.stdout.trim() === "active") return true;
    } finally { ssh.dispose(); }
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}

async function curlHealth(vm: VMRecord): Promise<{ ok: boolean; code: string; body: string }> {
  const ssh = await connectSSH(vm);
  try {
    const r = await ssh.execCommand("curl -s -o /tmp/h.txt -w '%{http_code}' http://localhost:18789/health; echo; cat /tmp/h.txt 2>/dev/null | head -c 200");
    const lines = r.stdout.split("\n");
    const code = lines[0]?.trim() ?? "?";
    const body = lines.slice(1).join("\n").slice(0, 200);
    return { ok: code === "200", code, body };
  } finally { ssh.dispose(); }
}

(async () => {
  let success = 0;
  let failed = 0;
  const failures: { vm: string; step: string; reason: string }[] = [];

  for (const target of TARGETS) {
    console.log(`\n══════════════════════════════════════════════════════════════════════`);
    console.log(`  ${target}`);
    console.log(`══════════════════════════════════════════════════════════════════════`);

    const { data: vmRow, error: fetchErr } = await sb
      .from("instaclaw_vms")
      .select("id,ip_address,ssh_port,ssh_user,assigned_to,region,name,health_status,suspended_at,credit_balance")
      .eq("name", target)
      .single();

    if (fetchErr || !vmRow) {
      log("❌", `step=fetch reason=${fetchErr?.message ?? "no row"}`);
      failed++; failures.push({ vm: target, step: "fetch", reason: fetchErr?.message ?? "no row" });
      console.log("\nHALT — refusing to continue after failure."); break;
    }

    if (vmRow.health_status !== "hibernating") {
      log("❌", `step=precheck reason=health_status='${vmRow.health_status}', expected 'hibernating'`);
      failed++; failures.push({ vm: target, step: "precheck", reason: `state changed to '${vmRow.health_status}'` });
      console.log("\nHALT — refusing to continue after failure."); break;
    }

    const credits = vmRow.credit_balance ?? 0;
    if (credits <= 0) {
      log("❌", `step=precheck reason=credit_balance=${credits} (expected >0). User has no credits — wake would just hibernate again on next cron.`);
      failed++; failures.push({ vm: target, step: "precheck", reason: `credits=${credits}` });
      console.log("\nHALT — refusing to continue after failure."); break;
    }
    log("ℹ", `credits=$${(credits / 100).toFixed(2)}  ssh=${vmRow.ssh_user}@${vmRow.ip_address}:${vmRow.ssh_port}`);

    const vm: VMRecord = {
      id: vmRow.id, ip_address: vmRow.ip_address, ssh_port: vmRow.ssh_port, ssh_user: vmRow.ssh_user,
      assigned_to: vmRow.assigned_to, region: vmRow.region ?? undefined,
    };

    log("→", "step=ssh-check");
    if (!(await checkSSHConnectivity(vm))) {
      log("❌", "step=ssh-check reason=SSH unreachable");
      failed++; failures.push({ vm: target, step: "ssh-check", reason: "unreachable" });
      console.log("\nHALT — refusing to continue after failure."); break;
    }
    log("✅", "step=ssh-check");

    log("→", "step=start-gateway");
    if (!(await startGateway(vm))) {
      log("❌", "step=start-gateway reason=startGateway returned false");
      failed++; failures.push({ vm: target, step: "start-gateway", reason: "returned false" });
      console.log("\nHALT — refusing to continue after failure."); break;
    }
    log("✅", "step=start-gateway");

    log("→", "step=poll-is-active (up to 30s)");
    if (!(await pollIsActive(vm, 30))) {
      log("❌", "step=poll-is-active reason=systemd unit never reached active");
      failed++; failures.push({ vm: target, step: "poll-is-active", reason: "never active" });
      console.log("\nHALT — refusing to continue after failure."); break;
    }
    log("✅", "step=poll-is-active");

    log("→", "step=curl-health");
    const health = await curlHealth(vm);
    if (!health.ok) {
      log("❌", `step=curl-health reason=http=${health.code} body=${health.body}`);
      failed++; failures.push({ vm: target, step: "curl-health", reason: `http=${health.code}` });
      console.log("\nHALT — refusing to continue after failure."); break;
    }
    log("✅", `step=curl-health http=${health.code}`);

    log("→", "step=db-update");
    const { error: updErr } = await sb
      .from("instaclaw_vms")
      .update({ health_status: "healthy", last_health_check: new Date().toISOString() })
      .eq("id", vm.id);
    if (updErr) {
      log("❌", `step=db-update reason=${updErr.message}`);
      failed++; failures.push({ vm: target, step: "db-update", reason: updErr.message });
      console.log("\nHALT — refusing to continue after failure."); break;
    }
    log("✅", "step=db-update");

    log("✅✅✅", `${target} WOKE SUCCESSFULLY (had $${(credits / 100).toFixed(2)} credits)`);
    success++;
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════`);
  console.log(`  RESULTS: ${success}/${TARGETS.length} woke successfully, ${failed} failed`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
  if (failures.length) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  ${f.vm}  step=${f.step}  reason=${f.reason}`);
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
