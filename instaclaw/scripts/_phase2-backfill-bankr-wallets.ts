/**
 * Phase 2 — fleet backfill of missing Bankr wallets.
 *
 * Iterates every VM with status='assigned' AND bankr_wallet_id IS NULL,
 * provisions an InstaClaw-managed Bankr wallet, then SSHes to write
 * BANKR_API_KEY + BANKR_WALLET_ADDRESS to ~/.openclaw/.env.
 *
 * Idempotent — safe to re-run forever. Bankr's idempotencyKey is
 * `instaclaw_user_${userId}` so retries return the existing wallet via 409
 * which is treated as success by provisionBankrWallet().
 *
 * Per CLAUDE.md fleet rules:
 *   --dry-run     : print plan without acting (Rule 4)
 *   --test-first  : run on the first VM only and pause (Rule 3)
 *   --limit=N     : cap to N VMs (smoke testing larger batches)
 *   default concurrency: 3 (Rule on max fleet concurrency)
 *
 * Per-VM result logged to scripts/output/_phase2-backfill-results.jsonl
 * for audit + retry.
 */

import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";
import { config } from "dotenv";
import { resolve } from "path";
import { writeFileSync, appendFileSync, mkdirSync } from "fs";
import { provisionBankrWallet } from "../lib/bankr-provision";
import { decryptBankrKey } from "../lib/bankr-encryption";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env.production.local"), override: false });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const privateKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const TEST_FIRST = args.has("--test-first");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : undefined;
const CONCURRENCY = 3;

interface VmRow {
  id: string;
  name: string;
  assigned_to: string;
  ip_address: string;
  ssh_port: number | null;
  ssh_user: string | null;
}

interface VmResult {
  vmId: string;
  name: string;
  status:
    | "provisioned"
    | "already-provisioned"
    | "provision-failed"
    | "ssh-failed"
    | "env-write-failed"
    | "skipped-no-ip"
    | "dry-run";
  walletId?: string;
  evmAddress?: string;
  error?: string;
  durationMs: number;
}

