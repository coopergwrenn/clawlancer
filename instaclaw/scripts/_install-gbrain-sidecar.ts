/**
 * Single-VM installer for the gbrain HTTP sidecar architecture (CLAUDE.md Rule 35).
 *
 * Idempotent. Preserves existing brain.pglite by default — destructive wipe requires --wipe flag.
 *
 * Phases (each with verify gate; auto-rollback if gateway doesn't come back):
 *   1. Baseline — SSH connect, capture state, prerequisites check
 *   2. Install/update gbrain from git (NOT npm — npm "gbrain" is a typosquat)
 *   3. Init PGLite (skip if existing; fresh init if missing or --wipe)
 *   4. Mint bearer token via direct PGLite INSERT (gbrain auth create broken on PGLite)
 *   5. Write systemd user unit
 *   6. Enable + start sidecar; verify port 3131 loopback + /health + MCP handshake
 *   7. Backup + atomically flip openclaw.json (Rules 22, 34)
 *   8. Restart gateway with Rule 5 verify (poll up to 60s) + auto-rollback on failure
 *
 * Usage:
 *   npx tsx scripts/_install-gbrain-sidecar.ts <vm-name-or-ip>            # dry-run
 *   npx tsx scripts/_install-gbrain-sidecar.ts <vm-name-or-ip> --run      # execute
 *   npx tsx scripts/_install-gbrain-sidecar.ts <vm-name-or-ip> --run --wipe  # destructive — only for empty-data VMs
 *
 * Examples:
 *   npx tsx scripts/_install-gbrain-sidecar.ts vm-050              # dry-run vm-050
 *   npx tsx scripts/_install-gbrain-sidecar.ts 172.239.36.76 --run # execute on IP
 *
 * Reference: instaclaw/docs/prd/gbrain-http-sidecar-fleet-rollout.md
 * Rules: CLAUDE.md Rule 5 (verify), 22 (preserve data), 23 (sentinels), 34 (DB↔disk),
 *        35 (sidecar architecture), 47 (manifest/file-push pairing)
 */
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()])
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────
const GBRAIN_REPO = "https://github.com/garrytan/gbrain.git";
const GBRAIN_INSTALL_PATH = "/home/openclaw/.bun/install/global/node_modules/gbrain";
const GBRAIN_HOME = "/home/openclaw/.gbrain";
const GBRAIN_PORT = 3131;
const BEARER_TOKEN_FILE = `${GBRAIN_HOME}/openclaw-bearer-token.txt`;
const SYSTEMD_UNIT_PATH = "/home/openclaw/.config/systemd/user/gbrain.service";
const OPENCLAW_JSON = "/home/openclaw/.openclaw/openclaw.json";
const TOKEN_NAME = "openclaw-vm";
const TS = new Date().toISOString().replace(/[:.]/g, "-");

// Min gbrain version that supports HTTP transport on PGLite (Rule 35)
const MIN_GBRAIN_MAJOR_MINOR = "0.35";

// ── Embedded artifacts ────────────────────────────────────────────────────────
// Direct PGLite INSERT for bearer token — gbrain auth create is broken on PGLite (Issue 1)
const MINT_TOKEN_SCRIPT = `import { PGlite } from '@electric-sql/pglite';
import { createHash, randomBytes } from 'crypto';
import { writeFileSync, chmodSync } from 'fs';

const db = new PGlite('${GBRAIN_HOME}/brain.pglite');
await db.waitReady;
try {
  await db.query(\`DELETE FROM access_tokens WHERE name = $1\`, ['${TOKEN_NAME}']);
  const token = 'gbrain_' + randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  await db.query(\`INSERT INTO access_tokens (name, token_hash) VALUES ($1, $2)\`, ['${TOKEN_NAME}', hash]);
  writeFileSync('${BEARER_TOKEN_FILE}', token, 'utf-8');
  chmodSync('${BEARER_TOKEN_FILE}', 0o600);
  console.log('TOKEN_MINTED ok hash=' + hash);
} finally {
  await db.close();
}
`;

