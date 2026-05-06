/**
 * vm-729 follow-up: complete the missing C9-C14 from the first diag.
 * Also: inspect session jsonl for empty-messages-array (root cause of
 * "messages: at least one message is required"); look for trade-execution
 * traces; check Hyperliquid wallet balance via the user's API wallet.
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
echo === D1 process tree ===
ps -ef 2>/dev/null | grep -E 'cron|degenclaw|shot-clock|node|openclaw|dgclaw' | grep -v grep | head -25
echo === D2 acp-serve status ===
systemctl --user is-active acp-serve.service 2>&1
systemctl --user is-failed acp-serve.service 2>&1
echo === D3 ENOENT errors last 24h ===
journalctl --user --since '24 hours ago' --no-pager 2>/dev/null | grep -iE 'ENOENT|no such file' | wc -l
echo D3_SAMPLE:
journalctl --user --since '24 hours ago' --no-pager 2>/dev/null | grep -iE 'ENOENT|no such file' | tail -5
echo === D4 spanish hint ===
journalctl --user -u openclaw-gateway --since '24 hours ago' --no-pager 2>/dev/null | grep -iE 'spanish|hola|que pasa|gracias|por favor|usted' | head -5
echo === D5 sessions.json size + entry count ===
ls -la ~/.openclaw/agents/main/sessions/sessions.json
python3 -c "import json; d=json.load(open('/home/openclaw/.openclaw/agents/main/sessions/sessions.json')); print('entries=' + str(len(d) if isinstance(d, dict) else 0))"
echo === D6 active session jsonl files ===
ls -lat ~/.openclaw/agents/main/sessions/*.trajectory.jsonl 2>/dev/null | head -10
echo === D7 size of latest jsonl ===
LATEST_JSONL=$(ls -t ~/.openclaw/agents/main/sessions/*.trajectory.jsonl 2>/dev/null | head -1)
echo LATEST_JSONL: $LATEST_JSONL
[ -n "$LATEST_JSONL" ] && wc -l "$LATEST_JSONL"
echo === D8 last 3 jsonl entries shape ===
[ -n "$LATEST_JSONL" ] && tail -3 "$LATEST_JSONL" | python3 -c "
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        d = json.loads(line)
        kind = d.get('type', '?')
        role = d.get('message', {}).get('role', '?') if 'message' in d else '?'
        content = d.get('message', {}).get('content', '?') if 'message' in d else d.get('content', '?')
        cstr = str(content)[:80].replace(chr(10), ' ')
        print(f'  type={kind} role={role} content={cstr}')
    except Exception as e:
        print('  PARSE_FAIL: ' + str(e)[:80])
"
echo === D9 dgclaw trade history ===
ls -la /home/openclaw/dgclaw-skill/scripts/ 2>&1 | head -15
echo D9_LOGS:
ls -la /home/openclaw/.openclaw/logs/ 2>/dev/null | grep -iE 'dgclaw|trade|hyper' | head -10
echo D9_DGCLAW_LOGS:
ls -la /home/openclaw/dgclaw-skill/logs 2>/dev/null
echo === D10 auth-profiles.json failureState ===
python3 -c "
import json
try:
    d = json.load(open('/home/openclaw/.openclaw/agents/main/agent/auth-profiles.json'))
    profs = d.get('profiles', {})
    for name, p in profs.items():
        fs = p.get('failureState')
        du = p.get('disabledUntil')
        print(f'{name}: failureState={fs} disabledUntil={du}')
except Exception as e:
    print('PARSE_FAIL: ' + str(e))
"
echo === D11 any 'dgclaw' executions in shell history ===
journalctl --user --since '48 hours ago' --no-pager 2>/dev/null | grep -E 'dgclaw\\.sh|dgclaw-skill/scripts' | tail -10
echo === D12 telegram bot username from openclaw.json ===
python3 -c "
import json
d = json.load(open('/home/openclaw/.openclaw/openclaw.json'))
ch = d.get('channels', {})
tg = ch.get('telegram', {})
print('botUsername=' + str(tg.get('botUsername', '?')))
print('chatId=' + str(tg.get('chatId', '?')))
" 2>/dev/null
`;

(async () => {
  const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", "instaclaw-vm-729").single();
  if (!vm) { console.error("not found"); process.exit(1); }
  const ssh = await connectSSH(vm as any);
  try {
    const r = await ssh.execCommand(PROBE, { execOptions: { pty: false } });
    console.log(r.stdout);
    if (r.stderr) console.log("\nstderr:", r.stderr.slice(0, 500));
  } finally {
    ssh.dispose();
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