async function processVm(vm: VmRow): Promise<VmResult> {
  const start = Date.now();
  if (!vm.ip_address) {
    return { vmId: vm.id, name: vm.name, status: "skipped-no-ip", durationMs: Date.now() - start };
  }

  if (DRY_RUN) {
    return {
      vmId: vm.id,
      name: vm.name,
      status: "dry-run",
      durationMs: Date.now() - start,
    };
  }

  // Step 1: provision (idempotent — 409 from Bankr returns existing wallet)
  const result = await provisionBankrWallet({
    vmId: vm.id,
    userId: vm.assigned_to,
    vmIp: vm.ip_address,
    idempotencyKey: `instaclaw_user_${vm.assigned_to}`,
  });
  if (!result) {
    return {
      vmId: vm.id,
      name: vm.name,
      status: "provision-failed",
      error: "provisionBankrWallet returned null (Bankr API failure or missing partner key)",
      durationMs: Date.now() - start,
    };
  }

  // Step 2: re-read DB, decrypt the API key
  const { data: post } = await sb
    .from("instaclaw_vms")
    .select("bankr_api_key_encrypted")
    .eq("id", vm.id)
    .single();
  if (!post?.bankr_api_key_encrypted) {
    return {
      vmId: vm.id,
      name: vm.name,
      status: "provision-failed",
      walletId: result.walletId,
      evmAddress: result.evmAddress,
      error: "DB has no bankr_api_key_encrypted after provision",
      durationMs: Date.now() - start,
    };
  }
  let plainApiKey: string;
  try {
    plainApiKey = decryptBankrKey(post.bankr_api_key_encrypted);
  } catch (e: unknown) {
    return {
      vmId: vm.id,
      name: vm.name,
      status: "provision-failed",
      error: `decrypt failed: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: Date.now() - start,
    };
  }

  // Step 3: SSH to write env vars
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      username: vm.ssh_user ?? "openclaw",
      port: vm.ssh_port ?? 22,
      privateKey,
      readyTimeout: 8_000,
    });
  } catch (e: unknown) {
    return {
      vmId: vm.id,
      name: vm.name,
      status: "ssh-failed",
      walletId: result.walletId,
      evmAddress: result.evmAddress,
      error: `ssh connect: ${e instanceof Error ? e.message : String(e)}`,
      durationMs: Date.now() - start,
    };
  }

  try {
    const envWrite = await ssh.execCommand([
      'touch "$HOME/.openclaw/.env"',
      `K=${JSON.stringify(plainApiKey)}`,
      `A=${JSON.stringify(result.evmAddress)}`,
      'grep -q "^BANKR_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null && \\',
      '  sed -i "s|^BANKR_API_KEY=.*|BANKR_API_KEY=$K|" "$HOME/.openclaw/.env" || \\',
      '  echo "BANKR_API_KEY=$K" >> "$HOME/.openclaw/.env"',
      'grep -q "^BANKR_WALLET_ADDRESS=" "$HOME/.openclaw/.env" 2>/dev/null && \\',
      '  sed -i "s|^BANKR_WALLET_ADDRESS=.*|BANKR_WALLET_ADDRESS=$A|" "$HOME/.openclaw/.env" || \\',
      '  echo "BANKR_WALLET_ADDRESS=$A" >> "$HOME/.openclaw/.env"',
      'chmod 600 "$HOME/.openclaw/.env"',
      'grep -E "^BANKR_(API_KEY|WALLET_ADDRESS)=" "$HOME/.openclaw/.env" | wc -l',
    ].join('\n'));
    const okCount = parseInt((envWrite.stdout || "0").trim(), 10);
    if (okCount < 2) {
      return {
        vmId: vm.id,
        name: vm.name,
        status: "env-write-failed",
        walletId: result.walletId,
        evmAddress: result.evmAddress,
        error: `expected 2 BANKR lines after write, got ${okCount}. stderr=${envWrite.stderr.slice(0, 200)}`,
        durationMs: Date.now() - start,
      };
    }
  } finally {
    ssh.dispose();
  }

  // Note: we do NOT restart the gateway here. The agent picks up new env
  // values on next gateway restart, which happens via the watchdog or
  // natural session boundaries. Not worth a fleet-wide restart storm.

  return {
    vmId: vm.id,
    name: vm.name,
    status: "provisioned",
    walletId: result.walletId,
    evmAddress: result.evmAddress,
    durationMs: Date.now() - start,
  };
}

async function main() {
  console.log(`\n=== Phase 2 — Bankr wallet fleet backfill ===`);
  console.log(`Mode:        ${DRY_RUN ? "DRY-RUN" : "LIVE"}${TEST_FIRST ? " + TEST-FIRST" : ""}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  if (LIMIT) console.log(`Limit:       ${LIMIT}`);
  console.log("");

  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("id, name, assigned_to, ip_address, ssh_port, ssh_user")
    .eq("status", "assigned")
    .is("bankr_wallet_id", null)
    .order("assigned_at", { ascending: true });
  if (error) throw error;
  let candidates = (vms ?? []) as VmRow[];
  if (LIMIT) candidates = candidates.slice(0, LIMIT);
  if (TEST_FIRST) candidates = candidates.slice(0, 1);

  console.log(`Found ${candidates.length} VM(s) to process.\n`);

  if (DRY_RUN) {
    console.log("--- DRY-RUN PLAN (would do for each) ---");
    console.log("  1. provisionBankrWallet({vmId, userId, vmIp, idempotencyKey: 'instaclaw_user_${userId}'})");
    console.log("  2. read bankr_api_key_encrypted from DB, decrypt");
    console.log("  3. SSH → write BANKR_API_KEY + BANKR_WALLET_ADDRESS to ~/.openclaw/.env");
    console.log("  4. (no gateway restart)\n");
    console.log("VMs that would be processed:");
    for (const vm of candidates) console.log(`  ${vm.name.padEnd(20)}  ip=${vm.ip_address}  user=${vm.assigned_to}`);
    console.log(`\nTotal: ${candidates.length} VMs.`);
    console.log("\nRe-run without --dry-run to execute. Add --test-first to run on just the first VM.\n");
    return;
  }

  // Output dir + per-VM JSONL log
  mkdirSync(resolve(process.cwd(), "scripts/output"), { recursive: true });
  const logPath = resolve(process.cwd(), `scripts/output/_phase2-backfill-${Date.now()}.jsonl`);
  writeFileSync(logPath, "");
  console.log(`Per-VM results → ${logPath}\n`);

  // Process in batches of CONCURRENCY
  const results: VmResult[] = [];
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(batch.map(processVm));
    for (let j = 0; j < batchResults.length; j++) {
      const r = batchResults[j];
      const vm = batch[j];
      let result: VmResult;
      if (r.status === "fulfilled") {
        result = r.value;
      } else {
        result = {
          vmId: vm.id,
          name: vm.name,
          status: "provision-failed",
          error: `unhandled exception: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
          durationMs: 0,
        };
      }
      results.push(result);
      appendFileSync(logPath, JSON.stringify(result) + "\n");
      const tag =
        result.status === "provisioned" ? "✓" :
        result.status === "already-provisioned" ? "≈" :
        result.status === "dry-run" ? "·" :
        "✗";
      console.log(`  ${tag} ${result.name.padEnd(20)} ${result.status.padEnd(22)} ${result.evmAddress ?? ""} ${result.error ? `(${result.error.slice(0, 60)})` : ""}`);
    }
    process.stdout.write(`  → batch ${i / CONCURRENCY + 1}/${Math.ceil(candidates.length / CONCURRENCY)} done. running total: ${results.length}/${candidates.length}\n`);
  }

  // Summary
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\n=== Summary ===`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(25)}: ${v}`);
  }
  console.log(`  total                    : ${results.length}`);
  console.log(`\nLog: ${logPath}`);

  if (TEST_FIRST) {
    console.log(`\n✋ TEST-FIRST gate. Re-run without --test-first to process all candidates.`);
  }
}

main().catch((e) => {
  console.error("\n❌ Phase 2 fatal:", e);
  process.exit(1);
});