// systemd user unit — secrets injected at install time via Environment= directives
function renderSystemdUnit(openaiKey: string, anthropicKey: string): string {
  return `[Unit]
Description=GBrain MCP HTTP sidecar (persistent, loopback-only)
Documentation=https://github.com/garrytan/gbrain
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=${GBRAIN_INSTALL_PATH}
Environment=PATH=/home/openclaw/.bun/bin:/home/openclaw/.nvm/versions/node/v22.22.2/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/home/openclaw
Environment=OPENAI_API_KEY=${openaiKey}
Environment=ANTHROPIC_API_KEY=${anthropicKey}
Environment=GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large
ExecStart=/home/openclaw/.bun/bin/bun run ${GBRAIN_INSTALL_PATH}/src/cli.ts serve --http --port ${GBRAIN_PORT}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=gbrain
MemoryHigh=2G
MemoryMax=2500M
TasksMax=50
TimeoutStopSec=15
KillSignal=SIGTERM

[Install]
WantedBy=default.target
`;
}

// ── CLI / args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const vmArg = args[0];
const isRun = args.includes("--run");
const isWipe = args.includes("--wipe");

if (!vmArg) {
  console.error(
    "Usage: npx tsx scripts/_install-gbrain-sidecar.ts <vm-name-or-ip> [--run] [--wipe]",
  );
  process.exit(1);
}
if (isWipe && !isRun) {
  console.error("--wipe requires --run (destructive op needs explicit execution)");
  process.exit(1);
}

const DRY_RUN = !isRun;
const WIPE = isWipe;

// ── Logging ───────────────────────────────────────────────────────────────────
const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const banner = (s: string) => console.log(`\n${"=".repeat(64)}\n${s}\n${"=".repeat(64)}`);
const phaseHeader = (n: number, name: string) =>
  console.log(`\n── Phase ${n}: ${name} ${DRY_RUN ? "(DRY-RUN)" : ""}─────────────────────`);
const ok = (m: string) => console.log(`  ✓ ${m}`);
const warn = (m: string) => console.log(`  ⚠ ${m}`);
const err = (m: string) => console.log(`  ✗ ${m}`);

// ── SSH helper ────────────────────────────────────────────────────────────────
type ExecResult = { stdout: string; stderr: string; code: number | null };

async function sshExec(ssh: NodeSSH, cmd: string): Promise<ExecResult> {
  const r = await ssh.execCommand(cmd);
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.code };
}

async function sshExecOrDryRun(
  ssh: NodeSSH,
  cmd: string,
  what: string,
): Promise<ExecResult | null> {
  if (DRY_RUN) {
    console.log(`  [dry-run] would run: ${what}`);
    return null;
  }
  return sshExec(ssh, cmd);
}

// ── VM resolution ─────────────────────────────────────────────────────────────
async function resolveVm(): Promise<{ id?: string; name?: string; ip: string }> {
  // If it looks like an IP, use directly
  if (/^\d+\.\d+\.\d+\.\d+$/.test(vmArg)) {
    return { ip: vmArg };
  }
  // Otherwise look up by name in Supabase
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data, error } = await sb
    .from("instaclaw_vms")
    .select("*")
    .eq("name", vmArg.startsWith("instaclaw-") ? vmArg : `instaclaw-${vmArg}`)
    .single();
  if (error || !data) throw new Error(`VM "${vmArg}" not found: ${error?.message ?? "no row"}`);
  return { id: data.id, name: data.name, ip: data.ip_address };
}

