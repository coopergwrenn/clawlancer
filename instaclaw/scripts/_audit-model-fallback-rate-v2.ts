/**
 * Wider audit (v2): probe up to 50 VMs concurrent, filter to ≥5 sendMessage,
 * compute aggregate stats + surface the all-models-failed and empty-response
 * cascades that are the bigger silent quality issue than haiku takeover alone.
 *
 * Critical caveat: cfHaiku (haiku candidate_failed) can be inflated by
 * cron-driven calls (PERIODIC_SUMMARY_V1, _call_haiku_for_summary) that
 * fail without user impact.  We cannot perfectly disentangle from the
 * journal; we report it as a NOISY signal, not a load-bearing one.
 *
 * Load-bearing signals:
 *   - sendMessage ok = user actually saw a response (no ambiguity)
 *   - All models failed = user actually saw "Something went wrong" (no ambiguity)
 *   - candidate_failed sonnet reason=timeout = sonnet hit timeoutSeconds wall
 *     (load-bearing for "how often did 90s bite us")
 *   - candidate_succeeded haiku = haiku rescued the response and user saw it
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

const CONCURRENCY = 8;
const SAMPLE_SIZE = 50;
const ACTIVE_THRESHOLD = 5;     // ≥5 sendMessage in 24h
const PROBE_TIMEOUT_MS = 25_000;

interface VMSample {
  name: string;
  ip: string;
  reachable: boolean;
  reason?: string;
  journalLines: number;
  sendOks: number;
  cfSonnet: number;     // load-bearing: sonnet timeout
  csHaiku: number;       // load-bearing: haiku rescued user-visible response
  cfHaiku: number;       // noisy: haiku failures (includes cron summarization)
  allFail: number;       // load-bearing: user got "Something went wrong"
  empty: number;         // empty response detected
}

async function probeVM(name: string, ip: string, sshUser: string | null): Promise<VMSample> {
  const r: VMSample = {
    name, ip, reachable: false,
    journalLines: 0, sendOks: 0, cfSonnet: 0, csHaiku: 0, cfHaiku: 0, allFail: 0, empty: 0,
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
echo "L=$(wc -l < /tmp/oc-24h.log) S=$(grep -c 'sendMessage ok' /tmp/oc-24h.log || echo 0) CFS=$(grep -E 'candidate_failed.*claude-sonnet-4-6.*reason=timeout' /tmp/oc-24h.log | wc -l) CSH=$(grep -E 'candidate_succeeded.*claude-haiku' /tmp/oc-24h.log | wc -l) CFH=$(grep -E 'candidate_failed.*claude-haiku' /tmp/oc-24h.log | wc -l) AF=$(grep -c 'Embedded agent failed before reply' /tmp/oc-24h.log || echo 0) E=$(grep -c 'empty response detected' /tmp/oc-24h.log || echo 0)"
rm -f /tmp/oc-24h.log
`);
    const m = out.stdout.match(/L=(\d+) S=(\d+) CFS=(\d+) CSH=(\d+) CFH=(\d+) AF=(\d+) E=(\d+)/);
    if (m) {
      r.journalLines = parseInt(m[1], 10);
      r.sendOks = parseInt(m[2], 10);
      r.cfSonnet = parseInt(m[3], 10);
      r.csHaiku = parseInt(m[4], 10);
      r.cfHaiku = parseInt(m[5], 10);
      r.allFail = parseInt(m[6], 10);
      r.empty = parseInt(m[7], 10);
    }
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
  // Hand-pick known-active + random sample
  const known = ["instaclaw-vm-780", "instaclaw-vm-725", "instaclaw-vm-354", "instaclaw-vm-859", "instaclaw-vm-771", "instaclaw-vm-050"];

  const { data } = await sb.from("instaclaw_vms")
    .select("name, ip_address, ssh_user")
    .eq("status", "assigned").eq("provider", "linode").eq("health_status", "healthy")
    .is("frozen_at", null).is("lifecycle_locked_at", null)
    .not("ip_address", "is", null).not("gateway_token", "is", null);
  const all = (data || []).map((v) => ({ name: v.name as string, ip: v.ip_address as string, ssh_user: (v.ssh_user as string) || null }));

  const knownVMs = all.filter((v) => known.includes(v.name));
  const others = all.filter((v) => !known.includes(v.name));
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  const targets = [...knownVMs, ...others.slice(0, SAMPLE_SIZE - knownVMs.length)];
  console.log(`Probing ${targets.length} VMs (${knownVMs.length} known-active + ${targets.length - knownVMs.length} random) at concurrency=${CONCURRENCY}...\n`);

  // Concurrent probe
  const results: VMSample[] = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= targets.length) return;
      const v = targets[idx];
      const r = await withDeadline(() => probeVM(v.name, v.ip, v.ssh_user), PROBE_TIMEOUT_MS);
      const sample = r.ok ? r.v : { name: v.name, ip: v.ip, reachable: false, reason: r.reason, journalLines: 0, sendOks: 0, cfSonnet: 0, csHaiku: 0, cfHaiku: 0, allFail: 0, empty: 0 };
      results.push(sample);
      if (sample.reachable) {
        process.stdout.write(`  ${sample.name.padEnd(20)} send=${sample.sendOks.toString().padStart(3)} cfSonnet=${sample.cfSonnet.toString().padStart(2)} csHaiku=${sample.csHaiku.toString().padStart(2)} allFail=${sample.allFail.toString().padStart(2)} empty=${sample.empty.toString().padStart(2)}\n`);
      } else {
        process.stdout.write(`  ${sample.name.padEnd(20)} UNREACHABLE: ${sample.reason}\n`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Sort & analyze
  results.sort((a, b) => b.sendOks - a.sendOks);
  const reachable = results.filter((s) => s.reachable);
  const active = reachable.filter((s) => s.sendOks >= ACTIVE_THRESHOLD);
  const idle = reachable.filter((s) => s.sendOks < ACTIVE_THRESHOLD);
  const unreachable = results.filter((s) => !s.reachable);

  console.log(`\n══ Sample summary ══`);
  console.log(`  total probed:                 ${results.length}`);
  console.log(`  reachable:                    ${reachable.length}`);
  console.log(`  active (≥${ACTIVE_THRESHOLD} sendMessage in 24h): ${active.length}`);
  console.log(`  effectively idle:             ${idle.length}`);
  console.log(`  unreachable:                  ${unreachable.length}`);

  if (active.length === 0) { console.log(`\nNo active VMs in sample.`); return; }

  console.log(`\n══ Top active VMs by sendMessage volume ══`);
  for (const s of active.slice(0, 15)) {
    const sonnetOk = Math.max(0, s.sendOks - s.csHaiku);
    const totalAttempts = s.cfSonnet + sonnetOk;
    const takeoverRate = totalAttempts > 0 ? (100 * s.cfSonnet / totalAttempts).toFixed(0) : "0";
    const totalQueries = s.sendOks + s.allFail;
    const failRate = totalQueries > 0 ? (100 * s.allFail / totalQueries).toFixed(0) : "0";
    console.log(`  ${s.name.padEnd(22)} send=${s.sendOks.toString().padStart(3)}  sonnetOk=${sonnetOk.toString().padStart(3)}  haikuRescue=${s.csHaiku.toString().padStart(2)}  sonnetTimeout=${s.cfSonnet.toString().padStart(2)}  allFail=${s.allFail.toString().padStart(2)}  takeover=${takeoverRate}%  failRate=${failRate}%`);
  }

  // Aggregate
  const totals = active.reduce((acc, s) => ({
    sendOks: acc.sendOks + s.sendOks,
    cfSonnet: acc.cfSonnet + s.cfSonnet,
    csHaiku: acc.csHaiku + s.csHaiku,
    cfHaiku: acc.cfHaiku + s.cfHaiku,
    allFail: acc.allFail + s.allFail,
    empty: acc.empty + s.empty,
  }), { sendOks: 0, cfSonnet: 0, csHaiku: 0, cfHaiku: 0, allFail: 0, empty: 0 });

  const aggSonnetOk = Math.max(0, totals.sendOks - totals.csHaiku);
  const aggTotalAttempts = totals.cfSonnet + aggSonnetOk;
  const aggTakeoverRate = aggTotalAttempts > 0 ? totals.cfSonnet / aggTotalAttempts : 0;
  const aggTotalQueries = totals.sendOks + totals.allFail;
  const aggFailRate = aggTotalQueries > 0 ? totals.allFail / aggTotalQueries : 0;

  console.log(`\n══ AGGREGATE across ${active.length} active VMs (24h, before timeoutSeconds bump) ══\n`);
  console.log(`  Total user-visible responses:        ${totals.sendOks}`);
  console.log(`  Total user-visible failures:         ${totals.allFail}  ("Something went wrong")`);
  console.log(`  Total user queries (rough):          ${aggTotalQueries}`);
  console.log(``);
  console.log(`  ── Model attribution among the ${totals.sendOks} successful responses ──`);
  console.log(`    Sonnet first-attempt success:      ${aggSonnetOk} (${(100 * aggSonnetOk / Math.max(1, totals.sendOks)).toFixed(0)}%)`);
  console.log(`    Haiku rescued (Sonnet timeout):    ${totals.csHaiku} (${(100 * totals.csHaiku / Math.max(1, totals.sendOks)).toFixed(0)}%)`);
  console.log(``);
  console.log(`  ── Reliability ──`);
  console.log(`    Sonnet 90s timeout events:         ${totals.cfSonnet}`);
  console.log(`    Sonnet timeout rate (of attempts): ${(100 * aggTakeoverRate).toFixed(1)}%`);
  console.log(`    User-visible failure rate:         ${(100 * aggFailRate).toFixed(1)}%  ("Something went wrong")`);
  console.log(``);
  console.log(`  ── Cascade signals (noisy but indicative) ──`);
  console.log(`    Empty-response retries fired:      ${totals.empty}`);
  console.log(`    Haiku candidate_failed (any):      ${totals.cfHaiku}  (includes cron-driven summarizer; not all user-impacting)`);
}

main().catch((e) => { console.error(`FATAL: ${(e as Error).message}`); process.exit(1); });
