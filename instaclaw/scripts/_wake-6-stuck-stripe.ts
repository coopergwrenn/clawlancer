/**
 * Wake the 6 paying Stripe subscribers wrongly hibernating.
 * Pre-flight verified by _stripe-truth-6-subs.ts (all 6 active in Stripe,
 * latest invoice paid).
 *
 * Per VM:
 *   1. Fetch VMRecord from DB (re-confirm health_status=='hibernating')
 *   2. SSH connectivity check
 *   3. startGateway(vm) — runs `systemctl --user start openclaw-gateway` via SSH
 *   4. Poll `is-active` for up to 30s
 *   5. Curl localhost:18789/health from inside the VM → expect 200
 *   6. DB update: health_status='healthy', last_health_check=NOW()
 *      (keeps suspended_at for audit trail)
 *
 * Sequential. Halts on first failure — DOES NOT continue to next VM.
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
  "instaclaw-vm-544",
  "instaclaw-vm-576",
  "instaclaw-vm-698",
  "instaclaw-vm-655",
  "instaclaw-vm-046",
  "instaclaw-vm-442",
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
    } finally {
      ssh.dispose();
    }
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
  } finally {
    ssh.dispose();
  }
}

(async () => {
  let success = 0;
  let failed = 0;
  const failures: { vm: string; step: string; reason: string }[] = [];

  for (const target of TARGETS) {
    console.log(`\n══════════════════════════════════════════════════════════════════════`);
    console.log(`  ${target}`);
    console.log(`══════════════════════════════════════════════════════════════════════`);

    // 1. Fetch + re-confirm hibernating
    const { data: vmRow, error: fetchErr } = await sb
      .from("instaclaw_vms")
      .select("id,ip_address,ssh_port,ssh_user,assigned_to,region,name,health_status,suspended_at")
      .eq("name", target)
      .single();

    if (fetchErr || !vmRow) {
      log("❌", `step=fetch reason=DB lookup failed: ${fetchErr?.message ?? "no row"}`);
      failed++;
      failures.push({ vm: target, step: "fetch", reason: fetchErr?.message ?? "no row" });
      console.log("\nHALT — refusing to continue after failure.");
      break;
    }

    if (vmRow.health_status !== "hibernating") {
      log("❌", `step=precheck reason=health_status='${vmRow.health_status}', expected 'hibernating' (state changed since verify)`);
      failed++;
      failures.push({ vm: target, step: "precheck", reason: `state changed to '${vmRow.health_status}'` });
      console.log("\nHALT — refusing to continue after failure.");
      break;
    }

    const vm: VMRecord = {
      id: vmRow.id,
      ip_address: vmRow.ip_address,
      ssh_port: vmRow.ssh_port,
      ssh_user: vmRow.ssh_user,
      assigned_to: vmRow.assigned_to,
      region: vmRow.region ?? undefined,
    };
    log("ℹ", `id=${vm.id}  ssh=${vm.ssh_user}@${vm.ip_address}:${vm.ssh_port}`);

    // 2. SSH connectivity
    log("→", "step=ssh-check");
    const reachable = await checkSSHConnectivity(vm);
    if (!reachable) {
      log("❌", "step=ssh-check reason=SSH unreachable");
      failed++;
      failures.push({ vm: target, step: "ssh-check", reason: "unreachable" });
      console.log("\nHALT — refusing to continue after failure.");
      break;
    }
    log("✅", "step=ssh-check");

    // 3. startGateway
    log("→", "step=start-gateway");
    const started = await startGateway(vm);
    if (!started) {
      log("❌", "step=start-gateway reason=startGateway returned false");
      failed++;
      failures.push({ vm: target, step: "start-gateway", reason: "startGateway returned false" });
      console.log("\nHALT — refusing to continue after failure.");
      break;
    }
    log("✅", "step=start-gateway");

    // 4. Poll is-active
    log("→", "step=poll-is-active (up to 30s)");
    const active = await pollIsActive(vm, 30);
    if (!active) {
      log("❌", "step=poll-is-active reason=systemd unit never reached active");
      failed++;
      failures.push({ vm: target, step: "poll-is-active", reason: "never active" });
      console.log("\nHALT — refusing to continue after failure.");
      break;
    }
    log("✅", "step=poll-is-active");

    // 5. Curl health
    log("→", "step=curl-health");
    const health = await curlHealth(vm);
    if (!health.ok) {
      log("❌", `step=curl-health reason=http=${health.code} body=${health.body}`);
      failed++;
      failures.push({ vm: target, step: "curl-health", reason: `http=${health.code}` });
      console.log("\nHALT — refusing to continue after failure.");
      break;
    }
    log("✅", `step=curl-health http=${health.code}`);

    // 6. DB update
    log("→", "step=db-update");
    const { error: updErr } = await sb
      .from("instaclaw_vms")
      .update({
        health_status: "healthy",
        last_health_check: new Date().toISOString(),
      })
      .eq("id", vm.id);
    if (updErr) {
      log("❌", `step=db-update reason=${updErr.message}`);
      failed++;
      failures.push({ vm: target, step: "db-update", reason: updErr.message });
      console.log("\nHALT — refusing to continue after failure.");
      break;
    }
    log("✅", "step=db-update");

    log("✅✅✅", `${target} WOKE SUCCESSFULLY`);
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
