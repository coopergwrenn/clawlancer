/**
 * Dry-run the actual reconciler against vm-625 and vm-846 to identify
 * which step is producing result.errors (= reason cv won't bump).
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

import { auditVMConfig } from "../lib/ssh";

async function audit(name: string) {
  console.log(`\n========== ${name} ==========`);
  const { data: vm } = await sb
    .from("instaclaw_vms")
    .select("*")
    .eq("name", name)
    .single();
  if (!vm) { console.log("not found"); return; }

  const t0 = Date.now();
  try {
    // dryRun=true so we see what WOULD happen without mutating
    const r = await auditVMConfig(vm, {
      strict: false,
      canary: false,
      dryRun: true,
      skipGatewayRestart: false,
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Audit took ${elapsed}s`);
    console.log(`  fixed (would-fix): ${r.fixed.length} entries`);
    console.log(`  alreadyCorrect: ${r.alreadyCorrect.length} entries`);
    console.log(`  errors: ${r.errors.length}`);
    if (r.fixed.length) {
      console.log(`  fixed list:`);
      for (const f of r.fixed.slice(0, 20)) console.log(`    - ${f}`);
    }
    if (r.errors.length) {
      console.log(`  ERROR list (THIS is why cv won't bump):`);
      for (const e of r.errors) console.log(`    - ${e}`);
    }
  } catch (e) {
    console.log(`THREW after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, (e as Error).message);
  }
}

async function main() {
  for (const n of ["instaclaw-vm-625", "instaclaw-vm-846"]) {
    await audit(n);
  }
}

main().then(() => process.exit(0));
