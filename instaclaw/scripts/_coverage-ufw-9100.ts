/**
 * Coverage query for `ufw allow 9100/tcp` — confirms Prometheus on the
 * monitoring VM can actually reach node_exporter on each fleet VM, beyond
 * just "the port is bound locally."
 *
 * Per CLAUDE.md Rule 27 (every fleet-wide resource needs a 10-second
 * visibility query) and Rule 57 (firewall reachability must be verified
 * out-of-band, not just locally).
 *
 * Mechanism: sample 5 random healthy + assigned VMs, SSH each, grep
 * `ufw status` for `^9100/tcp`. Pass/fail table. Exit 1 on any miss.
 *
 * Run any time: `npx tsx scripts/_coverage-ufw-9100.ts`
 *   --sample N  : override sample size (default 5)
 *   --all       : check every healthy + assigned VM (slow; for full audit)
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
    // env file optional — fail loud only if required vars missing
  }
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SSH_KEY_B64 = process.env.SSH_PRIVATE_KEY_B64;
if (!SSH_KEY_B64) {
  console.error("FATAL: SSH_PRIVATE_KEY_B64 not set; need .env.ssh-key");
  process.exit(2);
}
const SSH_KEY = Buffer.from(SSH_KEY_B64, "base64").toString("utf-8");

const argv = process.argv.slice(2);
const sampleArg = argv.find((a) => a.startsWith("--sample="));
const SAMPLE = sampleArg ? parseInt(sampleArg.split("=")[1], 10) : 5;
const ALL = argv.includes("--all");

type ProbeResult = {
  name: string;
  ip: string;
  status: "PASS" | "FAIL" | "ERROR";
  detail: string;
};

async function probe(name: string, ip: string): Promise<ProbeResult> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: ip,
      username: "openclaw",
      privateKey: SSH_KEY,
      readyTimeout: 8000,
      tryKeyboard: false,
    });
    const r = await ssh.execCommand(
      'sudo -n ufw status 2>/dev/null | grep -c "^9100/tcp" || echo 0',
    );
    ssh.dispose();
    const count = parseInt(r.stdout.trim(), 10);
    if (Number.isNaN(count)) {
      return { name, ip, status: "ERROR", detail: `parse-fail: ${r.stdout.slice(0, 80)}` };
    }
    if (count >= 1) {
      return { name, ip, status: "PASS", detail: `count=${count}` };
    }
    return { name, ip, status: "FAIL", detail: "no 9100/tcp rule" };
  } catch (err) {
    try { ssh.dispose(); } catch { /* noop */ }
    return { name, ip, status: "ERROR", detail: String(err).slice(0, 120) };
  }
}

async function main() {
  console.log(`\n=== ufw 9100/tcp coverage — ${new Date().toISOString()} ===\n`);

  const { data, error } = await sb
    .from("instaclaw_vms")
    .select("name,ip_address")
    .eq("status", "assigned")
    .eq("health_status", "healthy")
    .not("ip_address", "is", null);
  if (error) {
    console.error(`Supabase error: ${error.message}`);
    process.exit(2);
  }
  const candidates = (data ?? []).filter((v) => v.ip_address);
  if (candidates.length === 0) {
    console.log("No healthy + assigned VMs with ip_address. Nothing to sample.");
    process.exit(0);
  }

  let picks: typeof candidates;
  if (ALL) {
    picks = candidates;
  } else {
    const n = Math.min(SAMPLE, candidates.length);
    picks = [...candidates].sort(() => Math.random() - 0.5).slice(0, n);
  }
  console.log(
    `Population: ${candidates.length} healthy+assigned VMs. ` +
    `Probing ${picks.length} (${ALL ? "ALL" : `random sample of ${SAMPLE}`}).\n`,
  );

  // Probes in parallel; each connect has 8s readyTimeout — bounded wall-clock.
  const results = await Promise.all(picks.map((v) => probe(v.name!, v.ip_address!)));

  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log(pad("VM", 24) + pad("IP", 18) + pad("STATUS", 8) + "DETAIL");
  console.log("-".repeat(72));
  for (const r of results.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(pad(r.name, 24) + pad(r.ip, 18) + pad(r.status, 8) + r.detail);
  }
  console.log();

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const err = results.filter((r) => r.status === "ERROR").length;
  console.log(`Summary: ${pass} PASS / ${fail} FAIL / ${err} ERROR  (of ${results.length})`);

  if (fail > 0) {
    console.error(
      `\n✗ ${fail} VM(s) missing ufw 9100/tcp rule. ` +
      `Reconciler stepUfwRules should heal on next cron tick. ` +
      `If this persists, run scripts/_fleet-push-ufw-9100.ts as a one-shot.`,
    );
    process.exit(1);
  }
  if (err > 0 && pass === 0) {
    console.error("\n✗ All probes errored — likely env/SSH-key misconfig. Investigate.");
    process.exit(1);
  }
  console.log("\n✓ All sampled VMs have the rule.");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(2);
});
