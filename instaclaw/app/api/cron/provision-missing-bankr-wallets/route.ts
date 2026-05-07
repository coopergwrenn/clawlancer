import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { provisionBankrWallet } from "@/lib/bankr-provision";
import { decryptBankrKey } from "@/lib/bankr-encryption";
import { connectSSH } from "@/lib/ssh";

/**
 * Continuous safety net for Bankr wallet coverage.
 *
 * Every 30 min, scan VMs that have status='assigned' but no
 * bankr_wallet_id (or have wallet_id but no encrypted_key) and re-run
 * provisionBankrWallet for them. Idempotent — Bankr returns the existing
 * wallet via 409 for repeat idempotency keys, or mints a fresh one if the
 * key has never been used.
 *
 * Three failure modes this catches:
 *   1. Stripe webhook fired but provisionBankrWallet returned null at the
 *      time (e.g., partner key missing, transient Bankr 5xx). DB stayed
 *      null. This run: re-tries; if partner key is now live, succeeds.
 *   2. Mini-app signup that reached `/api/vm/assign` before Phase 3
 *      shipped (our route-level fix). DB stayed null. Same as #1.
 *   3. Idempotency-409-no-apiKey case (vm-855, etc.): Bankr says wallet
 *      exists but won't re-issue the key. We use a versioned idempotency
 *      key (`instaclaw_user_${userId}_v2026-05-07`) ONLY when we detect
 *      this state — that mints a fresh wallet, orphaning the old empty
 *      one. Documented as the trade-off in
 *      docs/bankr-wallet-coverage-gap-2026-05-07.md.
 *
 * After provisioning, SSHes to write BANKR_API_KEY + BANKR_WALLET_ADDRESS
 * to ~/.openclaw/.env. Doesn't restart the gateway — agent picks up env
 * on next session boundary or watchdog cycle.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_NAME = "provision-missing-bankr-wallets";
const LOCK_TTL_SECONDS = 360;
const CONCURRENCY = 3;
const PER_RUN_LIMIT = 50;
// Versioned key suffix used when an existing 409 returned no apiKey.
// If we ever need to force a second wallet recovery (very rare), bump this.
const ORPHAN_RECOVERY_SUFFIX = "v2026-05-07";

interface CandidateVm {
  id: string;
  assigned_to: string;
  ip_address: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  bankr_wallet_id: string | null;
  bankr_api_key_encrypted: string | null;
}

type ProcessResult =
  | { vmId: string; status: "provisioned" }
  | { vmId: string; status: "orphan-recovered" }
  | { vmId: string; status: "env-only-fixup" }
  | { vmId: string; status: "skipped-no-ip" }
  | { vmId: string; status: "provision-null" }
  | { vmId: string; status: "ssh-failed"; error: string }
  | { vmId: string; status: "env-write-failed"; error: string }
  | { vmId: string; status: "still-no-apikey-after-recovery" };

async function writeEnv(vm: CandidateVm, plainApiKey: string, evmAddress: string): Promise<{ ok: boolean; error?: string }> {
  if (!vm.ip_address) return { ok: false, error: "no ip" };
  let ssh;
  try {
    ssh = await connectSSH({
      id: vm.id,
      ip_address: vm.ip_address,
      ssh_port: vm.ssh_port ?? 22,
      ssh_user: vm.ssh_user ?? "openclaw",
    });
  } catch (e: unknown) {
    return { ok: false, error: `ssh: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const r = await ssh.execCommand([
      'touch "$HOME/.openclaw/.env"',
      `K=${JSON.stringify(plainApiKey)}`,
      `A=${JSON.stringify(evmAddress)}`,
      'grep -q "^BANKR_API_KEY=" "$HOME/.openclaw/.env" && sed -i "s|^BANKR_API_KEY=.*|BANKR_API_KEY=$K|" "$HOME/.openclaw/.env" || echo "BANKR_API_KEY=$K" >> "$HOME/.openclaw/.env"',
      'grep -q "^BANKR_WALLET_ADDRESS=" "$HOME/.openclaw/.env" && sed -i "s|^BANKR_WALLET_ADDRESS=.*|BANKR_WALLET_ADDRESS=$A|" "$HOME/.openclaw/.env" || echo "BANKR_WALLET_ADDRESS=$A" >> "$HOME/.openclaw/.env"',
      'chmod 600 "$HOME/.openclaw/.env"',
      'grep -E "^BANKR_(API_KEY|WALLET_ADDRESS)=" "$HOME/.openclaw/.env" | wc -l',
    ].join('\n'));
    const count = parseInt((r.stdout || "0").trim(), 10);
    if (count < 2) return { ok: false, error: `expected 2 BANKR lines, got ${count}` };
    return { ok: true };
  } finally {
    ssh.dispose();
  }
}

async function processVm(vm: CandidateVm): Promise<ProcessResult> {
  if (!vm.ip_address) return { vmId: vm.id, status: "skipped-no-ip" };
  const supabase = getSupabase();

  // CASE 1: wallet_id present + encrypted_key present → just need .env fixup.
  // (E.g., the SSH-failed case from Phase 2 backfill.)
  if (vm.bankr_wallet_id && vm.bankr_api_key_encrypted) {
    const plain = decryptBankrKey(vm.bankr_api_key_encrypted);
    const { data: row } = await supabase
      .from("instaclaw_vms")
      .select("bankr_evm_address")
      .eq("id", vm.id)
      .single();
    const result = await writeEnv(vm, plain, row?.bankr_evm_address ?? "");
    return result.ok
      ? { vmId: vm.id, status: "env-only-fixup" }
      : { vmId: vm.id, status: "ssh-failed", error: result.error ?? "unknown" };
  }

  // CASE 2: wallet_id present + encrypted_key NULL → orphan-409.
  // Use a versioned idempotency key to mint a fresh wallet.
  if (vm.bankr_wallet_id && !vm.bankr_api_key_encrypted) {
    const result = await provisionBankrWallet({
      vmId: vm.id,
      userId: vm.assigned_to,
      vmIp: vm.ip_address,
      idempotencyKey: `instaclaw_user_${vm.assigned_to}_${ORPHAN_RECOVERY_SUFFIX}`,
    });
    if (!result) return { vmId: vm.id, status: "provision-null" };

    // Re-read DB. Decrypt. Write env.
    const { data: post } = await supabase
      .from("instaclaw_vms")
      .select("bankr_api_key_encrypted, bankr_evm_address")
      .eq("id", vm.id)
      .single();
    if (!post?.bankr_api_key_encrypted) {
      return { vmId: vm.id, status: "still-no-apikey-after-recovery" };
    }
    const plain = decryptBankrKey(post.bankr_api_key_encrypted);
    const w = await writeEnv(vm, plain, post.bankr_evm_address ?? result.evmAddress);
    return w.ok
      ? { vmId: vm.id, status: "orphan-recovered" }
      : { vmId: vm.id, status: "env-write-failed", error: w.error ?? "unknown" };
  }

  // CASE 3: wallet_id NULL → standard provision.
  const result = await provisionBankrWallet({
    vmId: vm.id,
    userId: vm.assigned_to,
    vmIp: vm.ip_address,
    idempotencyKey: `instaclaw_user_${vm.assigned_to}`,
  });
  if (!result) return { vmId: vm.id, status: "provision-null" };

  const { data: post } = await supabase
    .from("instaclaw_vms")
    .select("bankr_api_key_encrypted, bankr_evm_address")
    .eq("id", vm.id)
    .single();
  // If standard provision returned 409-no-apikey, leave it for the next
  // run when CASE 2 logic kicks in.
  if (!post?.bankr_api_key_encrypted) {
    return { vmId: vm.id, status: "provision-null" };
  }
  const plain = decryptBankrKey(post.bankr_api_key_encrypted);
  const w = await writeEnv(vm, plain, post.bankr_evm_address ?? result.evmAddress);
  return w.ok
    ? { vmId: vm.id, status: "provisioned" }
    : { vmId: vm.id, status: "env-write-failed", error: w.error ?? "unknown" };
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lockAcquired = await tryAcquireCronLock(CRON_NAME, LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    return NextResponse.json({ skipped: "lock_held" });
  }

  const startedAt = Date.now();
  try {
    const supabase = getSupabase();

    // Candidates: assigned VMs with either no wallet_id, OR wallet_id but no encrypted_key.
    const { data: candidates, error: queryErr } = await supabase
      .from("instaclaw_vms")
      .select("id, assigned_to, ip_address, ssh_port, ssh_user, bankr_wallet_id, bankr_api_key_encrypted")
      .eq("status", "assigned")
      .or("bankr_wallet_id.is.null,bankr_api_key_encrypted.is.null")
      .not("ip_address", "is", null)
      .limit(PER_RUN_LIMIT);

    if (queryErr) {
      logger.error("provision-missing-bankr-wallets: query failed", {
        route: "cron/provision-missing-bankr-wallets",
        code: queryErr.code,
        error: queryErr.message,
      });
      return NextResponse.json({ error: "query_failed", details: queryErr.message }, { status: 500 });
    }

    const vms = (candidates ?? []) as CandidateVm[];
    if (vms.length === 0) {
      return NextResponse.json({ ok: true, scanned: 0, durationMs: Date.now() - startedAt });
    }

    const results: ProcessResult[] = [];
    for (let i = 0; i < vms.length; i += CONCURRENCY) {
      const batch = vms.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(processVm));
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j];
        if (s.status === "fulfilled") {
          results.push(s.value);
        } else {
          results.push({
            vmId: batch[j].id,
            status: "ssh-failed",
            error: `unhandled: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
          });
        }
      }
    }

    const counts = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});

    logger.info("provision-missing-bankr-wallets: run complete", {
      route: "cron/provision-missing-bankr-wallets",
      scanned: vms.length,
      counts,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      ok: true,
      scanned: vms.length,
      counts,
      durationMs: Date.now() - startedAt,
    });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
