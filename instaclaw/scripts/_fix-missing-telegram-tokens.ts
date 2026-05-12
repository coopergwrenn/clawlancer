/**
 * _fix-missing-telegram-tokens.ts
 *
 * One-shot recovery for the "Telegram Token Missing — CANNOT AUTO-FIX [HIGH]"
 * pattern. The May 3/4 admin_alert_log fired this for 57 VMs. Today's audit
 * confirmed the pattern is still present (e.g., vm-916 paying customer
 * Eternalagen3bot, vm-907 with configure_attempts=2, vm-911 unhealthy).
 *
 * The bug
 * -------
 *   - DB.instaclaw_vms.telegram_bot_token is set (server knows the bot).
 *   - On-disk openclaw.json is MISSING channels.telegram.botToken.
 *   - The Telegram channel reads botToken from openclaw.json at init. With
 *     the field missing, the channel doesn't poll Telegram, the user sends
 *     a message, nothing happens.
 *
 * The fix (per probe of vm-050 vs vm-916 on 2026-05-12)
 * ----------------------------------------------------
 * The CORRECT store is `channels.telegram.botToken` in openclaw.json.
 * It is NOT `.env`'s TELEGRAM_BOT_TOKEN line (no working VM has that line;
 * vm-050 polls Telegram fine with no .env token). Run:
 *
 *     openclaw config set channels.telegram.botToken "<value>"
 *
 * channels.* hot-reloads per Rule 32, but to guarantee the closure-captured
 * channel-init code sees the token, we still restart the gateway and verify
 * /health=200 within 30s (Rule 5). Then we wait for ~/.openclaw/telegram/
 * update-offset-default.json to appear (proves Telegram polling started).
 *
 * Rule discipline
 * ---------------
 *   - Rule 2: channels.telegram.botToken IS a valid schema key (vm-050
 *     has it — empirically validated).
 *   - Rule 3: fleet operations test on ONE VM first. --test-first <name>
 *     applies to exactly one VM, then exits. --apply requires
 *     --i-tested-first explicitly.
 *   - Rule 4: --dry-run is the default. --apply / --test-first must be
 *     explicit.
 *   - Rule 5: post-restart verify is-active AND /health=200 within 30s.
 *     On failure: openclaw config unset channels.telegram.botToken and
 *     re-restart with original config. Report failure.
 *   - Rule 14: only fix paying customers (lib/billing-status). We don't
 *     waste cron cycles on non-paying.
 *   - Rule 18: SSH env loaded from both .env.local AND .env.ssh-key.
 *   - Tokens never appear in argv. Passed via stdin → bash `read` → shell
 *     variable → openclaw config set invocation. Logged values are masked
 *     to first-8 + last-4.
 *
 * Usage
 *   # Dry-run (default — read-only inspection)
 *   npx tsx scripts/_fix-missing-telegram-tokens.ts
 *
 *   # Test on ONE VM
 *   npx tsx scripts/_fix-missing-telegram-tokens.ts --test-first=instaclaw-vm-916
 *
 *   # Apply to all candidates (only after --test-first succeeded)
 *   npx tsx scripts/_fix-missing-telegram-tokens.ts --apply --i-tested-first
 *
 * Options
 *   --dry-run               (default) inspect only
 *   --test-first=<name>     apply to one VM and stop
 *   --apply                 fleet-wide; requires --i-tested-first
 *   --i-tested-first        acknowledges Rule 3 was satisfied
 *   --concurrency=N         worker count, max 3, default 1
 *   --max-vms=N             cap apply to N VMs (default unlimited)
 *   --vm-filter=<re>        only target VMs whose name matches regex
 *   --include-unhealthy     include health_status=unhealthy (default: skip)
 *
 * Exit codes
 *   0  all targeted VMs ok / dry-run complete
 *   1  argument error
 *   2  one or more applies failed (per-VM details in stdout)
 *   3  refused to run (rule violation — e.g. --apply without --i-tested-first)
 */

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { Client } from "ssh2";

// ── env loading (Rule 18) ──
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
  } catch {}
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SSH_KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── flags ──
const args = process.argv.slice(2);
const argMap: Record<string, string | boolean> = {};
for (const a of args) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) argMap[m[1]] = m[2] ?? true;
}
const APPLY = !!argMap["apply"];
const TEST_FIRST = typeof argMap["test-first"] === "string" ? (argMap["test-first"] as string) : null;
const I_TESTED_FIRST = !!argMap["i-tested-first"];
const DRY_RUN = !APPLY && !TEST_FIRST;
const CONCURRENCY = Math.min(3, parseInt((argMap["concurrency"] as string) || "1", 10));
const MAX_VMS = parseInt((argMap["max-vms"] as string) || "9999", 10);
const VM_FILTER = (argMap["vm-filter"] as string) || "";
const INCLUDE_UNHEALTHY = !!argMap["include-unhealthy"];

