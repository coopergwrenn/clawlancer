/**
 * Test: Does PARTNER_ID actually reach process.env when the agent runs commands?
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

  // 1. Does .bashrc have it?
  await run("1. .bashrc content", "grep PARTNER_ID ~/.bashrc");

  // 2. Does sourcing .bashrc make it available?
  await run("2. source .bashrc", "source ~/.bashrc 2>/dev/null && echo PARTNER_ID=$PARTNER_ID");

  // 3. What does the gateway systemd unit look like?
  await run("3. Gateway systemd Environment",
    'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user show openclaw-gateway | grep -i environment');

  // 4. What does the gateway PROCESS actually have?
  await run("4. Gateway process env (PARTNER_ID)",
    'PID=$(pgrep -f "openclaw-gateway" | head -1) && cat /proc/$PID/environ 2>/dev/null | tr "\\0" "\\n" | grep PARTNER_ID || echo "NOT_IN_GATEWAY_PROCESS_ENV"');

  // 5. What does acp-serve process have?
  await run("5. acp-serve process env (PARTNER_ID)",
    'PID=$(pgrep -f "acp serve" | head -1) && cat /proc/$PID/environ 2>/dev/null | tr "\\0" "\\n" | grep PARTNER_ID || echo "NO_ACP_SERVE_RUNNING_OR_NO_PARTNER"');

  // 6. How does OpenClaw execute bash commands? Test with a simple env dump
  await run("6. Gateway systemd override dir",
    'ls -la ~/.config/systemd/user/openclaw-gateway.service.d/ 2>/dev/null || echo "NO_OVERRIDE_DIR"');

  await run("6b. Gateway unit file",
    'cat ~/.config/systemd/user/openclaw-gateway.service 2>/dev/null || systemctl --user cat openclaw-gateway 2>/dev/null | head -30');

  // 7. Check if acp-serve wrapper has PARTNER_ID
  await run("7. acp-serve.sh content",
    'cat ~/virtuals-protocol-acp/acp-serve.sh 2>/dev/null || echo "NO_ACP"');

  // 8. Check the .env in virtuals-protocol-acp
  await run("8. ACP .env PARTNER_ID",
    'grep PARTNER_ID ~/virtuals-protocol-acp/.env 2>/dev/null || echo "NO_ACP_ENV"');

  // 9. CRITICAL TEST: When the agent runs `npx acp ...`, does it get PARTNER_ID?
  // The agent tool spawns bash. Test what env a child of the gateway sees:
  await run("9. Child process of gateway env test",
    'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && node -e "console.log(\'PARTNER_ID=\' + (process.env.PARTNER_ID || \'UNDEFINED\'))"');

  // 10. What about if we source .bashrc first (like OpenClaw might do)?
  await run("10. With bashrc sourced + node",
    'source ~/.bashrc 2>/dev/null && export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && node -e "console.log(\'PARTNER_ID=\' + (process.env.PARTNER_ID || \'UNDEFINED\'))"');

  // 11. What does the ACP CLI dotenv load?
  await run("11. ACP dotenv test",
    'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && cd ~/virtuals-protocol-acp && node -e "require(\'dotenv\').config(); console.log(\'PARTNER_ID=\' + (process.env.PARTNER_ID || \'UNDEFINED\'))" 2>/dev/null || echo "DOTENV_TEST_FAILED"');

  ssh.dispose();
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
