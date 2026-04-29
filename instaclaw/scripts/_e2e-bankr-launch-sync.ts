/**
 * E2E test for the Path B launch-sync fix on vm-780 (Cooper's test VM).
 *
 * vm-780's wallet (0x95d057a3cd336d868bd3af772d23df29bc5166de) has tokens
 * launched on Bankr but the DB row may have stale fields. This script:
 *   1. Reads current DB state (snapshot for restore on failure)
 *   2. Resets bankr_token_* fields to NULL
 *   3. Runs syncBankrLaunchForVm — expects updated:true
 *   4. Re-reads DB, verifies fields populated from Bankr's tokens[0]
 *   5. Runs sync again — expects already_synced (idempotency)
 *   6. Tests race-safety: resets, runs two concurrent calls, expects
 *      exactly one updated:true and one race_lost
 *   7. Restores original DB state if anything fails
 */
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
import { syncBankrLaunchForVm } from "../lib/bankr-launch-sync";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface VmSnapshot {
  bankr_token_address: string | null;
  bankr_token_symbol: string | null;
  bankr_token_launched_at: string | null;
  tokenization_platform: string | null;
}

async function readSnapshot(vmId: string): Promise<VmSnapshot> {
  const { data, error } = await supabase
    .from("instaclaw_vms")
    .select(
      "bankr_token_address, bankr_token_symbol, bankr_token_launched_at, tokenization_platform",
    )
    .eq("id", vmId)
    .single();
  if (error || !data) throw new Error(`readSnapshot failed: ${error?.message}`);
  return data as VmSnapshot;
}

async function resetForTest(vmId: string): Promise<void> {
  const { error } = await supabase
    .from("instaclaw_vms")
    .update({
      bankr_token_address: null,
      bankr_token_symbol: null,
      bankr_token_launched_at: null,
      tokenization_platform: null,
    })
    .eq("id", vmId);
  if (error) throw new Error(`resetForTest failed: ${error.message}`);
}

async function restore(vmId: string, snapshot: VmSnapshot): Promise<void> {
  const { error } = await supabase
    .from("instaclaw_vms")
    .update(snapshot)
    .eq("id", vmId);
  if (error) throw new Error(`restore failed: ${error.message}`);
}

(async () => {
  const VM_NAME = "instaclaw-vm-780";
  const { data: vm, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("id, bankr_wallet_id, bankr_evm_address")
    .eq("name", VM_NAME)
    .single();
  if (vmErr || !vm) {
    console.error("Cannot find VM:", VM_NAME, vmErr?.message);
    process.exit(1);
  }
  if (!vm.bankr_evm_address) {
    console.error("VM has no bankr_evm_address — provision a wallet first.");
    process.exit(1);
  }

  console.log(`\n=== E2E Test: Bankr launch sync on ${VM_NAME} ===`);
  console.log(`VM id: ${vm.id}`);
  console.log(`Wallet: ${vm.bankr_evm_address}\n`);

  const original = await readSnapshot(vm.id);
  console.log("Original DB snapshot:", original);

  let allPassed = true;
  try {
    // ── Test 1: clean slate → sync should detect and write ──
    console.log("\n--- Test 1: cold sync ---");
    await resetForTest(vm.id);
    const r1 = await syncBankrLaunchForVm(vm.id);
    console.log("Result:", r1);
    if (!r1.updated) {
      console.error("FAIL: expected updated:true on cold sync");
      allPassed = false;
    } else {
      const after = await readSnapshot(vm.id);
      console.log("DB after sync:", after);
      const fieldsCorrect =
        after.bankr_token_address === r1.tokenAddress &&
        after.bankr_token_symbol === r1.tokenSymbol &&
        after.tokenization_platform === "bankr" &&
        !!after.bankr_token_launched_at;
      if (fieldsCorrect) {
        console.log("PASS: all fields populated correctly");
      } else {
        console.error("FAIL: DB fields do not match sync result");
        allPassed = false;
      }
    }

    // ── Test 2: idempotency — second sync is a no-op ──
    console.log("\n--- Test 2: idempotency (second sync) ---");
    const r2 = await syncBankrLaunchForVm(vm.id);
    console.log("Result:", r2);
    if (r2.updated) {
      console.error("FAIL: expected updated:false on already-synced");
      allPassed = false;
    } else if (r2.reason !== "already_synced") {
      console.error(`FAIL: expected reason 'already_synced', got '${r2.reason}'`);
      allPassed = false;
    } else {
      console.log("PASS: idempotent");
    }

    // ── Test 3: race-safety — two concurrent calls, exactly one wins ──
    console.log("\n--- Test 3: race-safety (concurrent sync) ---");
    await resetForTest(vm.id);
    const [a, b] = await Promise.all([
      syncBankrLaunchForVm(vm.id),
      syncBankrLaunchForVm(vm.id),
    ]);
    console.log("Result A:", a);
    console.log("Result B:", b);
    const winners = [a, b].filter((r) => r.updated).length;
    const racelost = [a, b].filter((r) => r.reason === "race_lost" || r.reason === "already_synced").length;
    if (winners === 1 && racelost === 1) {
      console.log("PASS: exactly one writer won, one lost the race");
    } else {
      console.error(`FAIL: expected 1 winner + 1 loser, got ${winners} winners + ${racelost} race-losses`);
      allPassed = false;
    }
  } catch (err) {
    console.error("\nTEST EXCEPTION:", err);
    allPassed = false;
  } finally {
    // Restore whatever the original DB state was so we don't leave the
    // test VM in a half-tested state.
    console.log("\n--- Restoring original DB state ---");
    await restore(vm.id, original);
    const restored = await readSnapshot(vm.id);
    console.log("Restored:", restored);
  }

  console.log(`\n=== ${allPassed ? "ALL TESTS PASSED" : "ONE OR MORE TESTS FAILED"} ===\n`);
  process.exit(allPassed ? 0 : 1);
})();
