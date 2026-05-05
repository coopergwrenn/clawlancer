/**
 * Post-restart probe for vm-725:
 *   1. Empty-response events since 14:58 (after restart)
 *   2. Recent gateway log
 *   3. OpenClaw config schema for empty/retry keys (so we can pick the right key for fleet bump)
 *   4. Current openclaw.json values for retry/empty config
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

const PROBE = `set +e
echo === EMPTY-RESPONSE EVENTS SINCE 14:58 UTC ===
journalctl --user -u openclaw-gateway --since '14:58:00' --no-pager 2>/dev/null | grep -ciE 'empty response|incomplete turn'
echo === SAMPLE OF LAST 10 IF ANY ===
journalctl --user -u openclaw-gateway --since '14:58:00' --no-pager 2>/dev/null | grep -iE 'empty response|incomplete turn' | tail -10
echo === LAST 15 GATEWAY LINES ===
journalctl --user -u openclaw-gateway -n 15 --no-pager 2>/dev/null | tail -15
echo === OPENCLAW CONFIG SCHEMA — empty/retry keys ===
source ~/.nvm/nvm.sh 2>/dev/null
openclaw config list 2>/dev/null | grep -iE 'empty|retry|retries|attempt|recovery|fallback' | head -30
echo === openclaw.json keys mentioning empty/retry ===
python3 -c "
import json
d = json.load(open('/home/openclaw/.openclaw/openclaw.json'))
def walk(o, p=''):
  if isinstance(o, dict):
    for k, v in o.items():
      key = p + '.' + k if p else k
      if any(x in k.lower() for x in ['retry', 'empty', 'attempt', 'fallback']):
        print(key + ' = ' + str(v))
      walk(v, key)
walk(d)
" 2>/dev/null
echo === CHAT COMPLETIONS HEALTH PROBE ===
date -u +%FT%TZ
curl -sf -m 5 http://localhost:18789/health
`;

(async () => {
  const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", "instaclaw-vm-725").single();
  if (!vm) { console.error("vm-725 not found"); process.exit(1); }
  const ssh = await connectSSH(vm as any);
  try {
    const r = await ssh.execCommand(PROBE, { execOptions: { pty: false } });
    console.log(r.stdout);
    if (r.stderr) console.log("\nstderr:", r.stderr.slice(0, 400));
  } finally {
    ssh.dispose();
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
