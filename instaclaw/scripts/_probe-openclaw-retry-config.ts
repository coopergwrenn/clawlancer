/**
 * Find the OpenClaw config key (if any) for empty-response retry budget.
 * Probes vm-725 with explicit NVM-resolved path. Tries:
 *   1. `openclaw config list | grep -i (empty|retry|attempt|recovery|fallback)`
 *   2. `openclaw config get` for likely keys
 *   3. Walks ~/.openclaw/openclaw.json + node_modules openclaw schema if present
 *   4. Greps OpenClaw dist for "retries exhausted" string to find the source-level constant
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
OPENCLAW=$(ls /home/openclaw/.nvm/versions/node/*/bin/openclaw 2>/dev/null | head -1)
echo OPENCLAW_PATH: $OPENCLAW

echo === FULL CONFIG LIST KEYS COUNT ===
$OPENCLAW config list 2>/dev/null | wc -l

echo === ALL agents.defaults.* KEYS ===
$OPENCLAW config list 2>/dev/null | grep -E '^agents\\.defaults\\.' | head -50

echo === KEYS MATCHING empty OR retry OR attempt OR recovery ===
$OPENCLAW config list 2>/dev/null | grep -iE 'empty|retry|attempt|recovery' | head -40

echo === KEYS MATCHING fallback ===
$OPENCLAW config list 2>/dev/null | grep -iE 'fallback' | head -20

echo === GREP openclaw dist for retries exhausted source const ===
NODE_PATH=$(dirname $OPENCLAW)/../lib/node_modules/openclaw
echo NODE_PATH: $NODE_PATH
test -d $NODE_PATH && find $NODE_PATH -name "*.js" 2>/dev/null | xargs grep -l "retries exhausted" 2>/dev/null | head -3

echo === SOURCE CONTEXT around retries-exhausted ===
test -d $NODE_PATH && find $NODE_PATH -name "*.js" 2>/dev/null | xargs grep -B2 -A4 "retries exhausted" 2>/dev/null | head -40

echo === SEARCH dist for emptyResponse / EMPTY_RESPONSE / maxRetries const ===
test -d $NODE_PATH && grep -rn "EMPTY_RESPONSE\\|emptyResponse\\|maxRetries\\|emptyRetries" $NODE_PATH/dist 2>/dev/null | head -20
`;

(async () => {
  const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", "instaclaw-vm-725").single();
  if (!vm) { console.error("vm-725 not found"); process.exit(1); }
  const ssh = await connectSSH(vm as any);
  try {
    const r = await ssh.execCommand(PROBE, { execOptions: { pty: false } });
    console.log(r.stdout);
    if (r.stderr) console.log("\nstderr:", r.stderr.slice(0, 500));
  } finally {
    ssh.dispose();
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
