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
  await ssh.connect({ host: "104.237.151.95", username: "openclaw", privateKey: sshKey, readyTimeout: 10000 });
  const out = await ssh.execCommand(String.raw`
source ~/.nvm/nvm.sh
NPMROOT=$(npm root -g 2>/dev/null)

echo "── full openclaw config list (looking for retry/recover/incomplete/empty) ──"
openclaw config list 2>/dev/null | grep -iE 'retry|recover|incomplete|empty|continuation|reasoning' | head -30
echo ""
echo "── grep maxEmpty in dist/* with full path ──"
grep -rl 'maxEmptyResponseRetryAttempts' "$NPMROOT/openclaw/dist/" 2>/dev/null | while read f; do
  echo "in: $f"
  grep -nE 'maxEmptyResponseRetryAttempts|maxReasoningOnlyRetryAttempts' "$f" | head -10
done

echo ""
echo "── show 200-byte slice around the constant ──"
F="$NPMROOT/openclaw/dist/pi-embedded-aAN5CWPb.js"
if [ -f "$F" ]; then
  python3 -c "
content = open('$F').read()
for needle in ['maxEmptyResponseRetryAttempts', 'maxReasoningOnlyRetryAttempts']:
    idx = content.find(needle)
    if idx > 0:
        print('── ' + needle + ' first occurrence context ──')
        print(content[max(0,idx-200):idx+400])
        print()
"
fi
`);
  console.log(out.stdout);
  if (out.stderr) console.log("[stderr]", out.stderr.slice(0, 500));
  ssh.dispose();
}
main().catch((e) => console.error("ERR:", e.message));