// ── Phase 1: baseline ─────────────────────────────────────────────────────────
async function phase1Baseline(ssh: NodeSSH) {
  phaseHeader(1, "baseline");
  const checks = {
    bunPath: await sshExec(ssh, "ls -la /home/openclaw/.bun/bin/bun 2>&1 | head -1"),
    linger: await sshExec(ssh, "loginctl show-user openclaw 2>&1 | grep -E 'Linger='"),
    gatewayActive: await sshExec(
      ssh,
      "XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active openclaw-gateway",
    ),
    gatewayHealth: await sshExec(
      ssh,
      "curl -sf -o /dev/null -w '%{http_code}' -m 5 localhost:18789/health",
    ),
    port3131: await sshExec(ssh, "ss -lnpt 2>&1 | grep ':3131' || echo 'FREE'"),
    gbrainInstalled: await sshExec(
      ssh,
      `test -d ${GBRAIN_INSTALL_PATH}/.git && echo YES || echo NO`,
    ),
    pgliteExists: await sshExec(
      ssh,
      `test -d ${GBRAIN_HOME}/brain.pglite && echo YES || echo NO`,
    ),
    sidecarUnit: await sshExec(ssh, `test -f ${SYSTEMD_UNIT_PATH} && echo YES || echo NO`),
    diskPct: await sshExec(ssh, "df / | tail -1 | awk '{print $5}' | tr -d '%'"),
  };

  ok(`bun: ${checks.bunPath.stdout.trim()}`);
  ok(`linger: ${checks.linger.stdout.trim()}`);
  ok(`gateway: ${checks.gatewayActive.stdout.trim()}, /health: ${checks.gatewayHealth.stdout.trim()}`);
  ok(`port 3131: ${checks.port3131.stdout.trim()}`);
  ok(`gbrain installed: ${checks.gbrainInstalled.stdout.trim()}`);
  ok(`PGLite exists: ${checks.pgliteExists.stdout.trim()}`);
  ok(`sidecar unit: ${checks.sidecarUnit.stdout.trim()}`);
  ok(`disk: ${checks.diskPct.stdout.trim()}%`);

  // Hard gates
  if (checks.gatewayActive.stdout.trim() !== "active") {
    throw new Error("openclaw-gateway is not active — refuse to install on broken VM");
  }
  if (checks.gatewayHealth.stdout.trim() !== "200") {
    throw new Error("openclaw-gateway /health is not 200 — refuse to install");
  }
  if (!checks.linger.stdout.includes("Linger=yes")) {
    throw new Error("openclaw user linger not enabled — systemd user services won't survive logout");
  }
  const disk = parseInt(checks.diskPct.stdout.trim(), 10);
  if (Number.isFinite(disk) && disk >= 95) {
    throw new Error(`disk ${disk}% — refuse to install (need <95% free)`);
  }
  if (checks.port3131.stdout.includes(":3131") && !checks.sidecarUnit.stdout.includes("YES")) {
    throw new Error("port 3131 is in use by something other than gbrain.service — investigate");
  }

  return {
    gbrainInstalled: checks.gbrainInstalled.stdout.includes("YES"),
    pgliteExists: checks.pgliteExists.stdout.includes("YES"),
    sidecarUnit: checks.sidecarUnit.stdout.includes("YES"),
  };
}

