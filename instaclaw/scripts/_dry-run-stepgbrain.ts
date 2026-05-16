/**
 * Dry-run stepGbrain against a single VM. Tests the new HTTP-sidecar
 * idempotency check (V+T+S+P) without running any install.
 *
 * Usage:
 *   npx tsx scripts/_dry-run-stepgbrain.ts <vm-name>
 *
 * Expected outcomes (per docs/prd/gbrain-http-fleet-rewrite-plan-2026-05-16.md):
 *   - vm-050 (already HTTP, clean)      → alreadyCorrect: "gbrain v0.35.0.0 (HTTP sidecar, Rule 35)"
 *   - vm-354 (edge_city, stdio era)     → fixed: "[dry-run] gbrain HTTP sidecar install ..."
 *   - vm-918 (non-edge_city)            → no gbrain entry (Gate 1 silent skip)
 *
 * The script invokes reconcileVM with dryRun=true so no destructive ops fire.
 * It sets GBRAIN_INSTALL_ENABLED=true locally so Gate 3 doesn't short-circuit;
 * this only affects this test process, NOT the production Vercel env.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()])
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

// Enable the feature flag locally so stepGbrain's Gate 3 doesn't short-circuit
// without giving us a useful dry-run signal. Production Vercel env is unchanged.
process.env.GBRAIN_INSTALL_ENABLED = "true";

import { reconcileVM } from "../lib/vm-reconcile";
import { VM_MANIFEST } from "../lib/vm-manifest";

async function main() {
  const vmName = process.argv[2];
  if (!vmName) {
    console.error("usage: npx tsx scripts/_dry-run-stepgbrain.ts <vm-name>");
    process.exit(1);
  }

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Look up the VM (accept short or full name)
  const fullName = vmName.startsWith("instaclaw-") ? vmName : `instaclaw-${vmName}`;
  const { data: vm, error } = await sb
    .from("instaclaw_vms")
    .select("*")
    .eq("name", fullName)
    .single();
  if (error || !vm) {
    console.error(`VM ${fullName} not found: ${error?.message ?? "no row"}`);
    process.exit(2);
  }

  console.log(`══ Dry-run stepGbrain on ${vm.name} ══`);
  console.log(`   ip:        ${vm.ip_address}`);
  console.log(`   partner:   ${vm.partner ?? "(none)"}`);
  console.log(`   cv:        ${vm.config_version}`);
  console.log(`   health:    ${vm.health_status}`);
  console.log(`   expected:  ${
    vm.partner === "edge_city" ? "alreadyCorrect OR would-install (depending on state)" : "silent skip (Gate 1: partner not edge_city)"
  }`);
  console.log("");

  const start = Date.now();
  const result = await reconcileVM(vm as never, VM_MANIFEST, {
    dryRun: true,
    strict: false,           // strict skips stepGbrain in Gate 2; we want it to run
    canary: false,           // skip the canary probe; we're only testing stepGbrain
    skipGatewayRestart: true, // don't restart gateway just for a dry-run
  });
  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`── result (${elapsedSec}s) ──`);
  console.log(`fixed:          ${result.fixed.length}`);
  for (const f of result.fixed) {
    const isGbrain = /gbrain/i.test(f);
    console.log(`  ${isGbrain ? "→" : " "} ${f}`);
  }
  console.log(`alreadyCorrect: ${result.alreadyCorrect.length}`);
  for (const a of result.alreadyCorrect) {
    const isGbrain = /gbrain/i.test(a);
    console.log(`  ${isGbrain ? "→" : " "} ${a}`);
  }
  console.log(`errors:         ${result.errors.length}`);
  for (const e of result.errors) console.log(`  ✗ ${e}`);
  console.log(`warnings:       ${result.warnings.length}`);
  for (const w of result.warnings) console.log(`  ⚠ ${w}`);
  console.log("");

  // Verdict on stepGbrain specifically. Use a TIGHTER regex than /gbrain/i —
  // entries like "[dry-run] env.GBRAIN_ANTHROPIC_API_KEY" (from stepEnvVarPush)
  // also contain "gbrain" and would false-match. Anchor on "gbrain v..." (the
  // alreadyCorrect format) or "gbrain HTTP sidecar" (the dry-run/fixed format)
  // or "stepGbrain:" (the error format).
  const isStepGbrainEntry = (s: string) =>
    /(^|\] )gbrain (v|HTTP)/i.test(s) || /\bstepGbrain:/.test(s);
  const gbrainAlreadyCorrect = result.alreadyCorrect.find(isStepGbrainEntry);
  const gbrainFixed = result.fixed.find(isStepGbrainEntry);
  const gbrainError = result.errors.find(isStepGbrainEntry);

  console.log("── stepGbrain verdict ──");
  if (gbrainError) {
    console.log(`✗ ERROR: ${gbrainError}`);
  } else if (gbrainAlreadyCorrect) {
    console.log(`✓ ALREADY_CORRECT: ${gbrainAlreadyCorrect}`);
  } else if (gbrainFixed) {
    console.log(`◆ WOULD_INSTALL: ${gbrainFixed}`);
  } else {
    console.log(`○ SILENT_SKIP (no gbrain entry in result — Gate 1/2/3 returned early)`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack ?? e);
  process.exit(1);
});
