/**
 * Manually bootstrap vm-308 since cloud-init failed due to libasound2 package issue.
 * Runs the remaining steps: install packages, nvm, node, openclaw, chromium, swap.
 */
import { Client as SSH2Client } from "ssh2";
import { readFileSync } from "fs";
import { resolve } from "path";

for (const f of [".env.ssh-key", ".env.local", ".env.local.full"]) {
  try {
    const c = readFileSync(resolve(__dirname, "..", f), "utf-8");
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

function getPrivateKey(): string {
  return Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
}

function connectSSH(ip: string, username: string): Promise<SSH2Client> {
  return new Promise((resolve, reject) => {
    const conn = new SSH2Client();
    const timer = setTimeout(() => { conn.end(); reject(new Error("timeout")); }, 15000);
    conn.on("ready", () => { clearTimeout(timer); resolve(conn); });
    conn.on("error", (err) => { clearTimeout(timer); reject(err); });
    conn.connect({ host: ip, port: 22, username, privateKey: getPrivateKey(), readyTimeout: 15000 });
  });
}

function exec(conn: SSH2Client, cmd: string, timeoutMs = 300000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Command timeout (${timeoutMs}ms)`)), timeoutMs);
    conn.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      let stdout = "", stderr = "";
      stream.on("close", (code: number) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? 0 }); });
      stream.on("data", (d: Buffer) => { stdout += d.toString(); });
      stream.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    });
  });
}

async function run(conn: SSH2Client, cmd: string, label: string, timeoutMs = 300000) {
  console.log(`  [${label}] Running...`);
  const r = await exec(conn, cmd, timeoutMs);
  console.log(`  [${label}] exit=${r.code}`);
  if (r.stdout.trim()) {
    const lines = r.stdout.trim().split("\n");
    const show = lines.length > 5 ? [...lines.slice(0, 3), `  ... (${lines.length - 5} more lines)`, ...lines.slice(-2)] : lines;
    console.log(`    ${show.join("\n    ")}`);
  }
  if (r.stderr.trim() && r.code !== 0) console.log(`    STDERR: ${r.stderr.trim().slice(0, 300)}`);
  return r;
}

async function main() {
  const IP = "178.156.234.30";
  console.log("=== Bootstrap vm-308 manually ===\n");

  const conn = await connectSSH(IP, "root");

  // Step 1: Install system packages (fix libasound2 -> libasound2t64 for Ubuntu 24.04)
  console.log("--- Step 1: Install system packages ---");
  await run(conn, `export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get install -y -qq fail2ban curl git ffmpeg libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libgbm1 libasound2t64 libpango-1.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxshmfence1 2>&1 | tail -5`, "apt-install", 120000);

  // Step 2: Configure ufw
  console.log("\n--- Step 2: Firewall ---");
  await run(conn, "ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 18789/tcp && ufw --force enable 2>&1", "ufw", 15000);

  // Step 3: Install nvm + Node + OpenClaw as openclaw
  console.log("\n--- Step 3: Install nvm + Node + OpenClaw ---");
  await run(conn, `su - openclaw -c '
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash 2>&1
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    nvm install 22
    nvm alias default 22
    echo "Node: $(node --version)"
    npm install -g openclaw@2026.3.2 mcporter 2>&1 | tail -3
    echo "OpenClaw: $(openclaw --version 2>&1 || echo FAIL)"
  '`, "nvm-node-openclaw", 300000);

  // Step 4: Install Playwright Chromium
  console.log("\n--- Step 4: Install Chromium ---");
  await run(conn, `su - openclaw -c '
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    npx playwright install chromium 2>&1 | tail -5
  '`, "chromium", 120000);

  // Create chromium symlink
  await run(conn, `CHROME_BIN=$(find /home/openclaw/.cache/ms-playwright -name "chrome" -type f 2>/dev/null | grep chrome-linux64/chrome | head -1); if [ -n "$CHROME_BIN" ]; then ln -sf "$CHROME_BIN" /usr/local/bin/chromium-browser; echo "Symlinked: $CHROME_BIN"; else echo "Chrome not found"; fi`, "chromium-symlink");

  // Step 5: Create swap
  console.log("\n--- Step 5: Swap ---");
  await run(conn, `if ! swapon --show | grep -q /swapfile; then fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && grep -q swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab && echo "Swap created"; else echo "Swap exists"; fi`, "swap");

  // Step 6: Set up OpenClaw gateway service
  console.log("\n--- Step 6: Start OpenClaw gateway ---");
  await run(conn, `su - openclaw -c '
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"

    # Start gateway to register the systemd service
    openclaw gateway --port 18789 &
    sleep 10
    pkill -f "openclaw.*gateway" 2>/dev/null || true

    # Check if service was created
    systemctl --user list-units --type=service | grep openclaw || echo "No openclaw service yet"

    # Try restarting
    systemctl --user restart openclaw-gateway 2>&1 || echo "restart failed"
    sleep 5
    systemctl --user is-active openclaw-gateway 2>&1 || echo "not active"

    curl -sf http://localhost:18789/health -o /dev/null -w "%{http_code}" 2>&1 || echo "health fail"
  '`, "gateway-start", 60000);

  conn.end();

  // Step 7: External health check
  console.log("\n--- Step 7: External health check ---");
  await new Promise(r => setTimeout(r, 10000));

  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(`http://${IP}:18789/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        console.log(`  Attempt ${i + 1}: HEALTHY!`);
        return;
      }
      console.log(`  Attempt ${i + 1}: ${res.status}`);
    } catch {
      console.log(`  Attempt ${i + 1}: unreachable`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }

  console.log("  Health still failing, might need more time.");
}

main().catch(console.error);
