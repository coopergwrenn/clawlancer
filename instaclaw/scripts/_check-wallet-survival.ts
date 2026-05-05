/**
 * Phase 5 follow-up: verify whether vm-321 (Franky) and vm-729 (Notboredclaw)
 * still have intact ACP master wallet at $HOME/agdp/config.json after my
 * sibling-clone repair (which rm -rf'd ~/dgclaw-skill including its private.pem).
 *
 * The HYPOTHESIS is: $HOME/agdp/config.json is the master wallet (untouched
 * by the rm), and ~/dgclaw-skill/private.pem was an API sub-wallet (lost,
 * but regenerable by the agent via add-api-wallet.ts).
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
echo === MASTER WALLET at HOME/agdp/config.json ===
ls -la ~/agdp/config.json 2>&1 | head -3
python3 -c "
import json, sys
try:
    d = json.load(open('/home/openclaw/agdp/config.json'))
    print('walletAddress=' + str(d.get('walletAddress', 'MISSING')))
    print('has_LITE_AGENT_API_KEY=' + ('YES' if d.get('LITE_AGENT_API_KEY') else 'NO'))
    print('keys_in_config=' + ','.join(d.keys()))
except Exception as e:
    print('PARSE_ERROR: ' + str(e))
" 2>&1
echo === API WALLET at HOME/dgclaw-skill ===
ls -la ~/dgclaw-skill/private.pem ~/dgclaw-skill/public.pem ~/dgclaw-skill/.env 2>&1 | head -5
echo === acp-serve.service status ===
systemctl --user is-active acp-serve.service 2>&1
systemctl --user is-failed acp-serve.service 2>&1
echo === recent acp-serve journal (last 5) ===
journalctl --user -u acp-serve.service -n 5 --no-pager 2>/dev/null | tail -5
`;

(async () => {
  for (const name of ["instaclaw-vm-321", "instaclaw-vm-729"]) {
    const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", name).single();
    if (!vm) { console.log(`${name}: NOT FOUND in DB`); continue; }
    console.log(`\n══ ${name} (${vm.ip_address}) ══`);
    const ssh = await connectSSH(vm as any);
    try {
      const r = await ssh.execCommand(PROBE, { execOptions: { pty: false } });
      console.log(r.stdout);
      if (r.stderr) console.log("stderr:", r.stderr.slice(0, 300));
    } finally {
      ssh.dispose();
    }
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
