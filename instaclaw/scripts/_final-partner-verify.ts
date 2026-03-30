/**
 * Final verification: PARTNER_ID in gateway process.env on vm-050
 */
import { readFileSync } from "fs";
import { resolve } from "path";

for (const f of [".env.ssh-key", ".env.local", ".env.local.full"]) {
  try {
    const c = readFileSync(resolve(".", f), "utf-8");
    for (const l of c.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m) {
        const k = m[1].trim();
        const v = m[2].trim().replace(/^["']|["']$/g, "");
        if (!process.env[k]) process.env[k] = v;
      }
    }
  } catch {}
}

import { connectSSH } from "../lib/ssh";

const VM = { id: "vm-050", name: "instaclaw-vm-050", ip_address: "172.239.36.76", ssh_port: 22, ssh_user: "openclaw" };

async function main() {
  const ssh = await connectSSH(VM);

  const run = async (label: string, cmd: string) => {
    console.log(`\n=== ${label} ===`);
    const r = await ssh.execCommand(cmd);
    if (r.stdout?.trim()) console.log(r.stdout.trim());
    if (r.stderr?.trim()) console.log("STDERR:", r.stderr.trim());
  };

  // THE critical test: is PARTNER_ID in the gateway's actual process environment?
  await run("1. Gateway process PARTNER_ID",
    'PID=$(pgrep -f "openclaw-gateway" | head -1) && echo "Gateway PID: $PID" && cat /proc/$PID/environ 2>/dev/null | tr "\\0" "\\n" | grep PARTNER_ID || echo "NOT_IN_PROCESS_ENV"');

  // Does the override have it?
  await run("2. Systemd override",
    'grep PARTNER_ID ~/.config/systemd/user/openclaw-gateway.service.d/override.conf 2>/dev/null || echo "NOT_IN_OVERRIDE"');

  // Does a Node.js child process see it?
  await run("3. Node.js child process test",
    'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && node -e "console.log(\'PARTNER_ID=\' + (process.env.PARTNER_ID || \'UNDEFINED\'))"');

  // Simulate what happens when agent runs acp token launch
  await run("4. Simulated acp token launch env",
    'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && cd ~/virtuals-protocol-acp && node -e "require(\'dotenv\').config(); console.log(\'PARTNER_ID=\' + process.env.PARTNER_ID)" 2>/dev/null || echo "DOTENV_FAILED"');

  // ACP .env file
  await run("5. ACP .env",
    'grep PARTNER ~/virtuals-protocol-acp/.env 2>/dev/null || echo "NO_ACP"');

  // Gateway health
  await run("6. Gateway health",
    'curl -s -m 5 -o /dev/null -w "health=%{http_code}" http://localhost:18789/health');

  ssh.dispose();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
