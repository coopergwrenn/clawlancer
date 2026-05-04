import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";

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
const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

async function main() {
  const ssh = new NodeSSH();
  await ssh.connect({ host: "104.237.151.95", username: "openclaw", privateKey: sshKey, readyTimeout: 10000 });
  const out = await ssh.execCommand(String.raw`
source ~/.nvm/nvm.sh
echo "── all openclaw config keys mentioning 'continuation' or 'retry' or 'visibleAnswer' or 'recover' ──"
openclaw config list 2>/dev/null | grep -iE 'continuation|retry|visible|recover|empty.*response|incomplete' | head -30
echo ""
echo "── full openclaw.json (just keys with timeouts and continuation/retry) ──"
cat ~/.openclaw/openclaw.json | python3 -c '
import json, sys
o = json.load(sys.stdin)
def walk(d, prefix=""):
    if isinstance(d, dict):
        for k, v in d.items():
            kp = f"{prefix}.{k}" if prefix else k
            if isinstance(v, (dict, list)):
                walk(v, kp)
            else:
                if any(s in kp.lower() for s in ["timeout", "continuation", "retry", "visible", "recover", "incomplete", "empty"]):
                    print(f"  {kp} = {v}")
walk(o)
' 2>/dev/null

echo ""
echo "── search openclaw source for visible-answer retry count ──"
find ~/.nvm/versions/node -name "*.js" -path "*openclaw*" 2>/dev/null | head -5 | while read f; do
  grep -l 'visible-answer continuation\|empty response retries\|emptyResponseRetries\|continuationRetries' "$f" 2>/dev/null
done | head -3
echo ""
echo "── grep for the exact retry-count pattern ──"
NPMROOT=$(npm root -g 2>/dev/null)
grep -rE 'attempts=1/1|emptyResponseRetries|continuationRetries|visible-answer' "$NPMROOT/openclaw/dist" 2>/dev/null | head -10
`);
  console.log(out.stdout);
  if (out.stderr) console.log("[stderr]", out.stderr.slice(0, 500));
  ssh.dispose();
}
main().catch((e) => console.error("ERR:", e.message));