// ── Phase 2: install/update gbrain ────────────────────────────────────────────
async function phase2InstallGbrain(ssh: NodeSSH, alreadyInstalled: boolean) {
  phaseHeader(2, "install/update gbrain");

  if (alreadyInstalled) {
    // Update existing — git pull + bun install
    ok(`gbrain already at ${GBRAIN_INSTALL_PATH} — pulling latest`);
    // First, reset any local modifications (we saw chmod +x mode change on vm-050)
    await sshExecOrDryRun(
      ssh,
      `cd ${GBRAIN_INSTALL_PATH} && git fetch origin master --tags 2>&1 | head -5 && git status --short`,
      "git fetch + status",
    );
    const fetched = await sshExecOrDryRun(
      ssh,
      `cd ${GBRAIN_INSTALL_PATH} && git checkout -- . && git merge --ff-only origin/master 2>&1 | tail -5`,
      "git reset + ff-merge",
    );
    if (fetched) ok(`fetched: ${fetched.stdout.trim().slice(0, 200)}`);

    const installed = await sshExecOrDryRun(
      ssh,
      `cd ${GBRAIN_INSTALL_PATH} && PATH=/home/openclaw/.bun/bin:$PATH bun install 2>&1 | tail -5`,
      "bun install",
    );
    if (installed) ok(`bun install: ${installed.stdout.trim().slice(0, 200)}`);
  } else {
    // Fresh clone
    ok(`cloning ${GBRAIN_REPO} → ${GBRAIN_INSTALL_PATH}`);
    const cloned = await sshExecOrDryRun(
      ssh,
      `mkdir -p $(dirname ${GBRAIN_INSTALL_PATH}) && git clone ${GBRAIN_REPO} ${GBRAIN_INSTALL_PATH} 2>&1 | tail -10`,
      "git clone",
    );
    if (cloned && cloned.code !== 0) throw new Error(`git clone failed: ${cloned.stderr}`);
    if (cloned) ok(`cloned: ${cloned.stdout.trim().slice(0, 200)}`);

    const installed = await sshExecOrDryRun(
      ssh,
      `cd ${GBRAIN_INSTALL_PATH} && PATH=/home/openclaw/.bun/bin:$PATH bun install 2>&1 | tail -10`,
      "bun install",
    );
    if (installed) ok(`bun install: ${installed.stdout.trim().slice(0, 200)}`);

    const linked = await sshExecOrDryRun(
      ssh,
      `cd ${GBRAIN_INSTALL_PATH} && PATH=/home/openclaw/.bun/bin:$PATH bun link 2>&1 | tail -3`,
      "bun link (create binary symlink)",
    );
    if (linked) ok(`bun link: ${linked.stdout.trim().slice(0, 200)}`);
  }

  // Verify version
  const ver = await sshExec(
    ssh,
    `PATH=/home/openclaw/.bun/bin:$PATH timeout 10 gbrain --version 2>&1 | head -1`,
  );
  const verStr = ver.stdout.trim();
  ok(`version: ${verStr}`);
  if (!DRY_RUN && !verStr.includes(MIN_GBRAIN_MAJOR_MINOR)) {
    warn(`gbrain version ${verStr} does not include "${MIN_GBRAIN_MAJOR_MINOR}" — Rule 35 requires v${MIN_GBRAIN_MAJOR_MINOR}+`);
    throw new Error(`gbrain version too old: got ${verStr}, want ${MIN_GBRAIN_MAJOR_MINOR}+`);
  }
}

// ── Phase 3: init or preserve PGLite ──────────────────────────────────────────
async function phase3PGLite(ssh: NodeSSH, pgliteExists: boolean) {
  phaseHeader(3, "PGLite (init or preserve)");

  if (pgliteExists && !WIPE) {
    ok("PGLite exists; preserving (use --wipe to force fresh init)");
    // Verify it's openable + has access_tokens table
    // We can't easily verify schema without taking the PGLite lock, but at least confirm config
    const cfg = await sshExec(ssh, `cat ${GBRAIN_HOME}/config.json 2>&1`);
    ok(`config.json: ${cfg.stdout.trim().slice(0, 200)}`);
    return;
  }

  if (pgliteExists && WIPE) {
    warn("PGLite exists — WIPE flag set, taking backup then deleting");
    const backup = `${GBRAIN_HOME}/brain.pglite.PRE-WIPE-${TS}.tar.gz`;
    const t = await sshExecOrDryRun(
      ssh,
      `tar czf ${backup} -C ${GBRAIN_HOME} brain.pglite 2>&1 && ls -la ${backup}`,
      `tar backup → ${backup}`,
    );
    if (t) ok(`backup: ${t.stdout.trim().slice(0, 150)}`);

    const stop = await sshExecOrDryRun(
      ssh,
      `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user stop gbrain.service 2>&1 || true; sleep 1`,
      "stop sidecar to release PGLite lock",
    );

    const rm = await sshExecOrDryRun(
      ssh,
      `rm -rf ${GBRAIN_HOME}/brain.pglite ${GBRAIN_HOME}/config.json`,
      "rm -rf brain.pglite + config.json",
    );
    if (rm) ok("wiped");
  }

  // Fresh init
  ok("running gbrain init --pglite");
  const init = await sshExecOrDryRun(
    ssh,
    `cd ${GBRAIN_INSTALL_PATH} && unset GBRAIN_DATABASE_URL DATABASE_URL && PATH=/home/openclaw/.bun/bin:/home/openclaw/.nvm/versions/node/v22.22.2/bin:$PATH timeout 120 gbrain init --pglite 2>&1 | tail -15`,
    "gbrain init --pglite",
  );
  if (init) ok(`init: ${init.stdout.trim().slice(0, 400)}`);

  // Verify config.json now exists
  const cfg = await sshExec(ssh, `cat ${GBRAIN_HOME}/config.json 2>&1`);
  ok(`config.json: ${cfg.stdout.trim().slice(0, 200)}`);
  if (!DRY_RUN && !cfg.stdout.includes('"engine"')) {
    throw new Error("config.json did not get created — init failed");
  }
}

