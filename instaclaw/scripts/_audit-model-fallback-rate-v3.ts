/**
 * v3 audit — widen to ALL healthy VMs and add candidate_succeeded sonnet
 * (the missing dimension in v2).
 *
 * Why v3:
 *   - v2 sampled 50, found only 2 active. Not enough confidence for a launch
 *     decision.
 *   - v2 inferred sonnetOk = sendOks - csHaiku, which is wrong: a user response
 *     could come from a NON-fallback path (no candidate event) or from a
 *     candidate_succeeded sonnet event after a transient candidate_failed.
 *     We need the explicit candidate_succeeded sonnet count.
 *   - lib/ssh.ts:881 — _call_haiku_for_summary cron calls hit
 *     https://instaclaw.io/api/gateway/proxy directly, NOT localhost:18789.
 *     So the cron-driven Haiku traffic does NOT appear in the VM's
 *     openclaw-gateway journal. Every candidate_failed/candidate_succeeded
 *     haiku event on the VM is user-impacting.
 *
 * Load-bearing signals:
 *   - sendMessage ok = user actually saw a response
 *   - Embedded agent failed before reply = user actually saw "Something went wrong"
 *   - candidate_failed sonnet reason=timeout = sonnet hit timeoutSeconds wall
 *   - candidate_succeeded haiku = haiku rescued user-visible response
 *   - candidate_succeeded sonnet = sonnet finished normally (the GOOD case)
 *   - candidate_failed haiku = haiku also failed (the WORST case — leads to allFail)
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

const CONCURRENCY = 12;
const ACTIVE_THRESHOLD = 3;       // ≥3 sendMessage in 24h (lower bar to capture more signal)
const PROBE_TIMEOUT_MS = 30_000;

interface VMSample {
  name: string;
  ip: string;
  reachable: boolean;
  reason?: string;
  journalLines: number;
  sendOks: number;
  allFail: number;
  cfSonnetTimeout: number;
  cfSonnetAny: number;
  csSonnet: number;
  csHaiku: number;
  cfHaiku: number;
  empty: number;
  // hourly buckets (0=oldest 24h ago, 23=newest)
  hourlyEnabled: boolean;
}

async function probeVM(name: string, ip: string, sshUser: string | null): Promise<VMSample> {
  const r: VMSample = {
    name, ip, reachable: false,
    journalLines: 0, sendOks: 0, allFail: 0,
    cfSonnetTimeout: 0, cfSonnetAny: 0, csSonnet: 0, csHaiku: 0, cfHaiku: 0,
    empty: 0, hourlyEnabled: false,
  };
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: ip, username: sshUser || "openclaw", privateKey: sshKey, readyTimeout: 8_000 });
  } catch (e) {
    r.reason = (e as Error).message.slice(0, 60);
    return r;
  }
  r.reachable = true;
  try {
    const out = await ssh.execCommand(`
journalctl --user -u openclaw-gateway --since '24 hours ago' --no-pager 2>/dev/null > /tmp/oc-24h.log
echo "L=$(wc -l < /tmp/oc-24h.log)"
echo "S=$(grep -c 'sendMessage ok' /tmp/oc-24h.log || echo 0)"
echo "AF=$(grep -c 'Embedded agent failed before reply' /tmp/oc-24h.log || echo 0)"
echo "CFST=$(grep -E 'candidate_failed.*claude-sonnet-4-6.*reason=timeout' /tmp/oc-24h.log | wc -l)"
echo "CFSA=$(grep -E 'candidate_failed.*claude-sonnet-4-6' /tmp/oc-24h.log | wc -l)"
echo "CSS=$(grep -E 'candidate_succeeded.*claude-sonnet-4-6' /tmp/oc-24h.log | wc -l)"
echo "CSH=$(grep -E 'candidate_succeeded.*claude-haiku' /tmp/oc-24h.log | wc -l)"
echo "CFH=$(grep -E 'candidate_failed.*claude-haiku' /tmp/oc-24h.log | wc -l)"
echo "E=$(grep -c 'empty response detected' /tmp/oc-24h.log || echo 0)"
rm -f /tmp/oc-24h.log
`);
    const text = out.stdout || "";
    const get = (k: string) => {
      const m = text.match(new RegExp(`${k}=(\\d+)`));
      return m ? parseInt(m[1], 10) : 0;
    };
    r.journalLines = get("L");
    r.sendOks = get("S");
    r.allFail = get("AF");
    r.cfSonnetTimeout = get("CFST");
    r.cfSonnetAny = get("CFSA");
    r.csSonnet = get("CSS");
    r.csHaiku = get("CSH");
    r.cfHaiku = get("CFH");
    r.empty = get("E");
  } catch (e) {
    r.reason = (e as Error).message.slice(0, 60);
  } finally {
    try { ssh.dispose(); } catch { /* ignore */ }
  }
  return r;
}

