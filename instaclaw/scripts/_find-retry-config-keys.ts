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
NPMROOT=$(npm root -g 2>/dev/null)
DIST="$NPMROOT/openclaw/dist"

echo "── search for maxEmptyResponseRetryAttempts assignment / config ──"
grep -rE 'maxEmptyResponseRetryAttempts|maxReasoningOnlyRetryAttempts' "$DIST" 2>/dev/null | head -10
echo ""
echo "── try to find where defaults are set ──"
grep -rE 'maxEmptyResponseRetryAttempts\s*[=:]\s*[0-9]|maxReasoningOnlyRetryAttempts\s*[=:]\s*[0-9]' "$DIST" 2>/dev/null | head -10
echo ""
echo "── search the file we found for surrounding 50 lines of the retry pattern ──"
F=$(grep -lr 'maxEmptyResponseRetryAttempts' "$DIST" 2>/dev/null | head -1)
echo "file: $F"
if [ -n "$F" ]; then
  echo ""
  echo "── 30 lines around 'maxEmptyResponseRetryAttempts' first occurrence ──"
  grep -n 'maxEmptyResponseRetryAttempts' "$F" | head -3
  echo ""
  N=$(grep -n 'maxEmptyResponseRetryAttempts' "$F" | head -1 | cut -d: -f1)
  if [ -n "$N" ]; then
    START=$((N - 15))
    END=$((N + 15))
    sed -n "$START,$END p" "$F"
  fi
fi
echo ""
echo "── try common config key paths ──"
source ~/.nvm/nvm.sh
for KEY in agents.defaults.maxEmptyResponseRetryAttempts agents.defaults.maxReasoningOnlyRetryAttempts agents.defaults.emptyResponseRetries agent.embedded.maxEmptyResponseRetryAttempts emptyResponseRetryAttempts; do
  echo "── trying: $KEY ──"
  openclaw config get "$KEY" 2>&1 | head -3
done
`);
  console.log(out.stdout);
  if (out.stderr) console.log("[stderr]", out.stderr.slice(0, 500));
  ssh.dispose();
}
main().catch((e) => console.error("ERR:", e.message));
