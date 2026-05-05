/**
 * vm-725 (Doug) restart + auth-cache clear.
 *   1. Pre: capture mem/swap state + last 3 gateway log lines
 *   2. Clear stale auth-cache via lib/auth-cache.ts (atomic Python write)
 *   3. Stop gateway
 *   4. Start gateway
 *   5. Poll is-active + /health=200 with retry up to 60s
 *   6. Post: capture mem/swap, /health body, last 3 gateway log lines
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
  const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", "instaclaw-vm-725").single();
  if (!vm) { console.error("vm-725 not found"); process.exit(1); }
  console.log(`Target: ${vm.name} (${vm.ip_address}, owner=Doug)\n`);

  console.log("Step 1: Pre-state capture");
  const ssh = await connectSSH(vm as any);
  try {
    const pre = await ssh.execCommand(
      `echo PRE_MEM:; free -m | head -3
echo PRE_HEALTH:; curl -sf -m 3 http://localhost:18789/health 2>&1 | head -c 200; echo
echo PRE_GATEWAY_LAST_3:; journalctl --user -u openclaw-gateway -n 3 --no-pager 2>/dev/null | tail -3`
    );
    console.log(pre.stdout);

    console.log("\nStep 2: Clear stale auth-cache (proactive — Rule 16)");
    const cacheRes = await clearStaleAuthCacheForUser(sb, vm.assigned_to, "doug-vm725-restart-may5");
    console.log(`  cleared ${cacheRes?.cleared ?? "?"} VM(s); errors=${cacheRes?.errors?.length ?? 0}`);
    if (cacheRes?.errors?.length) {
      for (const e of cacheRes.errors) console.log(`    err: ${JSON.stringify(e)}`);
    }

    console.log("\nStep 3: Stop gateway");
    const stop = await ssh.execCommand(
      `systemctl --user stop openclaw-gateway 2>&1; echo STOP_DONE
sleep 2
systemctl --user is-active openclaw-gateway 2>&1`
    );
    console.log(stop.stdout);

    console.log("\nStep 4: Start gateway");
    const start = await ssh.execCommand(
      `systemctl --user start openclaw-gateway 2>&1; echo START_DONE`
    );
    console.log(start.stdout);

    console.log("\nStep 5: Poll for active + healthy (up to 60s)");
    let active = false, healthy = false, lastBody = "";
    for (let i = 0; i < 12; i++) {
      const probe = await ssh.execCommand(
        `systemctl --user is-active openclaw-gateway 2>&1; curl -sf -m 3 http://localhost:18789/health 2>&1 | head -c 200`
      );
      const lines = probe.stdout.split("\n");
      const isActive = lines[0]?.trim() === "active";
      const healthBody = lines.slice(1).join("\n").trim();
      const isHealthy = healthBody.includes("ok") || healthBody.includes('"status":"live"');
      lastBody = healthBody;
      console.log(`  iter ${i+1}: active=${isActive} healthy=${isHealthy} body=${healthBody.slice(0, 80)}`);
      if (isActive && isHealthy) { active = true; healthy = true; break; }
      await new Promise(r => setTimeout(r, 5000));
    }

    console.log("\nStep 6: Post-state capture");
    const post = await ssh.execCommand(
      `echo POST_MEM:; free -m | head -3
echo POST_HEALTH:; curl -sf -m 3 http://localhost:18789/health 2>&1 | head -c 200; echo
echo POST_GATEWAY_LAST_5:; journalctl --user -u openclaw-gateway -n 5 --no-pager 2>/dev/null | tail -5
echo PROCESSES:; ps -u openclaw -o pid,rss,comm | sort -k2 -rn | head -10`
    );
    console.log(post.stdout);

    console.log("\n══ Verification ══");
    console.log(`  gateway active:   ${active ? "✓" : "✗"}`);
    console.log(`  /health=200:      ${healthy ? "✓" : "✗"}`);
    console.log(`  ${active && healthy ? "✓ RESTART SUCCESSFUL" : "✗ INVESTIGATE — gateway did not come back cleanly"}`);
    if (!active || !healthy) console.log(`  last health body: ${lastBody}`);
  } finally {
    ssh.dispose();
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
