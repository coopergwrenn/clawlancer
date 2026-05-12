/**
 * Read-only check: is the emergency-bypass key present in an edge_city VM's
 * authorized_keys as a separate line with NO `command="..."` directive?
 *
 * Pre-cutover gate for scripts/_deploy-privacy-bridge-cutover.ts — that script
 * aborts unless an unrestricted bypass key already exists, because otherwise
 * a malformed rewrite of authorized_keys locks Cooper out of the VM forever.
 *
 * Usage:
 *   tsx scripts/_check-bypass-key.ts [vm-name]   (default: vm-050)
 *
 * Loads .env.local AND .env.ssh-key per Rule 18 (SSH_PRIVATE_KEY_B64).
 * No writes anywhere — only reads authorized_keys via SSH.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import { connectSSH } from "../lib/ssh";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env.ssh-key") });

async function main() {
  const vmName = process.argv[2] || "instaclaw-vm-050";
  // The DB column "name" is the full "instaclaw-vm-NNN" form; allow shorthand
  const dbName = vmName.startsWith("instaclaw-") ? vmName : `instaclaw-${vmName}`;

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: vm, error } = await sb
    .from("instaclaw_vms")
    .select("*")
    .eq("name", dbName)
    .single();
  if (error || !vm) {
    console.error(`No VM row for name=${dbName}: ${error?.message}`);
    process.exit(1);
  }

  console.log(`Probing ${vm.name} (${vm.ip_address}, partner=${vm.partner}, status=${vm.status})...`);

  const ssh = await connectSSH(vm);
  try {
    const result = await ssh.execCommand("cat ~/.ssh/authorized_keys", {
      cwd: "/home/openclaw",
    });
    if (result.code !== 0) {
      console.error("Failed to read authorized_keys:", result.stderr);
      process.exit(1);
    }
    const lines = result.stdout.split("\n");

    console.log(`\nauthorized_keys: ${lines.length} total lines\n`);
    console.log("─".repeat(80));

    const keyLines: { idx: number; raw: string; hasCommand: boolean; keyType: string; keyTail: string; comment: string }[] = [];

    lines.forEach((raw, idx) => {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) return;

      // Find the key-type token (ssh-rsa, ssh-ed25519, ecdsa-sha2-*, etc.)
      const keyTypeMatch = trimmed.match(/(ssh-rsa|ssh-ed25519|ssh-dss|ecdsa-sha2-[a-z0-9-]+)/);
      if (!keyTypeMatch) {
        console.log(`Line ${idx + 1}: [unrecognized] ${trimmed.slice(0, 80)}`);
        return;
      }
      const keyType = keyTypeMatch[1];
      const keyTypeIdx = trimmed.indexOf(keyType);
      const prefix = trimmed.slice(0, keyTypeIdx).trim();
      const hasCommand = /(^|[,\s])command\s*=\s*"/i.test(prefix);

      const afterKey = trimmed.slice(keyTypeIdx + keyType.length).trim();
      const keyBlob = afterKey.split(/\s+/)[0] || "";
      const keyTail = keyBlob.length >= 12 ? keyBlob.slice(-12) : keyBlob;
      const comment = afterKey.slice(keyBlob.length).trim();

      keyLines.push({ idx: idx + 1, raw: trimmed, hasCommand, keyType, keyTail, comment });
    });

    keyLines.forEach((k) => {
      const tag = k.hasCommand ? "🔒 command= present" : "🔓 no command= (bypass-shape)";
      console.log(`Line ${k.idx}: ${tag}`);
      console.log(`         keyType=${k.keyType}  keyTail=…${k.keyTail}  comment="${k.comment}"`);
      // Print the prefix if there's a command= directive so we can see what it points at
      const prefix = k.raw.slice(0, k.raw.indexOf(k.keyType));
      if (prefix.trim()) {
        console.log(`         prefix: ${prefix.trim().slice(0, 200)}`);
      }
    });

    console.log("─".repeat(80));
    console.log(`Summary:`);
    console.log(`  Total recognized key lines: ${keyLines.length}`);
    const withCommand = keyLines.filter((k) => k.hasCommand).length;
    const without = keyLines.filter((k) => !k.hasCommand).length;
    console.log(`  With command="..." directive: ${withCommand}`);
    console.log(`  Without (bypass-shape):      ${without}`);

    console.log(`\nCutover precondition check:`);
    if (without === 0) {
      console.log(`  ❌ BLOCKED — NO line without command= directive.`);
      console.log(`     The cutover script would have nothing to fall back to`);
      console.log(`     if the bridge ever breaks. You'd be locked out.`);
      console.log(`     Action: deploy a bypass key as a SEPARATE line before cutover.`);
    } else if (withCommand === 0) {
      console.log(`  ✅ BYPASS PRESENT — ${without} line(s) without command= directive.`);
      console.log(`     But NO line currently has a command= directive either, so`);
      console.log(`     cutover has NOT yet been run on this VM. Safe to run.`);
    } else {
      console.log(`  🚨 ALREADY CUT OVER — ${withCommand} line(s) with command=,`);
      console.log(`     ${without} bypass line(s). Cutover script previously ran on`);
      console.log(`     this VM. Bridge is currently enforcing on the command= lines.`);
    }
  } finally {
    ssh.dispose();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