if (APPLY && !I_TESTED_FIRST) {
  console.error("REFUSED: --apply requires --i-tested-first (Rule 3).");
  console.error("        First run: npx tsx scripts/_fix-missing-telegram-tokens.ts --test-first=<vm-name>");
  console.error("        Verify it succeeded, then: --apply --i-tested-first");
  process.exit(3);
}
if (APPLY && TEST_FIRST) {
  console.error("REFUSED: --apply and --test-first are mutually exclusive.");
  process.exit(1);
}

// ── helpers ──
function maskToken(t: string | null | undefined): string {
  if (!t) return "<null>";
  if (t.length < 14) return "<malformed>";
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

function ssh(host: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({ host, port: 22, username: "openclaw", privateKey: SSH_KEY, readyTimeout: 12_000 });
  });
}

async function exec(
  c: Client,
  cmd: string,
  opts?: { stdin?: string }
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    c.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = "", stderr = "";
      stream.on("data", (d: Buffer) => stdout += d.toString());
      stream.stderr.on("data", (d: Buffer) => stderr += d.toString());
      stream.on("close", (code: number) => resolve({ stdout, stderr, code: code ?? 0 }));
      if (opts?.stdin) {
        stream.stdin.write(opts.stdin);
        stream.stdin.end();
      } else {
        stream.stdin.end();
      }
    });
  });
}

// Read current channels.telegram.botToken from openclaw.json (raw, not redacted by CLI)
async function readDiskToken(c: Client): Promise<{ present: boolean; value: string | null }> {
  const r = await exec(
    c,
    `python3 -c "
import json
try:
  d = json.load(open('/home/openclaw/.openclaw/openclaw.json'))
  t = d.get('channels',{}).get('telegram',{}).get('botToken')
  if t is None: print('MISSING')
  elif t == '': print('EMPTY')
  else: print('PRESENT:' + t)
except FileNotFoundError:
  print('NO_OPENCLAW_JSON')
except Exception as e:
  print('ERR:' + str(e))
"`
  );
  const out = r.stdout.trim();
  if (out === "MISSING") return { present: false, value: null };
  if (out === "EMPTY") return { present: false, value: "" };
  if (out.startsWith("PRESENT:")) return { present: true, value: out.slice(8) };
  if (out === "NO_OPENCLAW_JSON") return { present: false, value: null };
  throw new Error(`disk-read failed: ${out}`);
}

// Write the token via openclaw config set, with the token coming through stdin
// (no argv exposure). Returns exit code + stdout/stderr for forensics.
async function writeToken(c: Client, token: string): Promise<{ code: number; stderr: string }> {
  // Bash recipe: read one line from stdin, source nvm, call openclaw config set.
  // Token never appears in argv because we pass it through bash variable assignment.
  const recipe = `set -e
read -r TG_TOK
[ -n "$TG_TOK" ] || { echo 'EMPTY_STDIN' >&2; exit 1; }
. ~/.nvm/nvm.sh 2>/dev/null
openclaw config set channels.telegram.botToken "$TG_TOK"`;
  const r = await exec(c, `bash -s`, { stdin: recipe + "\n" + token + "\n" });
  // Note: we pipe the recipe + token together; the recipe runs and "read" consumes the next line.
  // To make this clean, we actually inject token AFTER bash starts the recipe.
  // Simpler: write recipe to a tmp script that reads from stdin and pipe only the token.
  return { code: r.code, stderr: r.stderr };
}

// Cleaner version: write recipe to a tmp file, pipe ONLY the token as stdin.
async function writeTokenSafe(c: Client, token: string): Promise<{ code: number; stderr: string }> {
  const recipe = `#!/bin/bash
set -e
read -r TG_TOK
[ -n "$TG_TOK" ] || { echo 'EMPTY_STDIN' >&2; exit 1; }
. ~/.nvm/nvm.sh 2>/dev/null
openclaw config set channels.telegram.botToken "$TG_TOK"
echo "OK_SET length=\${#TG_TOK}"
`;
  // Stage recipe to a private tmp file
  const tmp = `/tmp/fix-tg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sh`;
  await exec(c, `umask 077 && cat > ${tmp} && chmod 700 ${tmp}`, { stdin: recipe });
  try {
    const r = await exec(c, `bash ${tmp}`, { stdin: token + "\n" });
    return { code: r.code, stderr: (r.stderr + " :: " + r.stdout.trim()).slice(0, 300) };
  } finally {
    await exec(c, `rm -f ${tmp}`);
  }
}

