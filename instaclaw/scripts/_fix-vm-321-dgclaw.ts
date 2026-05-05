/**
 * Fix vm-321 (frankyecash@gmail.com): broken ~/dgclaw-skill sibling clone.
 * Same fix as vm-729 this morning:
 *   1. rm -rf ~/dgclaw-skill (broken stub: no .git, no scripts)
 *   2. git clone --depth 1 https://github.com/Virtual-Protocol/dgclaw-skill ~/dgclaw-skill
 *   3. chmod +x scripts
 *   4. ensure PATH already in .bashrc
 * Then verify the install: ls + git-status + check scripts/dgclaw.sh exists.
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

(async () => {
  const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", "instaclaw-vm-321").single();
  if (!vm) { console.error("vm-321 not found"); process.exit(1); }
  console.log(`Target: ${vm.name} (${vm.ip_address}, owner=frankyecash, agdp_enabled=${vm.agdp_enabled})\n`);

  const ssh = await connectSSH(vm as any);
  try {
    console.log("Step 1: Pre-state inspection");
    const pre = await ssh.execCommand(
      `echo '── BEFORE ──'; ls -la ~/dgclaw-skill 2>&1 | head -10; echo '── scripts ──'; ls -la ~/dgclaw-skill/scripts 2>&1 | head -10; echo '── PATH check ──'; grep dgclaw-skill ~/.bashrc 2>&1 | head -3`
    );
    console.log(pre.stdout);

    console.log("\nStep 2: Remove broken stub + re-clone");
    const fix = await ssh.execCommand(
      `set -e
rm -rf ~/dgclaw-skill
echo "removed"
git clone --depth 1 https://github.com/Virtual-Protocol/dgclaw-skill ~/dgclaw-skill 2>&1 | tail -5
echo "cloned"
chmod +x ~/dgclaw-skill/scripts/*.sh 2>/dev/null || true
chmod +x ~/dgclaw-skill/scripts/*.ts 2>/dev/null || true
echo "chmod_done"
grep -qF 'dgclaw-skill/scripts' ~/.bashrc 2>/dev/null && echo 'PATH_already_present' || (echo 'export PATH="$HOME/dgclaw-skill/scripts:$PATH"' >> ~/.bashrc && echo 'PATH_added')
echo "done"`,
      { execOptions: { pty: false } }
    );
    console.log("STDOUT:", fix.stdout);
    if (fix.stderr) console.log("STDERR:", fix.stderr.slice(0, 500));

    console.log("\nStep 3: Post-state verification");
    const post = await ssh.execCommand(
      `echo '── AFTER: ~/dgclaw-skill ──'; ls -la ~/dgclaw-skill 2>&1 | head -15; echo '── scripts/ ──'; ls -la ~/dgclaw-skill/scripts 2>&1 | head -10; echo '── git status ──'; cd ~/dgclaw-skill && git status --short 2>&1 | head -5; echo '── git log -1 ──'; cd ~/dgclaw-skill && git log -1 --format='%h %s (%ai)' 2>&1; echo '── dgclaw.sh exists? ──'; test -f ~/dgclaw-skill/scripts/dgclaw.sh && echo "YES" || echo "NO"`
    );
    console.log(post.stdout);

    // Verification gate
    const hasGit = post.stdout.includes(".git");
    const hasScripts = post.stdout.includes("dgclaw.sh") || post.stdout.match(/\.ts/);
    const sshOK = !post.stderr.includes("error");
    console.log(`\n══ Verification ══`);
    console.log(`  has .git/:        ${hasGit ? "✓" : "✗"}`);
    console.log(`  has scripts:      ${hasScripts ? "✓" : "✗"}`);
    console.log(`  no ssh errors:    ${sshOK ? "✓" : "✗"}`);
    console.log(`  ${hasGit && hasScripts && sshOK ? "✓ FIX SUCCESSFUL" : "✗ INVESTIGATE — verification failed"}`);
  } finally {
    ssh.dispose();
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
