/**
 * Re-probe the VMs the emergency sweep marked as restart=FAILED. The original
 * verify loop was too short (36s) for OpenClaw's 60s startup grace. Most are
 * likely up now.
 */
import { readFileSync } from "fs";
import { Client } from "ssh2";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}
const KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const FAILED = [
  "instaclaw-vm-905","instaclaw-vm-435","instaclaw-vm-848","instaclaw-vm-770","instaclaw-vm-046",
  "instaclaw-vm-043","instaclaw-vm-907","instaclaw-vm-777","instaclaw-vm-860","instaclaw-vm-084",
  "instaclaw-vm-902","instaclaw-vm-780","instaclaw-vm-884","instaclaw-vm-910","instaclaw-vm-891",
  "instaclaw-vm-887","instaclaw-vm-838","instaclaw-vm-347","instaclaw-vm-889","instaclaw-vm-879",
  "instaclaw-vm-870","instaclaw-vm-linode-06","instaclaw-vm-576","instaclaw-vm-904","instaclaw-vm-801",
  "instaclaw-vm-773","instaclaw-vm-561","instaclaw-vm-802","instaclaw-vm-837","instaclaw-vm-327",
  "instaclaw-vm-512","instaclaw-vm-894","instaclaw-vm-320","instaclaw-vm-855","instaclaw-vm-804",
  "instaclaw-vm-803","instaclaw-vm-linode-08","instaclaw-vm-852","instaclaw-vm-036","instaclaw-vm-906",
  "instaclaw-vm-890","instaclaw-vm-845","instaclaw-vm-859","instaclaw-vm-603","instaclaw-vm-748",
  "instaclaw-vm-897","instaclaw-vm-771",
];

function exec(host: string, cmd: string, t = 15_000): Promise<string> {
  return new Promise((resolve) => {
    const c = new Client();
    let o = "";
    const tt = setTimeout(() => { try { c.end(); } catch { /* noop */ } resolve("[T]"); }, t);
    c.on("ready", () => c.exec(cmd, (e, s) => {
      if (e) { clearTimeout(tt); c.end(); return resolve("err: " + e.message); }
      s.on("data", (d: Buffer) => { o += d.toString(); });
      s.stderr.on("data", (d: Buffer) => { o += d.toString(); });
      s.on("close", () => { clearTimeout(tt); c.end(); resolve(o); });
    }));
    c.on("error", (e) => { clearTimeout(tt); resolve("cerr: " + e.message); });
    c.connect({ host, port: 22, username: "openclaw", privateKey: KEY, readyTimeout: 8_000 });
  });
}

async function main() {
  const { data: vms } = await sb
    .from("instaclaw_vms")
    .select("name, ip_address")
    .in("name", FAILED);
  if (!vms) { console.error("DB query failed"); process.exit(1); }

  console.log(`Re-probing ${vms.length} VMs (concurrency=10)...\n`);
  let nextIdx = 0;
  const results: Array<{ name: string; active: string; health: string; bootstrap: string }> = [];

  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= vms.length) return;
      const vm = vms[i];
      const out = await exec(vm.ip_address, `
export XDG_RUNTIME_DIR=/run/user/$(id -u)
A=$(systemctl --user is-active openclaw-gateway 2>/dev/null)
H=$(curl -s -m 4 -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null)
B=$(grep -oE 'bootstrapMaxChars": *[0-9]+' ~/.openclaw/openclaw.json 2>/dev/null | grep -oE '[0-9]+' | head -1)
echo "RES|A=$A|H=$H|B=$B"
      `);
      const line = out.split("\n").find((l) => l.startsWith("RES|")) ?? "";
      const parts: Record<string, string> = {};
      for (const p of line.replace(/^RES\|/, "").split("|")) {
        const [k, v] = p.split("=");
        if (k && v !== undefined) parts[k] = v;
      }
      const r = { name: vm.name, active: parts.A ?? "?", health: parts.H ?? "?", bootstrap: parts.B ?? "?" };
      results.push(r);
      const icon = r.active === "active" && r.health === "200" ? "✓" : "✗";
      console.log(`  ${icon} ${vm.name.padEnd(22)} active=${r.active.padEnd(8)} health=${r.health.padEnd(4)} bootstrap=${r.bootstrap}`);
    }
  }
  await Promise.all(Array.from({ length: 10 }, () => worker()));

  const ok = results.filter((r) => r.active === "active" && r.health === "200").length;
  const stillDown = results.filter((r) => !(r.active === "active" && r.health === "200"));
  const bootstrapOk = results.filter((r) => r.bootstrap === "40000").length;

  console.log(`\n=== Summary ===`);
  console.log(`Healthy (active+200):       ${ok}/${results.length}`);
  console.log(`bootstrapMaxChars=40000:    ${bootstrapOk}/${results.length}`);
  console.log(`Still degraded:             ${stillDown.length}`);
  if (stillDown.length > 0) {
    console.log(`\nStill-degraded list:`);
    for (const r of stillDown) console.log(`  ${r.name.padEnd(22)} active=${r.active} health=${r.health} bootstrap=${r.bootstrap}`);
  }
}

main().then(() => process.exit(0));