async function withDeadline<T>(fn: () => Promise<T>, ms: number): Promise<{ ok: true; v: T } | { ok: false; reason: string }> {
  let t: ReturnType<typeof setTimeout> | null = null;
  const dl = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("deadline")), ms); });
  try { return { ok: true, v: await Promise.race([fn(), dl]) }; }
  catch (e) { return { ok: false, reason: e instanceof Error ? e.message.slice(0, 100) : String(e) }; }
  finally { if (t) clearTimeout(t); }
}

async function main(): Promise<void> {
  const { data } = await sb.from("instaclaw_vms")
    .select("name, ip_address, ssh_user")
    .eq("status", "assigned").eq("provider", "linode").eq("health_status", "healthy")
    .is("frozen_at", null).is("lifecycle_locked_at", null)
    .not("ip_address", "is", null).not("gateway_token", "is", null);
  const targets = (data || []).map((v) => ({ name: v.name as string, ip: v.ip_address as string, ssh_user: (v.ssh_user as string) || null }));
  console.log(`Probing ${targets.length} healthy VMs at concurrency=${CONCURRENCY}, ${PROBE_TIMEOUT_MS / 1000}s deadline each...\n`);

  const results: VMSample[] = [];
  let cursor = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= targets.length) return;
      const v = targets[idx];
      const r = await withDeadline(() => probeVM(v.name, v.ip, v.ssh_user), PROBE_TIMEOUT_MS);
      const sample = r.ok ? r.v : { name: v.name, ip: v.ip, reachable: false, reason: r.reason, journalLines: 0, sendOks: 0, allFail: 0, cfSonnetTimeout: 0, cfSonnetAny: 0, csSonnet: 0, csHaiku: 0, cfHaiku: 0, empty: 0, hourlyEnabled: false };
      results.push(sample);
      done++;
      if (done % 20 === 0) process.stdout.write(`  ${done}/${targets.length} probed\n`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  results.sort((a, b) => b.sendOks - a.sendOks);
  const reachable = results.filter((s) => s.reachable);
  const active = reachable.filter((s) => s.sendOks >= ACTIVE_THRESHOLD);
  const idle = reachable.filter((s) => s.sendOks < ACTIVE_THRESHOLD);
  const unreachable = results.filter((s) => !s.reachable);

  console.log(`\n══ Sample summary ══`);
  console.log(`  total probed:                    ${results.length}`);
  console.log(`  reachable:                       ${reachable.length}`);
  console.log(`  active (≥${ACTIVE_THRESHOLD} sendMessage in 24h):  ${active.length}`);
  console.log(`  effectively idle:                ${idle.length}`);
  console.log(`  unreachable:                     ${unreachable.length}`);

  if (active.length === 0) { console.log(`\nNo active VMs.`); return; }

  console.log(`\n══ All active VMs by sendMessage volume (24h) ══`);
  console.log(`  ${"vm".padEnd(22)} ${"sendOk".padStart(7)} ${"allFail".padStart(7)} ${"cfSnT".padStart(6)} ${"csSn".padStart(5)} ${"csHk".padStart(5)} ${"cfHk".padStart(5)}  takeover  failrate`);
  for (const s of active) {
    const totalAttempts = s.csSonnet + s.csHaiku + s.cfSonnetTimeout;
    const takeoverRate = totalAttempts > 0 ? (100 * s.csHaiku / totalAttempts).toFixed(0) : "0";
    const totalQueries = s.sendOks + s.allFail;
    const failRate = totalQueries > 0 ? (100 * s.allFail / totalQueries).toFixed(0) : "0";
    console.log(`  ${s.name.padEnd(22)} ${s.sendOks.toString().padStart(7)} ${s.allFail.toString().padStart(7)} ${s.cfSonnetTimeout.toString().padStart(6)} ${s.csSonnet.toString().padStart(5)} ${s.csHaiku.toString().padStart(5)} ${s.cfHaiku.toString().padStart(5)}  ${takeoverRate.padStart(7)}%  ${failRate.padStart(7)}%`);
  }

  // Aggregate
  const totals = active.reduce((acc, s) => ({
    sendOks: acc.sendOks + s.sendOks,
    allFail: acc.allFail + s.allFail,
    cfSonnetTimeout: acc.cfSonnetTimeout + s.cfSonnetTimeout,
    cfSonnetAny: acc.cfSonnetAny + s.cfSonnetAny,
    csSonnet: acc.csSonnet + s.csSonnet,
    csHaiku: acc.csHaiku + s.csHaiku,
    cfHaiku: acc.cfHaiku + s.cfHaiku,
    empty: acc.empty + s.empty,
  }), { sendOks: 0, allFail: 0, cfSonnetTimeout: 0, cfSonnetAny: 0, csSonnet: 0, csHaiku: 0, cfHaiku: 0, empty: 0 });

  console.log(`\n══ AGGREGATE across ${active.length} active VMs (24h, before timeoutSeconds bump) ══\n`);

  const totalUserQueries = totals.sendOks + totals.allFail;
  console.log(`  ── User-facing outcomes ──`);
  console.log(`    Total user queries (rough):       ${totalUserQueries}`);
  console.log(`    User-visible responses:           ${totals.sendOks}`);
  console.log(`    User-visible failures:            ${totals.allFail}  ("Something went wrong")`);
  if (totalUserQueries > 0) {
    console.log(`    User-visible failure rate:        ${(100 * totals.allFail / totalUserQueries).toFixed(1)}%`);
  }

  console.log(`\n  ── Model attribution (gateway candidate events) ──`);
  console.log(`    candidate_succeeded sonnet:       ${totals.csSonnet}  (sonnet finished, response served)`);
  console.log(`    candidate_succeeded haiku:        ${totals.csHaiku}  (haiku rescued, response served)`);
  console.log(`    candidate_failed sonnet (timeout): ${totals.cfSonnetTimeout}  (sonnet hit 90s wall — fellover)`);
  console.log(`    candidate_failed sonnet (any):    ${totals.cfSonnetAny}  (timeout + other reasons)`);
  console.log(`    candidate_failed haiku:           ${totals.cfHaiku}  (haiku ALSO failed → allFail)`);

  // Of total candidate events that produced a user-visible answer, what fraction came from haiku?
  const totalServed = totals.csSonnet + totals.csHaiku;
  if (totalServed > 0) {
    console.log(`\n  ── HEADLINE: model attribution among ${totalServed} candidate-served responses ──`);
    console.log(`    Sonnet served:                    ${totals.csSonnet}/${totalServed} = ${(100 * totals.csSonnet / totalServed).toFixed(1)}%`);
    console.log(`    Haiku rescue served:              ${totals.csHaiku}/${totalServed} = ${(100 * totals.csHaiku / totalServed).toFixed(1)}%`);
  }

  // Note: sendOks > csSonnet + csHaiku is possible if non-candidate paths exist (older OpenClaw)
  // or if some sendMessages aren't model-driven (system messages, ack messages, etc.).
  if (totals.sendOks > totalServed) {
    const nonCandidate = totals.sendOks - totalServed;
    console.log(`\n  ── Note ──`);
    console.log(`    sendOks (${totals.sendOks}) > candidate-served (${totalServed}) by ${nonCandidate}`);
    console.log(`    The gap is system messages (paywall, reminders, paired messages, etc) and any`);
    console.log(`    chat completion that finished without firing a candidate event.`);
  }

  // Sonnet timeout rate (what % of attempts timed out)
  const totalSonnetAttempts = totals.csSonnet + totals.cfSonnetAny;
  if (totalSonnetAttempts > 0) {
    console.log(`\n  ── Sonnet 90s timeout rate ──`);
    console.log(`    Sonnet attempts:                  ${totalSonnetAttempts}`);
    console.log(`    Of those, hit 90s timeout:        ${totals.cfSonnetTimeout} = ${(100 * totals.cfSonnetTimeout / totalSonnetAttempts).toFixed(1)}%`);
  }

  console.log(`\n  ── Cascade signals ──`);
  console.log(`    Empty-response retries fired:     ${totals.empty}`);
  console.log(``);
  console.log(`══ END ══`);
}

main().catch((e) => { console.error(`FATAL: ${(e as Error).message}`); process.exit(1); });
