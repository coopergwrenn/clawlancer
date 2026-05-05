/**
 * vm-724 (Sebastian) gateway restart — same fix as vm-725 (Doug).
 * Root cause: fork EAGAIN from memory-commit failures during chrome bursts
 * (7 chrome procs + 495/495MB swap full). Restart clears chromes + recovers
 * memory headroom. Also clears stale auth-cache per Rule 16.
 */
import { readFileSync } from "fs";
import { connectSSH } from "../lib/ssh";
import { createClient } from "@supabase/supabase-js";
import { clearStaleAuthCacheForUser } from "../lib/auth-cache";

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
  const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", "instaclaw-vm-724").single();
  if (!vm) { console.error("not found"); process.exit(1); }
  console.log(`Target: ${vm.name} (${vm.ip_address}, sebastian)\n`);

  const ssh = await connectSSH(vm as any);
  try {
    console.log("Step 1: pre-state");
    const pre = await ssh.execCommand(
      `echo MEM:; free -m | head -3; echo CHROMES: $(ps -eo comm | grep -c chrome); echo HEALTH:; curl -sf -m 3 http://localhost:18789/health 2>&1 | head -c 100; echo`
    );
    console.log(pre.stdout);

    console.log("Step 2: clear stale auth-cache (Rule 16)");
    const cacheRes = await clearStaleAuthCacheForUser(sb, vm.assigned_to, "vm724-restart");
    console.log(`  cleared=${cacheRes?.cleared ?? "?"} errors=${cacheRes?.errors?.length ?? 0}`);

    console.log("Step 3: stop gateway (also kills child chromes)");
    const stop = await ssh.execCommand(
      `systemctl --user stop openclaw-gateway 2>&1; sleep 2; pkill -9 chromium 2>/dev/null; pkill -9 chrome 2>/dev/null; sleep 1; echo CHROMES_AFTER_KILL: $(ps -eo comm | grep -c chrome); systemctl --user is-active openclaw-gateway 2>&1`
    );
    console.log(stop.stdout);

    console.log("Step 4: start gateway");
    const start = await ssh.execCommand(`systemctl --user start openclaw-gateway 2>&1; echo START_DONE`);
    console.log(start.stdout);

    console.log("Step 5: poll for healthy (up to 90s)");
    let healthy = false;
    for (let i = 0; i < 18; i++) {
      const probe = await ssh.execCommand(
        `systemctl --user is-active openclaw-gateway 2>&1; curl -sf -m 3 http://localhost:18789/health 2>&1 | head -c 80`
      );
      const lines = probe.stdout.split("\n");
      const isActive = lines[0]?.trim() === "active";
      const healthBody = lines.slice(1).join("\n").trim();
      const isHealthy = healthBody.includes("ok") || healthBody.includes('"status":"live"');
      console.log(`  iter ${i+1}: active=${isActive} healthy=${isHealthy}`);
      if (isActive && isHealthy) { healthy = true; break; }
      await new Promise(r => setTimeout(r, 5000));
    }

    console.log("\nStep 6: post-state");
    const post = await ssh.execCommand(
      `echo MEM:; free -m | head -3; echo CHROMES: $(ps -eo comm | grep -c chrome); echo HEALTH:; curl -sf -m 5 http://localhost:18789/health; echo; echo PIDS_TOTAL: $(ps -eLf | wc -l)`
    );
    console.log(post.stdout);

    console.log(`\n══ ${healthy ? "✓ RESTART SUCCESSFUL" : "✗ INVESTIGATE — gateway not healthy"} ══`);
  } finally {
    ssh.dispose();
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
