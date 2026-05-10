/**
 * Check the lying-DB spread on Phase 1 candidates + a sample of cv>=88 fleet.
 *
 * For each VM: SSH-verify TasksMax + prctl-subreaper actually match what the
 * DB cv claims. Compare against expectations:
 *   - cv >= 86 → TasksMax should be 120
 *   - cv >= 87 → prctl-subreaper@0.1.1 should be installed + drop-in present
 */
import { readFileSync } from "fs";
import { Client } from "ssh2";
import { createClient } from "@supabase/supabase-js";
for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local", "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key"]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const SSH_KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function exec(host: string, cmd: string, t = 20_000): Promise<string> {
  return new Promise((resolve) => {
    const c = new Client(); let o = "";
    const tt = setTimeout(() => { try { c.end(); } catch {} resolve("[timeout]"); }, t);
    c.on("ready", () => c.exec(cmd, (e, s) => {
      if (e) { clearTimeout(tt); c.end(); return resolve("err: " + e.message); }
      s.on("data", (d: Buffer) => o += d.toString());
      s.stderr.on("data", (d: Buffer) => o += d.toString());
      s.on("close", () => { clearTimeout(tt); c.end(); resolve(o); });
    }));
    c.on("error", (e) => { clearTimeout(tt); resolve("conn err: " + e.message); });
    c.connect({ host, port: 22, username: "openclaw", privateKey: SSH_KEY, readyTimeout: 10_000 });
  });
}

(async () => {
  // Get top 8 healthy assigned VMs at cv >= 88 sorted by recent activity
  const cutoff30min = new Date(Date.now() - 30*60*1000).toISOString();
  const { data: vms } = await sb.from("instaclaw_vms")
    .select("name,ip_address,tier,config_version,updated_at,created_at")
    .eq("status","assigned").eq("provider","linode")
    .eq("health_status","healthy").eq("health_fail_count",0)
    .gte("config_version", 88)
    .gt("last_health_check", cutoff30min)
    .order("config_version", { ascending: false })
    .limit(12);

  console.log(`Checking ${vms?.length ?? 0} VMs for lying-DB pattern (cv vs on-disk reality)\n`);

  const probe = `set +e
source ~/.nvm/nvm.sh 2>/dev/null
echo "tasks_max:$(systemctl --user show -p TasksMax --value openclaw-gateway 2>&1)"
echo "openclaw:$(openclaw --version 2>&1 | head -1)"
echo "prctl:$(npm ls -g --depth=0 prctl-subreaper 2>/dev/null | grep -oE 'prctl-subreaper@[0-9]+\\.[0-9]+\\.[0-9]+' || echo MISSING)"
echo "dropin:$(test -f $HOME/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf && echo PRESENT || echo MISSING)"
echo "build_essential:$(which gcc 2>/dev/null && echo PRESENT || echo MISSING)"`;

  const results: any[] = [];
  for (const vm of (vms ?? []) as any[]) {
    process.stdout.write(`  ${vm.name.padEnd(20)} ip=${vm.ip_address.padEnd(15)} cv=${vm.config_version} tier=${vm.tier?.padEnd(8)}... `);
    const out = await exec(vm.ip_address, probe, 15_000);
    const m: Record<string, string> = {};
    for (const line of out.split("\n")) {
      const mm = line.match(/^([a-z_]+):(.*)$/);
      if (mm) m[mm[1]] = mm[2].trim();
    }
    const tasksOk = m.tasks_max === "120";
    const prctlOk = !!m.prctl && !m.prctl.includes("MISSING");
    const dropinOk = m.dropin === "PRESENT";
    const lying = !tasksOk || !prctlOk || !dropinOk;
    process.stdout.write(`${lying ? "❌ LYING-DB" : "✓ honest"}: tasks=${m.tasks_max} prctl=${m.prctl} dropin=${m.dropin}\n`);
    results.push({ vm, m, lying });
  }

  const honest = results.filter(r => !r.lying);
  const lying = results.filter(r => r.lying);
  console.log(`\nSummary: ${honest.length} honest, ${lying.length} lying-DB (out of ${results.length})`);

  if (honest.length > 0) {
    console.log(`\nHonest VMs (eligible Phase 1 candidates):`);
    for (const r of honest) {
      console.log(`  ${r.vm.name.padEnd(20)} ip=${r.vm.ip_address.padEnd(15)} cv=${r.vm.config_version} tier=${r.vm.tier?.padEnd(8)} created=${r.vm.created_at?.slice(0,10)}`);
    }
  }
})();