// ── Phase 4: mint bearer token ────────────────────────────────────────────────
async function phase4MintToken(ssh: NodeSSH): Promise<string> {
  phaseHeader(4, "mint bearer token (PGLite-direct INSERT)");

  // Sidecar MUST be stopped (PGLite is exclusive-lock)
  await sshExecOrDryRun(
    ssh,
    `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user stop gbrain.service 2>&1 || true; sleep 1`,
    "stop sidecar before token mint",
  );

  // Upload mint script + run
  const remoteScript = `/tmp/_mint-token-${TS}.ts`;
  if (!DRY_RUN) {
    await ssh.execCommand(
      `cat > ${remoteScript} << '__EOF__'\n${MINT_TOKEN_SCRIPT}\n__EOF__\n`,
    );
  } else {
    console.log(`  [dry-run] would upload mint-token.ts to ${remoteScript}`);
  }

  const result = await sshExecOrDryRun(
    ssh,
    `cd ${GBRAIN_INSTALL_PATH} && PATH=/home/openclaw/.bun/bin:$PATH bun run ${remoteScript} 2>&1`,
    "bun run mint-token.ts",
  );
  if (result) {
    ok(`mint: ${result.stdout.trim().slice(0, 200)}`);
    if (!result.stdout.includes("TOKEN_MINTED")) {
      throw new Error("token mint failed — TOKEN_MINTED marker not found in output");
    }
  }

  // Read token (rec'd back to caller for the openclaw.json flip)
  if (DRY_RUN) {
    return "gbrain_DRYRUNDUMMY";
  }
  const tokenRead = await sshExec(ssh, `cat ${BEARER_TOKEN_FILE}`);
  const token = tokenRead.stdout.trim();
  if (!/^gbrain_[a-f0-9]{64}$/.test(token)) {
    throw new Error(`token file has unexpected format: prefix=${token.slice(0, 20)}`);
  }
  ok(`token file mode: $(stat -c %a ${BEARER_TOKEN_FILE})`);
  ok(`token prefix: ${token.slice(0, 14)}...`);

  // Cleanup
  await ssh.execCommand(`rm -f ${remoteScript}`);
  return token;
}

