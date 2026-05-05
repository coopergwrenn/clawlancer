/**
 * Push static dgclaw skill files to vm-893, vm-895, vm-896 — the 3 freshly-
 * provisioned VMs flagged in Phase 2 audit as missing ~/.openclaw/skills/dgclaw/.
 *
 * Source files (verified above wc):
 *   instaclaw/skills/dgclaw/SKILL.md                          (22,481 bytes)
 *   instaclaw/skills/dgclaw/references/api.md                  (2,147 bytes)
 *   instaclaw/skills/dgclaw/references/strategy-playbook.md   (34,322 bytes)
 *
 * Each file goes to ~/.openclaw/skills/dgclaw/<rel> on the VM.
 * Verify-after-write per Rule 24 — abort the per-VM push if any file missing.
 * No gateway restart needed (skills are read on demand).
 */
import { readFileSync } from "fs";
import { connectSSH } from "../lib/ssh";
import { createClient } from "@supabase/supabase-js";

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

const SOURCE_BASE = "/Users/cooperwrenn/wild-west-bots/instaclaw/skills/dgclaw";
const FILES = [
  { local: "SKILL.md", remote: "SKILL.md" },
  { local: "references/api.md", remote: "references/api.md" },
  { local: "references/strategy-playbook.md", remote: "references/strategy-playbook.md" },
];

async function pushVM(vm: any): Promise<{ ok: boolean; detail: string }> {
  const ssh = await connectSSH(vm);
  try {
    // Pre-state
    const pre = await ssh.execCommand(
      `ls -la ~/.openclaw/skills/dgclaw 2>&1 | head -10`
    );
    const wasPresent = !pre.stdout.includes("No such file") && pre.stdout.includes("SKILL.md");
    if (wasPresent) return { ok: true, detail: "already had SKILL.md (skipping push)" };

    // mkdir + push each file
    await ssh.execCommand(`mkdir -p ~/.openclaw/skills/dgclaw/references`);
    for (const f of FILES) {
      const content = readFileSync(`${SOURCE_BASE}/${f.local}`);
      const b64 = content.toString("base64");
      const r = await ssh.execCommand(
        `echo '${b64}' | base64 -d > ~/.openclaw/skills/dgclaw/${f.remote} && wc -c ~/.openclaw/skills/dgclaw/${f.remote}`
      );
      if (r.code !== 0) return { ok: false, detail: `write ${f.remote}: ${r.stderr}` };
    }

    // Verify-after-write per Rule 24
    const verify = await ssh.execCommand(
      `test -f ~/.openclaw/skills/dgclaw/SKILL.md && \
       test -f ~/.openclaw/skills/dgclaw/references/api.md && \
       test -f ~/.openclaw/skills/dgclaw/references/strategy-playbook.md && \
       echo VERIFY_OK || echo VERIFY_FAIL`
    );
    if (!verify.stdout.includes("VERIFY_OK")) {
      return { ok: false, detail: `verify failed: ${verify.stdout.trim()} | ${verify.stderr.slice(0, 200)}` };
    }

    // Final size check
    const sizes = await ssh.execCommand(
      `wc -c ~/.openclaw/skills/dgclaw/SKILL.md ~/.openclaw/skills/dgclaw/references/api.md ~/.openclaw/skills/dgclaw/references/strategy-playbook.md`
    );
    return { ok: true, detail: sizes.stdout.trim().replace(/\s+/g, " ") };
  } finally {
    ssh.dispose();
  }
}

(async () => {
  const targets = ["instaclaw-vm-893", "instaclaw-vm-895", "instaclaw-vm-896"];
  const { data: vms } = await sb.from("instaclaw_vms").select("*").in("name", targets);

  console.log(`Pushing static dgclaw to ${vms?.length ?? 0} VMs (Rule 24 verify-after-write)...\n`);

  for (const vm of vms ?? []) {
    process.stdout.write(`  ${vm.name} ... `);
    try {
      const r = await pushVM(vm);
      console.log(r.ok ? `✓ ${r.detail}` : `✗ ${r.detail}`);
    } catch (e) {
      console.log(`✗ EXCEPTION: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
