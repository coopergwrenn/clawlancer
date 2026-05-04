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
echo "── data files on vm-780 ──"
for F in sessions events speakers venues; do
  P=~/.openclaw/skills/consensus-2026/data/$F.json
  if [ -f "$P" ]; then
    SZ=$(wc -c < "$P")
    COUNT=$(python3 -c "import json; d=json.load(open('$P')); print(len(d.get('records', [])) if isinstance(d, dict) else len(d))" 2>/dev/null)
    echo "  $F.json: $COUNT records, $SZ bytes"
  else
    echo "  $F.json: MISSING"
  fi
done
echo ""
echo "── SKILL.md head ──"
head -30 ~/.openclaw/skills/consensus-2026/SKILL.md 2>/dev/null
`);
  console.log(out.stdout);
  ssh.dispose();
}
main().catch((e) => console.error("ERR:", e.message));