// ── Phase 5: systemd unit ─────────────────────────────────────────────────────
async function phase5SystemdUnit(
  ssh: NodeSSH,
  openaiKey: string,
  anthropicKey: string,
) {
  phaseHeader(5, "systemd user unit");

  const unitContent = renderSystemdUnit(openaiKey, anthropicKey);
  const unitB64 = Buffer.from(unitContent, "utf-8").toString("base64");

  await sshExecOrDryRun(
    ssh,
    `mkdir -p /home/openclaw/.config/systemd/user && echo '${unitB64}' | base64 -d > ${SYSTEMD_UNIT_PATH} && chmod 644 ${SYSTEMD_UNIT_PATH}`,
    `write ${SYSTEMD_UNIT_PATH}`,
  );

  await sshExecOrDryRun(
    ssh,
    `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user daemon-reload`,
    "systemctl daemon-reload",
  );
  await sshExecOrDryRun(
    ssh,
    `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user enable gbrain.service 2>&1`,
    "systemctl enable",
  );
  await sshExecOrDryRun(
    ssh,
    `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user start gbrain.service`,
    "systemctl start",
  );

  if (DRY_RUN) return;

  // Poll up to 30s for active + port bound
  let healthy = false;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const status = await sshExec(
      ssh,
      "XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active gbrain.service",
    );
    const port = await sshExec(
      ssh,
      "ss -lnpt 2>&1 | grep '127.0.0.1:3131' | head -1",
    );
    const health = await sshExec(
      ssh,
      "curl -sf -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1:3131/health",
    );
    console.log(
      `  iter=${i + 1} (t=+${(i + 1) * 5}s) active=${status.stdout.trim()} port_bound=${
        port.stdout.includes(":3131") ? "yes" : "no"
      } health=${health.stdout.trim()}`,
    );
    if (
      status.stdout.trim() === "active" &&
      port.stdout.includes("127.0.0.1:3131") &&
      health.stdout.trim() === "200"
    ) {
      healthy = true;
      break;
    }
  }
  if (!healthy) {
    const journal = await sshExec(
      ssh,
      "XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u gbrain.service -n 30 --no-pager 2>&1 | tail -30",
    );
    console.log(`\n  journal tail:\n${journal.stdout}\n`);
    throw new Error("sidecar did not become healthy within 30s");
  }
  ok("sidecar healthy");

  // External-IP refusal check
  const extIp = await sshExec(ssh, "hostname -I | awk '{print $1}'");
  const ext = await sshExec(
    ssh,
    `timeout 3 bash -c '</dev/tcp/${extIp.stdout.trim()}/3131' 2>&1 && echo OPEN_BAD || echo REFUSED_GOOD`,
  );
  ok(`external ${extIp.stdout.trim()}:3131 → ${ext.stdout.trim()}`);
  if (!ext.stdout.includes("REFUSED")) {
    throw new Error("port 3131 is reachable from external IP — bind is wrong");
  }
}

// ── Phase 6: pre-flip MCP smoke test ──────────────────────────────────────────
async function phase6McpSmoke(ssh: NodeSSH, token: string) {
  phaseHeader(6, "MCP smoke test (initialize + tools/list)");
  if (DRY_RUN) {
    console.log("  [dry-run] would POST /mcp initialize and tools/list");
    return;
  }

  const initPayload =
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"installer","version":"1"}}}';
  const init = await sshExec(
    ssh,
    `curl -sf -m 5 -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'Authorization: Bearer ${token}' -d '${initPayload}' http://127.0.0.1:3131/mcp 2>&1 | head -5`,
  );
  if (!init.stdout.includes('"protocolVersion"')) {
    throw new Error(`MCP initialize failed: ${init.stdout.slice(0, 200)}`);
  }
  ok(`MCP initialize: 200`);

  const toolsPayload = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}';
  const tools = await sshExec(
    ssh,
    `curl -sf -m 5 -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'Authorization: Bearer ${token}' -d '${toolsPayload}' http://127.0.0.1:3131/mcp 2>&1 | grep -oE '"name":"(put_page|get_page|search|recall|query)"' | sort -u`,
  );
  const found = tools.stdout.match(/"name":"(\w+)"/g) || [];
  const want = ["put_page", "get_page", "search", "recall", "query"];
  const missing = want.filter((w) => !found.some((f) => f.includes(`"${w}"`)));
  if (missing.length > 0) {
    throw new Error(`MCP tools/list missing required tools: ${missing.join(", ")}`);
  }
  ok(`MCP tools/list: ${want.length}/${want.length} expected tools present`);
}

