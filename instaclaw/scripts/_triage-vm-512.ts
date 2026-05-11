/**
 * vm-512 triage — power-tier paying customer (spillageissue@gmail.com).
 * Census 2026-05-11 found PARTIAL_LIE_DROPIN AND gateway active=failed
 * health=000. Restart the gateway and capture journal context.
 */
import { readFileSync } from "fs";
import { Client } from "ssh2";
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

function exec(host: string, cmd: string, t = 30000): Promise<string> {
  return new Promise((resolve) => {
    const c = new Client();
    let out = "";
    const timer = setTimeout(() => { try { c.end(); } catch { /* noop */ } resolve("[TIMEOUT]"); }, t);
    c.on("ready", () => c.exec(cmd, (e, s) => {
      if (e) { clearTimeout(timer); c.end(); return resolve("err: " + e.message); }
      s.on("data", (d: Buffer) => { out += d.toString(); });
      s.stderr.on("data", (d: Buffer) => { out += d.toString(); });
      s.on("close", () => { clearTimeout(timer); c.end(); resolve(out); });
    }));
    c.on("error", (e) => { clearTimeout(timer); resolve("conn err: " + e.message); });
    c.connect({ host, port: 22, username: "openclaw", privateKey: KEY, readyTimeout: 8000 });
  });
}

const HOST = "96.126.110.86"; // vm-512

async function main() {
  console.log("=== vm-512 triage (spillageissue@gmail.com, power tier) ===\n");

  // Pre-state: capture journal context first
  console.log("--- Pre-restart: gateway state + recent journal ---");
  const pre = await exec(
    HOST,
    `export XDG_RUNTIME_DIR=/run/user/$(id -u)
     systemctl --user status openclaw-gateway --no-pager 2>&1 | head -20
     echo "----"
     systemctl --user show openclaw-gateway -p Result -p ExecMainStatus -p NRestarts -p ExecMainExitTimestamp --no-pager
     echo "----"
     journalctl --user -u openclaw-gateway --no-pager --since '2 hours ago' 2>&1 | tail -30`,
    20000,
  );
  console.log(pre);

  // Restart attempt
  console.log("\n--- Attempting restart ---");
  const restart = await exec(
    HOST,
    `export XDG_RUNTIME_DIR=/run/user/$(id -u)
     systemctl --user reset-failed openclaw-gateway 2>&1 || true
     systemctl --user start openclaw-gateway 2>&1
     sleep 5
     systemctl --user is-active openclaw-gateway`,
    30000,
  );
  console.log(restart);

  // Verify
  console.log("\n--- Post-restart verification ---");
  const post = await exec(
    HOST,
    `export XDG_RUNTIME_DIR=/run/user/$(id -u)
     for i in 1 2 3 4 5 6; do
       active=$(systemctl --user is-active openclaw-gateway)
       health=$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null || echo 000)
       echo "iter $i: active=$active health=$health"
       if [ "$active" = "active" ] && [ "$health" = "200" ]; then break; fi
       sleep 5
     done
     echo "----"
     systemctl --user show openclaw-gateway -p Result -p ExecMainStatus -p NRestarts --no-pager`,
    60000,
  );
  console.log(post);
}

main().then(() => process.exit(0));
