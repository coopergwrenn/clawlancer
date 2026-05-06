/**
 * vm-729 (Notboredclaw) emergency fix — 2026-05-06.
 *
 * Diagnosis: gateway alive but Anthropic auth-profile stuck in cooldown loop
 * after a "messages: at least one message is required" 400 error precipitated
 * a format-window cooldown. 14 gateway restarts in 24h. Rule 16 layer-2
 * didn't recover.
 *
 * Fix sequence:
 *   1. Inspect auth-profiles.json failureState (record before)
 *   2. Inspect latest session jsonl tail — confirm Rule 22 trim hasn't gone
 *      too far (empty messages array would re-trigger the same 400)
 *   3. Call clearStaleAuthCacheForUser (Rule 16 layer-1)
 *   4. Stop gateway
 *   5. Start gateway
 *   6. Poll up to 90s for active + /health=200
 *   7. Post: confirm auth-profiles.json is clean, sample journal for new
 *      cooldown events, verify no immediate re-failure
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
  const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", "instaclaw-vm-729").single();
  if (!vm) { console.error("vm-729 not found"); process.exit(1); }
  console.log(`Target: ${vm.name} (${vm.ip_address}, Notboredclaw / Doug)\n`);

  const ssh = await connectSSH(vm as any);
  try {
    console.log("Step 1: Pre-state");
    const pre = await ssh.execCommand(
      `echo BEFORE_AUTH_PROFILES:
python3 -c "import json; d=json.load(open('/home/openclaw/.openclaw/agents/main/agent/auth-profiles.json')); profs=d.get('profiles',{});
for n,p in profs.items(): print(n+': failureState='+str(p.get('failureState'))+' disabledUntil='+str(p.get('disabledUntil')))" 2>&1
echo BEFORE_LATEST_JSONL:
LATEST=$(ls -t ~/.openclaw/agents/main/sessions/*.trajectory.jsonl 2>/dev/null | head -1)
echo PATH: $LATEST
[ -n "$LATEST" ] && wc -l "$LATEST"
echo BEFORE_HEALTH:
systemctl --user is-active openclaw-gateway 2>&1
curl -sf -m 3 http://localhost:18789/health 2>&1 | head -c 100; echo`
    );
    console.log(pre.stdout);

    console.log("\nStep 2: Clear stale auth-cache (Rule 16 layer-1)");
    const cacheRes = await clearStaleAuthCacheForUser(sb, vm.assigned_to, "vm729-may6-emergency");
    console.log(`  cleared=${cacheRes?.cleared ?? "?"} errors=${cacheRes?.errors?.length ?? 0}`);
    if (cacheRes?.errors?.length) {
      for (const e of cacheRes.errors) console.log(`    err: ${JSON.stringify(e).slice(0, 200)}`);
    }

    console.log("\nStep 3: Verify auth-profiles.json post-clear");
    const verify = await ssh.execCommand(
      `python3 -c "import json; d=json.load(open('/home/openclaw/.openclaw/agents/main/agent/auth-profiles.json')); profs=d.get('profiles',{});
for n,p in profs.items(): print(n+': failureState='+str(p.get('failureState'))+' disabledUntil='+str(p.get('disabledUntil')))" 2>&1`
    );
    console.log(verify.stdout);

    console.log("\nStep 4: Stop gateway");
    const stop = await ssh.execCommand(
      `systemctl --user stop openclaw-gateway 2>&1; sleep 2; systemctl --user is-active openclaw-gateway 2>&1`
    );
    console.log(stop.stdout);

    console.log("\nStep 5: Start gateway");
    const start = await ssh.execCommand(`systemctl --user start openclaw-gateway 2>&1; echo START_DONE`);
    console.log(start.stdout);

    console.log("\nStep 6: Poll up to 90s");
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

    console.log("\nStep 7: Post-state");
    const post = await ssh.execCommand(
      `echo POST_HEALTH:
curl -sf -m 5 http://localhost:18789/health; echo
echo NEW_COOLDOWN_EVENTS_LAST_60S:
journalctl --user -u openclaw-gateway --since '60 seconds ago' --no-pager 2>/dev/null | grep -ciE 'cooldown|failoverError|all profiles unavailable'
echo MEM:
free -m | head -2 | tail -1`
    );
    console.log(post.stdout);

    console.log(`\n══ ${healthy ? "✓ FIX APPLIED — monitor next chat for normal response" : "✗ INVESTIGATE — gateway not healthy"} ══`);
  } finally {
    ssh.dispose();
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
