import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local","/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key"]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

async function main() {
  const ssh = new NodeSSH();
  await ssh.connect({ host: "104.237.151.95", username: "openclaw", privateKey: sshKey, readyTimeout: 12_000 });
  const out = await ssh.execCommand(String.raw`
echo "── gateway service ──"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user is-active openclaw-gateway 2>&1
curl -s -o /dev/null -w "/health=%{http_code}\n" -m 5 localhost:18789/health

echo ""
echo "── critical configs ──"
python3 -c "
import json
o = json.load(open('/home/openclaw/.openclaw/openclaw.json'))
def g(p):
    cur = o
    for k in p.split('.'):
        cur = cur.get(k, {}) if isinstance(cur, dict) else None
        if cur is None: return None
    return cur
print('agents.defaults.timeoutSeconds       =', g('agents.defaults.timeoutSeconds'))
print('agents.defaults.bootstrapMaxChars    =', g('agents.defaults.bootstrapMaxChars'))
print('agents.defaults.heartbeat.session    =', g('agents.defaults.heartbeat.session'))
print('session.reset.mode                   =', g('session.reset.mode'))
print('session.reset.idleMinutes            =', g('session.reset.idleMinutes'))
"
echo ""
echo "── strip-thinking.py sentinels (6 required) ──"
for S in 'def trim_failed_turns' 'SESSION TRIMMED:' 'def run_periodic_summary_hook' 'PERIODIC_SUMMARY_V1' 'PRE_ARCHIVE_SUMMARY_V1' 'PERIODIC_SUMMARY_V1_RESHRINK'; do
  if grep -q "$S" ~/.openclaw/scripts/strip-thinking.py; then
    echo "  ✓ $S"
  else
    echo "  ✗ MISSING: $S"
  fi
done

echo ""
echo "── consensus-2026 skill ──"
if [ -d ~/.openclaw/skills/consensus-2026 ]; then
  echo "  ✓ skill installed"
  echo "    files: $(ls ~/.openclaw/skills/consensus-2026/ 2>/dev/null | wc -l)"
  if [ -f ~/.openclaw/skills/consensus-2026/SKILL.md ]; then
    echo "    SKILL.md size: $(wc -c < ~/.openclaw/skills/consensus-2026/SKILL.md) bytes"
  fi
  for FILE in sessions.json events.json speakers.json venues.json; do
    F=~/.openclaw/skills/consensus-2026/data/$FILE
    if [ -f "$F" ]; then
      LINES=$(python3 -c "import json; print(len(json.load(open('$F'))))" 2>/dev/null)
      echo "    data/$FILE: $LINES records"
    else
      echo "    data/$FILE: MISSING"
    fi
  done
else
  echo "  ✗ skill NOT installed"
fi

echo ""
echo "── SOUL.md consensus mention ──"
if grep -q -i 'consensus' ~/.openclaw/workspace/SOUL.md; then
  echo "  ✓ SOUL.md mentions consensus"
  grep -i 'consensus' ~/.openclaw/workspace/SOUL.md | head -3
else
  echo "  ✗ no consensus mention in SOUL.md"
fi

echo ""
echo "── recent gateway health (last 5 sendMessage / errors) ──"
journalctl --user -u openclaw-gateway --since '30 minutes ago' --no-pager 2>/dev/null | grep -E 'sendMessage ok|Embedded agent failed|reason=format|reason=timeout' | tail -10

echo ""
echo "── most recent telegram chats (last 24h sendMessage chat IDs) ──"
journalctl --user -u openclaw-gateway --since '24 hours ago' --no-pager 2>/dev/null | grep -oE 'chat=[0-9]+' | sort -u
`);
  console.log(out.stdout);
  if (out.stderr) console.log("[stderr]", out.stderr.slice(0, 500));
  ssh.dispose();
}
main().catch((e) => console.error("ERR:", e.message));
