/**
 * Audit how many real user queries silently fell over from Sonnet to Haiku
 * because of the 90s timeoutSeconds.
 *
 * Selection: target VMs we KNOW have real conversation traffic (Cooper, Doug,
 * the 3 edge_city users known active) PLUS a sample of others ranked by
 * journal-line count.  DB's last_user_activity_at is unreliable — it can fire
 * on configure/heartbeat events; the only honest activity signal is real
 * sendMessage volume in journalctl.
 *
 * Patterns counted in 24h window:
 *   - "[telegram] sendMessage ok" — user-visible response sent
 *   - "candidate_failed ... claude-sonnet-4-6 reason=timeout" — sonnet hit 90s wall
 *   - "candidate_succeeded ... claude-haiku" — haiku rescued the call
 *   - "Embedded agent failed before reply: All models failed" — both failed
 *   - "[agent/embedded] empty response detected" — separate failure mode
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";

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
const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

interface VMSample {
  name: string;
  ip: string;
  reachable: boolean;
  reason?: string;
  journalLines: number;
  telegramSendMessageOks: number;
  candidateFailedSonnet: number;
  candidateSucceededHaiku: number;
  candidateFailedHaiku: number;
  allModelsFailed: number;
  emptyResponseDetected: number;
  sonnetCompletions: number;
  haikuTakeoverRate: number;
}

async function probeVM(name: string, ip: string, sshUser: string | null): Promise<VMSample> {
  const r: VMSample = {
    name, ip, reachable: false,
    journalLines: 0,
    telegramSendMessageOks: 0,
    candidateFailedSonnet: 0,
    candidateSucceededHaiku: 0,
    candidateFailedHaiku: 0,
    allModelsFailed: 0,
    emptyResponseDetected: 0,
    sonnetCompletions: 0,
    haikuTakeoverRate: 0,
  };
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: ip, username: sshUser || "openclaw", privateKey: sshKey, readyTimeout: 12_000 });
  } catch (e) {
    r.reason = (e as Error).message.slice(0, 80);
    return r;
  }
  r.reachable = true;
  try {
    const out = await ssh.execCommand(`
journalctl --user -u openclaw-gateway --since '24 hours ago' --no-pager 2>/dev/null > /tmp/oc-24h.log
LINES=$(wc -l < /tmp/oc-24h.log)
SENDOK=$(grep -c 'sendMessage ok' /tmp/oc-24h.log || echo 0)
CFSONNET=$(grep -E 'candidate_failed.*claude-sonnet-4-6.*reason=timeout' /tmp/oc-24h.log | wc -l)
CSHAIKU=$(grep -E 'candidate_succeeded.*claude-haiku' /tmp/oc-24h.log | wc -l)
CFHAIKU=$(grep -E 'candidate_failed.*claude-haiku' /tmp/oc-24h.log | wc -l)
ALLFAIL=$(grep -c 'Embedded agent failed before reply' /tmp/oc-24h.log || echo 0)
EMPTY=$(grep -c 'empty response detected' /tmp/oc-24h.log || echo 0)
echo "LINES=$LINES SENDOK=$SENDOK CFSONNET=$CFSONNET CSHAIKU=$CSHAIKU CFHAIKU=$CFHAIKU ALLFAIL=$ALLFAIL EMPTY=$EMPTY"
rm -f /tmp/oc-24h.log
`);
    const m = out.stdout.match(/LINES=(\d+) SENDOK=(\d+) CFSONNET=(\d+) CSHAIKU=(\d+) CFHAIKU=(\d+) ALLFAIL=(\d+) EMPTY=(\d+)/);
    if (m) {
      r.journalLines = parseInt(m[1], 10);
      r.telegramSendMessageOks = parseInt(m[2], 10);
      r.candidateFailedSonnet = parseInt(m[3], 10);
      r.candidateSucceededHaiku = parseInt(m[4], 10);
      r.candidateFailedHaiku = parseInt(m[5], 10);
      r.allModelsFailed = parseInt(m[6], 10);
      r.emptyResponseDetected = parseInt(m[7], 10);
      r.sonnetCompletions = Math.max(0, r.telegramSendMessageOks - r.candidateSucceededHaiku);
      const totalAttempts = r.candidateFailedSonnet + r.sonnetCompletions;
      r.haikuTakeoverRate = totalAttempts > 0 ? r.candidateFailedSonnet / totalAttempts : 0;
    }
  } catch (e) {
    r.reason = (e as Error).message.slice(0, 80);
  } finally {
    try { ssh.dispose(); } catch { /* ignore */ }
  }
  return r;
}

