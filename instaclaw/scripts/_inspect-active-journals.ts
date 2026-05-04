import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
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
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

const targetVMs = ["instaclaw-vm-748", "instaclaw-vm-867", "instaclaw-vm-855", "instaclaw-vm-725"];

async function main() {
  const { data, error } = await sb.from("instaclaw_vms")
    .select("name, ip_address, ssh_user")
    .in("name", targetVMs);

  if (error) { console.log("ERROR:", error.message); return; }
  if (!data || data.length === 0) { console.log("no data"); return; }
  console.log(`found ${data.length} VMs`);

  const inspectScript = String.raw`
LOG=/tmp/oc-24h.log
journalctl --user -u openclaw-gateway --since '24 hours ago' --no-pager 2>/dev/null > $LOG

echo "── total events: $(wc -l < $LOG) ──"
echo ""
echo "── sample 'sendMessage ok' lines (3) ──"
grep 'sendMessage ok' $LOG | head -3
echo ""
echo "── sample 'candidate_failed' lines (3) ──"
grep 'candidate_failed' $LOG | head -3
echo ""
echo "── sample 'candidate_succeeded' lines (3) ──"
grep 'candidate_succeeded' $LOG | head -3
echo ""
echo "── any other candidate/model-select events (10) ──"
grep -iE 'candidate|fallback|model.*select|model_id|chosen' $LOG | grep -v 'candidate_failed\|candidate_succeeded' | head -10
echo ""
echo "── grouped counts ──"
echo "sendMessage ok            = $(grep -c 'sendMessage ok' $LOG)"
echo "Embedded agent failed     = $(grep -c 'Embedded agent failed before reply' $LOG)"
echo "candidate_failed sonnet   = $(grep -E 'candidate_failed.*claude-sonnet-4-6' $LOG | wc -l)"
echo "candidate_succeeded sonnet= $(grep -E 'candidate_succeeded.*claude-sonnet-4-6' $LOG | wc -l)"
echo "candidate_failed haiku    = $(grep -E 'candidate_failed.*claude-haiku' $LOG | wc -l)"
echo "candidate_succeeded haiku = $(grep -E 'candidate_succeeded.*claude-haiku' $LOG | wc -l)"
echo "agent run completed       = $(grep -ciE 'agent run completed|agent.*completed|run finished' $LOG)"
echo "embedded run start        = $(grep -ciE 'embedded.*run.*start|embedded.*started' $LOG)"
echo "model_id= occurrences     = $(grep -c 'model_id=' $LOG)"
rm -f $LOG
`;

  for (const v of data as { name: string; ip_address: string; ssh_user: string }[]) {
    if (!v.ip_address) continue;
    console.log(`\n══════ ${v.name}  (${v.ip_address}) ══════`);
    const ssh = new NodeSSH();
    try {
      await ssh.connect({ host: v.ip_address, username: v.ssh_user || "openclaw", privateKey: sshKey, readyTimeout: 10_000 });
      const out = await ssh.execCommand(inspectScript);
      console.log(out.stdout);
      if (out.stderr) console.log("[stderr]", out.stderr.slice(0, 500));
    } catch (e) {
      console.log("ERR:", (e as Error).message);
    } finally {
      try { ssh.dispose(); } catch {}
    }
  }
}

main().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });
