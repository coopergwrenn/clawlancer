/**
 * _backfill-cdp-wallet-md.ts — one-shot WALLET.md rewrite for VMs that
 * got their CDP wallet minted by the OLD provision-missing-cdp-wallets
 * cron deploy (commit 49821c6d), which wrote CDP_WALLET_ADDRESS to .env
 * but did NOT rewrite WALLET.md. Gap closed in commit e20fdc50.
 *
 * Without this script: the 50 VMs minted in the 21:30 UTC tick on
 * 2026-05-24 would carry CDP_WALLET_ADDRESS in .env indefinitely
 * without their WALLET.md ever surfacing the "Backup Wallet (Coinbase
 * CDP)" section — because the cron's `is.null` filter on
 * cdp_wallet_address now excludes them.
 *
 * This script:
 *   1. Queries instaclaw_vms WHERE cdp_wallet_address IS NOT NULL AND
 *      status='assigned' AND ip_address IS NOT NULL.
 *   2. For each, SSHes in, checks WALLET.md for the "Backup Wallet
 *      (Coinbase CDP)" sentinel. If present, skip (idempotent).
 *   3. If absent, rebuilds WALLET.md via buildWalletMd (same canonical
 *      builder configureOpenClaw uses), atomic-writes via tmp+mv,
 *      verifies sentinel landed.
 *
 * Concurrency 3, sequential waves. Run after the cron has minted
 * wallets and before the next tick to catch the gap cohort.
 *
 * Usage:
 *   npx tsx scripts/_backfill-cdp-wallet-md.ts            # dry-run
 *   npx tsx scripts/_backfill-cdp-wallet-md.ts --apply    # actually write
 *   npx tsx scripts/_backfill-cdp-wallet-md.ts --apply --vm=instaclaw-vm-1019
 *
 * Per CLAUDE.md Rule 18: loads .env.local + .env.ssh-key.
 * Per CLAUDE.md Rule 22: never destructively modifies session/memory.
 *   WALLET.md is built-from-DB + atomic-replace; no session state touched.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { NodeSSH } from "node-ssh";
import { writeFileSync, unlinkSync } from "fs";
import { buildWalletMd } from "../lib/ssh.js";

const __dirname_local =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
const repoInstaclaw = resolve(__dirname_local, "..");

for (const f of [
  resolve(repoInstaclaw, ".env.local"),
  resolve(repoInstaclaw, ".env.ssh-key"),
]) {
  try {
    const env = readFileSync(f, "utf-8");
    for (const l of env.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* ignore */
  }
}

const CONCURRENCY = 3;
const SENTINEL = "Backup Wallet (Coinbase CDP)";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const SINGLE_VM = args.find((a) => a.startsWith("--vm="))?.split("=")[1];

interface VmRow {
  id: string;
  name: string;
  ip_address: string;
  ssh_port: number | null;
  ssh_user: string | null;
  cdp_wallet_address: string;
  bankr_evm_address: string | null;
  bankr_token_address: string | null;
  bankr_token_symbol: string | null;
}

interface Result {
  vm: string;
  status: "ok-already-has-section" | "rewrote" | "skip-no-key" | "ssh-failed" | "write-failed" | "sentinel-missing";
  detail?: string;
}

async function processVm(vm: VmRow): Promise<Result> {
  if (!process.env.SSH_PRIVATE_KEY_B64) {
    return { vm: vm.name, status: "skip-no-key" };
  }
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      port: vm.ssh_port ?? 22,
      username: vm.ssh_user ?? "openclaw",
      privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64, "base64").toString("utf-8"),
      readyTimeout: 10_000,
    });
  } catch (e) {
    return {
      vm: vm.name,
      status: "ssh-failed",
      detail: e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100),
    };
  }
  try {
    // Idempotency check: if WALLET.md already has the sentinel, no-op.
    const probe = await ssh.execCommand(
      `grep -c "${SENTINEL}" ~/.openclaw/workspace/WALLET.md 2>/dev/null || echo 0`,
    );
    if (parseInt((probe.stdout || "0").trim(), 10) > 0) {
      return { vm: vm.name, status: "ok-already-has-section" };
    }

    if (!APPLY) {
      return {
        vm: vm.name,
        status: "rewrote",
        detail: "DRY-RUN (would rewrite)",
      };
    }

    // Build canonical WALLET.md via the same helper configureOpenClaw uses.
    const walletMd = buildWalletMd({
      bankrEvmAddress: vm.bankr_evm_address,
      bankrTokenAddress: vm.bankr_token_address,
      bankrTokenSymbol: vm.bankr_token_symbol,
      cdpWalletAddress: vm.cdp_wallet_address,
    });
    const b64 = Buffer.from(walletMd, "utf-8").toString("base64");
    const out = await ssh.execCommand(
      [
        'mkdir -p "$HOME/.openclaw/workspace"',
        `echo '${b64}' | base64 -d > "$HOME/.openclaw/workspace/WALLET.md.tmp"`,
        'mv "$HOME/.openclaw/workspace/WALLET.md.tmp" "$HOME/.openclaw/workspace/WALLET.md"',
        `grep -q "${SENTINEL}" "$HOME/.openclaw/workspace/WALLET.md" && echo OK || echo MISSING`,
      ].join("\n"),
    );
    if (!out.stdout.includes("OK")) {
      return {
        vm: vm.name,
        status: "sentinel-missing",
        detail: out.stdout.trim().slice(-100),
      };
    }
    return { vm: vm.name, status: "rewrote" };
  } catch (e) {
    return {
      vm: vm.name,
      status: "write-failed",
      detail: e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100),
    };
  } finally {
    ssh.dispose();
  }
}

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  let query = supabase
    .from("instaclaw_vms")
    .select(
      "id, name, ip_address, ssh_port, ssh_user, cdp_wallet_address, bankr_evm_address, bankr_token_address, bankr_token_symbol",
    )
    .eq("status", "assigned")
    .not("cdp_wallet_address", "is", null)
    .not("ip_address", "is", null);

  if (SINGLE_VM) query = query.eq("name", SINGLE_VM);

  const { data, error } = await query;
  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }
  const vms = (data ?? []) as VmRow[];
  console.log(
    `${APPLY ? "APPLY" : "DRY-RUN"} mode. ${vms.length} candidate VM(s) with cdp_wallet_address set.`,
  );
  if (vms.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const results: Result[] = [];
  for (let i = 0; i < vms.length; i += CONCURRENCY) {
    const batch = vms.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(processVm));
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      if (s.status === "fulfilled") results.push(s.value);
      else
        results.push({
          vm: batch[j].name,
          status: "write-failed",
          detail: "unhandled exception",
        });
    }
    process.stdout.write(`  processed ${Math.min(i + CONCURRENCY, vms.length)}/${vms.length}\r`);
  }
  console.log("");

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  console.log("\n── Summary ──");
  for (const [status, n] of Object.entries(counts).sort()) {
    console.log(`  ${status}: ${n}`);
  }

  const failures = results.filter(
    (r) => !["ok-already-has-section", "rewrote", "skip-no-key"].includes(r.status),
  );
  if (failures.length > 0) {
    console.log("\n── Failures ──");
    for (const f of failures) console.log(`  ${f.vm}: ${f.status} — ${f.detail ?? ""}`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
