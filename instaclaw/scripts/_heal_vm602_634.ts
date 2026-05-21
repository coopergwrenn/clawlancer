import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { join } from "path";

try {
  for (const f of [
    "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
    "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
  ]) {
    const env = readFileSync(f, "utf-8");
    for (const l of env.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }
} catch {}

const ROOT = "/Users/cooperwrenn/wild-west-bots/instaclaw";
const INSTALL_GBRAIN = readFileSync(join(ROOT, "scripts/install-gbrain.sh"), "utf-8");
const PGLITE_CHECKPOINT = readFileSync(join(ROOT, "scripts/pglite-checkpoint.sh"), "utf-8");
const PATCH = readFileSync(join(ROOT, "scripts/gbrain-patches/0001-add-checkpoint-mcp-tool.patch"), "utf-8");
const VERIFY_MCP = readFileSync(join(ROOT, "scripts/verify-gbrain-mcp.py"), "utf-8");

const TARGETS = [
  { name: "vm-602", ip: "45.79.150.118" },
  { name: "vm-634", ip: "69.164.210.237" },
];

async function healOne(name: string, ip: string): Promise<boolean> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: ip, username: "openclaw",
      privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8"),
      readyTimeout: 12_000,
    });

    console.log(`[${name}] uploading 4 companion files...`);
    const uploads: [string, string, number][] = [
      ["/tmp/install-gbrain.sh", INSTALL_GBRAIN, 0o755],
      ["/tmp/pglite-checkpoint.sh", PGLITE_CHECKPOINT, 0o755],
      ["/tmp/0001-add-checkpoint-mcp-tool.patch", PATCH, 0o644],
      ["/tmp/verify-gbrain-mcp.py", VERIFY_MCP, 0o755],
    ];
    for (const [path, content, mode] of uploads) {
      const r = await ssh.execCommand(
        `cat > ${path} && chmod ${mode.toString(8)} ${path} && wc -c < ${path}`,
        { stdin: content },
      );
      if (r.code !== 0) {
        console.log(`[${name}] ✗ upload ${path} rc=${r.code} ${r.stderr.slice(0, 80)}`);
        ssh.dispose();
        return false;
      }
      console.log(`[${name}]   ${path} ${r.stdout.trim()} bytes`);
    }

    console.log(`[${name}] running install-gbrain.sh...`);
    // Same env vars the reconciler stepGbrain sets when invoking install:
    const envSetup = `export GBRAIN_INSTALL_ENABLED=true; export GBRAIN_PINNED_VERSION=0.36.3.0; export GBRAIN_PINNED_COMMIT=1d5f69f; export GBRAIN_LOG_LEVEL=info;`;
    const run = await ssh.execCommand(
      `${envSetup} bash /tmp/install-gbrain.sh 2>&1`,
      { execOptions: { pty: false } },
    );
    // Last 25 lines of install output, full output if errored
    const lines = run.stdout.split("\n");
    console.log(`[${name}] install rc=${run.code} (last 25 lines):`);
    for (const l of lines.slice(-25)) console.log(`[${name}]   ${l}`);
    if (run.code !== 0) {
      console.log(`[${name}] ✗ install failed — full stderr:`);
      console.log(run.stderr.split("\n").map(l => `[${name}]   ` + l).join("\n"));
      ssh.dispose();
      return false;
    }

    console.log(`[${name}] verify gbrain healthy:`);
    const verify = await ssh.execCommand(`
      systemctl --user is-active gbrain.service
      echo "NRestarts=$(systemctl --user show gbrain.service --property=NRestarts --value)"
      curl -sf -m 3 http://127.0.0.1:3131/health 2>&1
      echo ""
      echo "openclaw.json mcp.servers.gbrain bearer prefix:"
      python3 -c "import json; d=json.load(open('/home/openclaw/.openclaw/openclaw.json')); g=d.get('mcp',{}).get('servers',{}).get('gbrain',{}); print('transport:', g.get('transport')); print('url:', g.get('url')); h=g.get('headers',{}).get('Authorization',''); print('auth_prefix:', h[:20] if h else 'MISSING')"
      echo ""
      echo "checkpoint cron:"
      crontab -l | grep pglite-checkpoint || echo "NO_CRON"
      echo ""
      echo "ExecStop CHECKPOINT hook:"
      systemctl --user show gbrain.service --property=ExecStop --value | head -c 100
    `);
    for (const l of verify.stdout.split("\n")) console.log(`[${name}]   ${l}`);
    ssh.dispose();
    return run.code === 0;
  } catch (e: any) {
    console.log(`[${name}] ✗ ${String(e.message).slice(0, 200)}`);
    try { ssh.dispose(); } catch {}
    return false;
  }
}

async function main() {
  console.log(`Healing ${TARGETS.length} VMs (sequential to avoid races):\n`);
  const results: { name: string; ok: boolean }[] = [];
  for (const t of TARGETS) {
    const ok = await healOne(t.name, t.ip);
    results.push({ name: t.name, ok });
    console.log("");
  }
  console.log("=== SUMMARY ===");
  for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}`);
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