// ── Phase 7: backup + flip openclaw.json ──────────────────────────────────────
async function phase7FlipOpenclawJson(ssh: NodeSSH, token: string): Promise<string> {
  phaseHeader(7, "backup + atomically flip openclaw.json");

  const backupPath = `${OPENCLAW_JSON}.pre-http-sidecar-flip-${TS}.bak`;

  await sshExecOrDryRun(
    ssh,
    `cp -p ${OPENCLAW_JSON} ${backupPath} && cp -p ${OPENCLAW_JSON} ${OPENCLAW_JSON}.last-known-good`,
    `backup → ${backupPath} + last-known-good`,
  );

  const tmpPath = `/tmp/openclaw.json.new-${TS}`;
  await sshExecOrDryRun(
    ssh,
    `jq --arg auth "Bearer ${token}" '.mcp.servers.gbrain = {"transport":"streamable-http","url":"http://127.0.0.1:${GBRAIN_PORT}/mcp","headers":{"Authorization":$auth},"connectionTimeoutMs":5000}' ${OPENCLAW_JSON} > ${tmpPath} && jq empty ${tmpPath}`,
    "jq atomic-edit + validate",
  );

  await sshExecOrDryRun(
    ssh,
    `mv ${tmpPath} ${OPENCLAW_JSON} && chmod 600 ${OPENCLAW_JSON}`,
    "atomic mv into place",
  );

  if (!DRY_RUN) {
    const verify = await sshExec(
      ssh,
      `jq -r '.mcp.servers.gbrain.transport' ${OPENCLAW_JSON}`,
    );
    if (verify.stdout.trim() !== "streamable-http") {
      throw new Error(`openclaw.json verify failed: transport=${verify.stdout.trim()}`);
    }
    ok(`openclaw.json transport: streamable-http`);
  }
  return backupPath;
}

// ── Phase 8: restart gateway + Rule 5 verify ──────────────────────────────────
async function phase8RestartGateway(ssh: NodeSSH, backupPath: string) {
  phaseHeader(8, "restart gateway + Rule 5 verify (60s poll, auto-rollback)");

  if (DRY_RUN) {
    console.log("  [dry-run] would restart gateway + poll 60s");
    return;
  }

  const preTs = Math.floor(Date.now() / 1000);

  await sshExec(
    ssh,
    "XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart openclaw-gateway",
  );

  let healthy = false;
  for (let i = 0; i < 18; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const status = await sshExec(
      ssh,
      "XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active openclaw-gateway",
    );
    const health = await sshExec(
      ssh,
      "curl -sf -o /dev/null -w '%{http_code}' -m 3 localhost:18789/health",
    );
    console.log(
      `  iter=${i + 1} (t=+${(i + 1) * 5}s) status=${status.stdout.trim()} http=${health.stdout.trim()}`,
    );
    if (status.stdout.trim() === "active" && health.stdout.trim() === "200") {
      healthy = true;
      break;
    }
  }

  if (!healthy) {
    err("gateway did not become healthy within 90s — ROLLING BACK");
    await ssh.execCommand(`cp -p ${backupPath} ${OPENCLAW_JSON}`);
    await ssh.execCommand(
      "XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart openclaw-gateway",
    );
    await new Promise((r) => setTimeout(r, 10000));
    throw new Error("gateway unhealthy after flip — rolled back; check journal");
  }

  // Rule 34 — check journal for GATEWAY_ROLLBACK_TRIGGERED
  const rollback = await sshExec(
    ssh,
    `XDG_RUNTIME_DIR=/run/user/$(id -u) journalctl --user -u openclaw-gateway --since "@${preTs}" --no-pager 2>&1 | grep -E "GATEWAY_ROLLBACK_TRIGGERED" | head -3`,
  );
  if (rollback.stdout.trim()) {
    err(`GATEWAY_ROLLBACK_TRIGGERED detected — config rollback fired on disk despite our flip`);
    console.log(rollback.stdout);
    throw new Error("Rule 34 violation: gateway rolled back our config silently");
  }
  ok("gateway active + /health=200, no rollback triggered");
}