async function main(): Promise<void> {
  // Hand-picked KNOWN-active VMs (real conversation history)
  const knownActive = [
    { name: "instaclaw-vm-780", ip: "104.237.151.95", note: "Cooper @edgecitybot" },
    { name: "instaclaw-vm-725", ip: "45.33.74.65",   note: "Doug Rathell" },
    { name: "instaclaw-vm-354", ip: "172.104.24.165", note: "Timour @edgeclaw1bot" },
    { name: "instaclaw-vm-859", ip: "66.228.45.219",  note: "Katherine @erinthegreat_bot" },
  ];

  // Plus 6 RANDOM healthy VMs (probe broader fleet)
  const { data } = await sb.from("instaclaw_vms")
    .select("name, ip_address, ssh_user")
    .eq("status", "assigned").eq("provider", "linode").eq("health_status", "healthy")
    .is("frozen_at", null).is("lifecycle_locked_at", null)
    .not("ip_address", "is", null).not("gateway_token", "is", null)
    .limit(50);
  const allHealthy = (data || []).map((v) => ({
    name: v.name as string, ip: v.ip_address as string, ssh_user: (v.ssh_user as string) || null,
  }));
  const knownNames = new Set(knownActive.map((v) => v.name));
  const others = allHealthy.filter((v) => !knownNames.has(v.name));
  // Random 6
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  const sampleSet = [
    ...knownActive.map((v) => ({ ...v, ssh_user: null as string | null })),
    ...others.slice(0, 6),
  ];

  console.log(`Probing ${sampleSet.length} VMs (4 known-active + 6 random):`);
  for (const v of sampleSet) console.log(`  ${v.name.padEnd(20)} ${v.ip.padEnd(16)} ${(v as { note?: string }).note ?? ""}`);
  console.log("");

  const samples: VMSample[] = [];
  for (const v of sampleSet) {
    process.stdout.write(`  probing ${v.name}... `);
    const s = await probeVM(v.name, v.ip, v.ssh_user);
    samples.push(s);
    console.log(`journal=${s.journalLines}  send=${s.telegramSendMessageOks}  haiku-takeover=${s.candidateSucceededHaiku}`);
  }

  // Filter to only VMs with REAL traffic
  const active = samples.filter((s) => s.reachable && s.telegramSendMessageOks >= 5);
  const idle = samples.filter((s) => s.reachable && s.telegramSendMessageOks < 5);
  const unreachable = samples.filter((s) => !s.reachable);

  console.log(`\n══ Sample summary ══`);
  console.log(`  active (≥5 sendMessage in 24h): ${active.length}`);
  console.log(`  effectively idle (<5):          ${idle.length}`);
  console.log(`  unreachable:                    ${unreachable.length}`);

  if (active.length === 0) {
    console.log(`\nNO ACTIVE VMs in sample. The 24h-window pattern of model-fallover\n` +
      `cannot be measured directly from sample.  Probably need to widen the\n` +
      `sample or look at active conversations specifically.`);
    return;
  }

  console.log(`\n══ Per-active-VM 24h breakdown ══\n`);
  for (const s of active) {
    console.log(`  ${s.name}  (${s.ip})`);
    console.log(`    user-visible responses (sendMessage ok):   ${s.telegramSendMessageOks}`);
    console.log(`    Sonnet timeout → fallover events:          ${s.candidateFailedSonnet}`);
    console.log(`    Haiku rescued the response:                ${s.candidateSucceededHaiku}`);
    console.log(`    Haiku ALSO failed:                          ${s.candidateFailedHaiku}`);
    console.log(`    "Embedded agent failed":                    ${s.allModelsFailed}`);
    console.log(`    empty response detected:                    ${s.emptyResponseDetected}`);
    console.log(`    inferred Sonnet first-attempt successes:   ${s.sonnetCompletions}`);
    console.log(`    HAIKU TAKEOVER RATE:                       ${(s.haikuTakeoverRate * 100).toFixed(1)}%`);
    console.log("");
  }

  // Aggregate
  const totals = active.reduce((acc, s) => ({
    sendOks: acc.sendOks + s.telegramSendMessageOks,
    cfSonnet: acc.cfSonnet + s.candidateFailedSonnet,
    csHaiku: acc.csHaiku + s.candidateSucceededHaiku,
    cfHaiku: acc.cfHaiku + s.candidateFailedHaiku,
    allFail: acc.allFail + s.allModelsFailed,
    empty: acc.empty + s.emptyResponseDetected,
  }), { sendOks: 0, cfSonnet: 0, csHaiku: 0, cfHaiku: 0, allFail: 0, empty: 0 });

  const aggSonnetOk = Math.max(0, totals.sendOks - totals.csHaiku);
  const aggTotalAttempts = totals.cfSonnet + aggSonnetOk;
  const aggTakeoverRate = aggTotalAttempts > 0 ? totals.cfSonnet / aggTotalAttempts : 0;

  console.log(`══ AGGREGATE across ${active.length} active VMs (24h, before timeoutSeconds bump) ══`);
  console.log(`  user-visible responses:             ${totals.sendOks}`);
  console.log(`  Sonnet first-attempt successes:     ${aggSonnetOk}`);
  console.log(`  Haiku takeovers (Sonnet timed out): ${totals.csHaiku}`);
  console.log(`  Sonnet timeout events:              ${totals.cfSonnet}`);
  console.log(`  All-models-failed:                  ${totals.allFail}`);
  console.log(`  Empty-response events:              ${totals.empty}`);
  console.log(``);
  console.log(`  HAIKU TAKEOVER RATE: ${(aggTakeoverRate * 100).toFixed(1)}%`);
  console.log(``);
  console.log(`  Of ${totals.sendOks} responses users actually saw:`);
  if (totals.sendOks > 0) {
    console.log(`    ${aggSonnetOk}/${totals.sendOks} (${(100 * aggSonnetOk / totals.sendOks).toFixed(0)}%) — answered by Sonnet`);
    console.log(`    ${totals.csHaiku}/${totals.sendOks} (${(100 * totals.csHaiku / totals.sendOks).toFixed(0)}%) — answered by Haiku (Sonnet timed out)`);
  }
  if (totals.allFail > 0) {
    console.log(`    plus ${totals.allFail} all-models-failed events (user got "Something went wrong")`);
  }
}

main().catch((e) => { console.error(`FATAL: ${(e as Error).message}`); process.exit(1); });