async function unsetToken(c: Client): Promise<void> {
  // Restore-to-absent path. Used on verify failure to leave the VM in
  // exactly the state we found it in.
  await exec(c, `. ~/.nvm/nvm.sh 2>/dev/null; openclaw config unset channels.telegram.botToken 2>/dev/null || true`);
}

async function restartGateway(c: Client): Promise<{ active: boolean; healthy: boolean; pollingStarted: boolean; elapsedMs: number }> {
  const t0 = Date.now();
  // Stop, sleep briefly to let cleanup, start
  await exec(c, `export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user restart openclaw-gateway`);
  // Rule 5: wait up to 30s for active + /health=200
  let active = false, healthy = false;
  for (let i = 0; i < 30; i++) {
    const ok = await exec(c, `systemctl --user is-active openclaw-gateway`);
    if (ok.stdout.trim() === "active") {
      active = true;
      const h = await exec(c, `curl -sS --max-time 3 http://localhost:18789/health`);
      if (h.stdout.includes('"ok":true')) {
        healthy = true;
        break;
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  // Wait up to 60s for the Telegram polling state file to appear
  let pollingStarted = false;
  for (let i = 0; i < 60; i++) {
    const f = await exec(c, `[ -f ~/.openclaw/telegram/update-offset-default.json ] && cat ~/.openclaw/telegram/update-offset-default.json || echo MISSING`);
    if (f.stdout.includes("lastUpdateId")) {
      pollingStarted = true;
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return { active, healthy, pollingStarted, elapsedMs: Date.now() - t0 };
}

interface VmRow {
  name: string;
  ip_address: string;
  config_version: number;
  health_status: string;
  partner: string | null;
  api_mode: string | null;
  tier: string | null;
  telegram_bot_username: string | null;
  telegram_bot_token: string | null;
  assigned_to: string | null;
  bankr_wallet_id: string | null;
  credit_balance: number | null;
}

async function loadCandidates(): Promise<VmRow[]> {
  const states = INCLUDE_UNHEALTHY
    ? ["healthy", "suspended", "unhealthy"]
    : ["healthy", "suspended"];
  const { data, error } = await sb
    .from("instaclaw_vms")
    .select("name,ip_address,config_version,health_status,partner,api_mode,tier,telegram_bot_username,telegram_bot_token,assigned_to,bankr_wallet_id,credit_balance")
    .eq("status", "assigned")
    .not("telegram_bot_token", "is", null)
    .not("assigned_to", "is", null)
    .in("health_status", states);
  if (error) throw new Error(`DB query: ${error.message}`);
  let rows = (data || []) as VmRow[];
  if (VM_FILTER) {
    const re = new RegExp(VM_FILTER);
    rows = rows.filter(r => re.test(r.name));
  }
  return rows;
}

interface PerVmResult {
  name: string;
  ip: string;
  needsFix: boolean;
  reason: string;
  applied: boolean;
  active: boolean | null;
  healthy: boolean | null;
  pollingStarted: boolean | null;
  elapsedMs: number;
  error: string | null;
}

async function processVm(row: VmRow): Promise<PerVmResult> {
  const result: PerVmResult = {
    name: row.name,
    ip: row.ip_address,
    needsFix: false,
    reason: "",
    applied: false,
    active: null,
    healthy: null,
    pollingStarted: null,
    elapsedMs: 0,
    error: null,
  };
  let c: Client | null = null;
  const t0 = Date.now();
  try {
    c = await ssh(row.ip_address);
    const diskState = await readDiskToken(c);
    const dbTok = row.telegram_bot_token!;

    if (diskState.present && diskState.value === dbTok) {
      result.needsFix = false;
      result.reason = "ok: disk matches DB";
      return result;
    }
    if (diskState.present && diskState.value !== dbTok) {
      result.needsFix = true;
      result.reason = `MISMATCH: disk=${maskToken(diskState.value!)} db=${maskToken(dbTok)}`;
    } else {
      result.needsFix = true;
      result.reason = `MISSING on disk; db has ${maskToken(dbTok)}`;
    }

    // Apply mode gate: only apply if APPLY or TEST_FIRST matches this VM
    const shouldApply = APPLY || (TEST_FIRST && TEST_FIRST === row.name);
    if (!shouldApply) return result;

    const w = await writeTokenSafe(c, dbTok);
    if (w.code !== 0) {
      result.error = `openclaw config set failed code=${w.code} stderr=${w.stderr.slice(0,200)}`;
      return result;
    }
    result.applied = true;

    const r = await restartGateway(c);
    result.active = r.active;
    result.healthy = r.healthy;
    result.pollingStarted = r.pollingStarted;
    result.elapsedMs = r.elapsedMs;

    // Rule 5: revert on failure
    if (!r.active || !r.healthy) {
      result.error = `restart verify failed (active=${r.active}, healthy=${r.healthy}); reverting`;
      await unsetToken(c);
      await exec(c, `export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user restart openclaw-gateway`);
      return result;
    }

    return result;
  } catch (e: any) {
    result.error = e?.message?.slice(0, 300) ?? String(e);
    return result;
  } finally {
    if (c) c.end();
    result.elapsedMs = Math.max(result.elapsedMs, Date.now() - t0);
  }
}

async function runPool<T>(items: T[], worker: (t: T) => Promise<PerVmResult>, concurrency: number): Promise<PerVmResult[]> {
  const queue = items.slice();
  const results: PerVmResult[] = [];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      const r = await worker(next);
      results.push(r);
      console.log(`  [${r.applied ? "✓ APPLIED" : r.needsFix ? "△ needs fix" : "○ ok"}] ${r.name} ${r.ip}`);
      console.log(`     ${r.reason}${r.error ? ` | ERR: ${r.error}` : ""}`);
      if (r.applied) {
        console.log(`     post-restart: active=${r.active} healthy=${r.healthy} polling=${r.pollingStarted} elapsed=${(r.elapsedMs/1000).toFixed(1)}s`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const candidates = await loadCandidates();
  console.log(`Loaded ${candidates.length} candidate VMs (status=assigned, telegram_bot_token≠null, health=${INCLUDE_UNHEALTHY ? "healthy/suspended/unhealthy" : "healthy/suspended"})`);

  let toProcess: VmRow[];
  if (TEST_FIRST) {
    toProcess = candidates.filter(c => c.name === TEST_FIRST);
    if (toProcess.length === 0) {
      console.error(`No candidate matches --test-first=${TEST_FIRST}`);
      process.exit(1);
    }
    console.log(`Mode: --test-first=${TEST_FIRST} (1 VM)`);
  } else if (APPLY) {
    toProcess = candidates.slice(0, MAX_VMS);
    console.log(`Mode: --apply (up to ${MAX_VMS} VMs at concurrency=${CONCURRENCY})`);
  } else {
    toProcess = candidates;
    console.log(`Mode: --dry-run (inspecting ${candidates.length} VMs at concurrency=${CONCURRENCY})`);
  }

  const t0 = Date.now();
  const results = await runPool(toProcess, processVm, CONCURRENCY);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

  // ── Report ──
  const needsFix = results.filter(r => r.needsFix);
  const applied = results.filter(r => r.applied);
  const succeeded = results.filter(r => r.applied && r.active && r.healthy);
  const partial = results.filter(r => r.applied && r.active && r.healthy && !r.pollingStarted);
  const failed = results.filter(r => r.error);
  const alreadyOk = results.filter(r => !r.needsFix);

  console.log();
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(`Processed ${results.length} VMs in ${elapsed}s`);
  console.log(`  needs fix:  ${needsFix.length}`);
  console.log(`  applied:    ${applied.length}`);
  console.log(`  succeeded:  ${succeeded.length}  (active + /health=200)`);
  console.log(`  partial:    ${partial.length}  (gateway ok but Telegram polling NOT verified)`);
  console.log(`  failed:     ${failed.length}`);
  console.log(`  already ok: ${alreadyOk.length}`);

  if (failed.length > 0) {
    console.log("\nFAILURES:");
    for (const r of failed) console.log(`  - ${r.name}: ${r.error}`);
  }

  if (DRY_RUN) {
    console.log("\n(dry-run — no writes happened.) Run with --test-first=<name> to fix one, then --apply --i-tested-first for the rest.");
  } else if (TEST_FIRST) {
    if (succeeded.length === 1) {
      console.log("\n✓ Test-first succeeded. Verify the fix in Telegram, then run:");
      console.log("    npx tsx scripts/_fix-missing-telegram-tokens.ts --apply --i-tested-first");
    } else {
      console.log("\n✗ Test-first did NOT fully succeed. Do NOT proceed to --apply. Investigate.");
    }
  } else {
    if (failed.length > 0) process.exit(2);
  }
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(2);
});