// ── Final report ──────────────────────────────────────────────────────────────
async function finalReport(
  ssh: NodeSSH,
  vm: { ip: string; name?: string },
  token: string,
) {
  banner("FINAL STATE");
  if (DRY_RUN) {
    console.log("(dry-run — no final state to inspect)");
    return;
  }
  const r = {
    gatewayActive: (await sshExec(ssh, "XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active openclaw-gateway")).stdout.trim(),
    gatewayHealth: (await sshExec(ssh, "curl -sf -o /dev/null -w '%{http_code}' -m 3 localhost:18789/health")).stdout.trim(),
    sidecarActive: (await sshExec(ssh, "XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user is-active gbrain.service")).stdout.trim(),
    sidecarPid: (await sshExec(ssh, "XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user show gbrain.service --property=MainPID --value")).stdout.trim(),
    port: (await sshExec(ssh, "ss -lnpt 2>&1 | grep ':3131' | head -1")).stdout.trim(),
    transport: (await sshExec(ssh, `jq -r '.mcp.servers.gbrain.transport' ${OPENCLAW_JSON}`)).stdout.trim(),
    // Query via sidecar's HTTP MCP — PGLite is exclusive-locked by the sidecar
    pageList: (await sshExec(
      ssh,
      `curl -sf -m 5 -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'Authorization: Bearer ${token}' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_pages","arguments":{"limit":50}}}' http://127.0.0.1:3131/mcp 2>&1 | head -1`,
    )).stdout.trim(),
  };
  console.log(`vm:              ${vm.name ?? vm.ip}`);
  console.log(`gateway:         ${r.gatewayActive}  /health=${r.gatewayHealth}`);
  console.log(`gbrain sidecar:  ${r.sidecarActive}  PID=${r.sidecarPid}`);
  console.log(`port 3131:       ${r.port}`);
  console.log(`mcp transport:   ${r.transport}`);
  // Count pages from list_pages response (count occurrences of "slug": in JSON)
  const slugCount = (r.pageList.match(/"slug":/g) || []).length;
  console.log(`gbrain pages:    ${slugCount}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  banner(`gbrain HTTP sidecar installer — vm=${vmArg} ${DRY_RUN ? "(DRY-RUN)" : "(EXECUTING)"} ${WIPE ? "WIPE=true" : ""}`);

  const vm = await resolveVm();
  console.log(`Target: name=${vm.name ?? "n/a"} ip=${vm.ip}`);

  const ssh = new NodeSSH();
  await ssh.connect({
    host: vm.ip,
    username: "openclaw",
    privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8"),
    readyTimeout: 15000,
  });

  try {
    // Pull secrets needed for the systemd unit. Two sources, in order:
    //   (1) openclaw.json mcp.servers.gbrain.env (stdio-shape — pre-migration VMs)
    //   (2) Existing systemd unit's Environment= directives (post-migration VMs being re-run)
    // Either path produces sk-prefixed keys; fail loudly if neither has them.
    const pullSecret = async (jqPath: string, envKey: string): Promise<string> => {
      const fromJson = (await sshExec(ssh, `jq -r '${jqPath} // ""' ${OPENCLAW_JSON}`)).stdout.trim();
      if (fromJson.startsWith("sk-")) return fromJson;
      const fromUnit = (
        await sshExec(
          ssh,
          `grep -E '^Environment=${envKey}=' ${SYSTEMD_UNIT_PATH} 2>/dev/null | head -1 | sed 's|^Environment=${envKey}=||'`,
        )
      ).stdout.trim();
      if (fromUnit.startsWith("sk-")) return fromUnit;
      throw new Error(
        `could not find ${envKey} in either openclaw.json (${jqPath}) or ${SYSTEMD_UNIT_PATH}`,
      );
    };

    const openaiKey = await pullSecret(".mcp.servers.gbrain.env.OPENAI_API_KEY", "OPENAI_API_KEY");
    const anthropicKey = await pullSecret(
      ".mcp.servers.gbrain.env.ANTHROPIC_API_KEY",
      "ANTHROPIC_API_KEY",
    );

    const baseline = await phase1Baseline(ssh);
    await phase2InstallGbrain(ssh, baseline.gbrainInstalled);
    await phase3PGLite(ssh, baseline.pgliteExists);
    const token = await phase4MintToken(ssh);
    await phase5SystemdUnit(ssh, openaiKey, anthropicKey);
    await phase6McpSmoke(ssh, token);
    const backupPath = await phase7FlipOpenclawJson(ssh, token);
    await phase8RestartGateway(ssh, backupPath);
    await finalReport(ssh, vm, token);
    banner(`SUCCESS — vm ${vm.name ?? vm.ip} now on gbrain HTTP sidecar architecture`);
  } catch (e: any) {
    banner(`FAILED — ${e?.message ?? String(e)}`);
    console.error(e?.stack ?? e);
    process.exit(2);
  } finally {
    ssh.dispose();
  }
}

main();
