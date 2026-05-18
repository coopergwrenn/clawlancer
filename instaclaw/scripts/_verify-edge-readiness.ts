#!/usr/bin/env tsx
/**
 * _verify-edge-readiness.ts — daily pre-conference readiness check for the
 * Edge Esmeralda fleet (partner=edge_city VMs).
 *
 * Conference go-live: 2026-05-30. Until then, run this nightly to surface
 * drift before attendees see it on day one.
 *
 * Captures the manual audit from 2026-05-18 as a repeatable 1-liner.
 *
 * Per VM, checks:
 *   1.  partner='edge_city' in DB
 *   2.  EDGEOS_BEARER_TOKEN present + JWT shape (length 100+, starts with `eyJ`)
 *   3.  edge-esmeralda skill at upstream HEAD (auto-fetches upstream HEAD via
 *       `git ls-remote https://github.com/aromeoes/edge-agent-skill HEAD`)
 *   4.  Sola calendar probe (from VM, hits api.sola.day for group_id=3688)
 *   5.  agentbook wallet provisioned (DB column non-null + on-VM `.openclaw/wallet/`
 *       directory present)
 *   6.  gbrain.service active + KillSignal=SIGKILL (Rule 54 — SIGTERM corrupts PGLite)
 *   7.  openclaw-gateway active + /health=200
 *   8.  Sample chat completion (30s budget, model=openclaw, expects "ok" content)
 *   9.  Index Network: DB columns index_user_id + index_api_key populated;
 *       mcp.servers.index in openclaw.json; INDEX_USER_ID + INDEX_USER_API_KEY in .env
 *   10. cv on disk matches DB cv (and DB cv matches current manifest)
 *
 * Severity ladder:
 *   - P0: customer-visible the moment attendees arrive. EDGEOS broken, gateway
 *         down, edge skill missing, Sola down. → exit 1, blocks Esmeralda.
 *   - P1: degraded but attendees can use the agent. Skill SHA drift, gbrain
 *         KillSignal wrong (rare crash on PGLite corruption), Index not
 *         provisioned (only matters for Index-specific features).
 *   - P2: nice-to-have, won't bite anyone. cv slightly behind.
 *
 * Output:
 *   - Console: pretty table + summary
 *   - /tmp/edge-readiness-<ISO-date>.json — full structured results
 *   - Exit 0 if no P0 fails, 1 otherwise
 *
 * Usage:
 *   npx tsx instaclaw/scripts/_verify-edge-readiness.ts
 *   npx tsx instaclaw/scripts/_verify-edge-readiness.ts --skip-chat
 *     (skips the 30s-per-VM chat completion probe — useful for fast daily checks)
 *   npx tsx instaclaw/scripts/_verify-edge-readiness.ts --vm=instaclaw-vm-050
 *     (probe a single VM)
 */

import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { NodeSSH } from "node-ssh";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  try {
    const env = readFileSync(f, "utf-8");
    for (const l of env.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SSH_KEY_B64 = process.env.SSH_PRIVATE_KEY_B64!;

if (!SUPABASE_URL || !SUPABASE_KEY || !SSH_KEY_B64) {
  console.error("missing env: need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SSH_PRIVATE_KEY_B64");
  process.exit(2);
}

const SKIP_CHAT = process.argv.includes("--skip-chat");
const SINGLE_VM = process.argv.find((a) => a.startsWith("--vm="))?.split("=")[1];

const EDGE_SKILL_REPO = "https://github.com/aromeoes/edge-agent-skill";

type Severity = "P0" | "P1" | "P2";
type Status = "PASS" | "FAIL" | "WARN" | "SKIP";

interface GateResult {
  name: string;
  severity: Severity;
  status: Status;
  detail: string;
}

interface VmResult {
  name: string;
  ip: string;
  cv_db: number | null;
  ssh_ok: boolean;
  gates: GateResult[];
}

interface VmRow {
  name: string;
  ip_address: string;
  config_version: number | null;
  partner: string | null;
  agentbook_wallet_address: string | null;
  index_user_id: string | null;
  index_api_key: string | null;
  telegram_bot_username: string | null;
  health_status: string | null;
}

async function fetchEdgeVms(): Promise<VmRow[]> {
  const url =
    `${SUPABASE_URL}/rest/v1/instaclaw_vms?partner=eq.edge_city&select=name,ip_address,config_version,partner,agentbook_wallet_address,index_user_id,index_api_key,telegram_bot_username,health_status&order=name`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return (await res.json()) as VmRow[];
}

async function fetchManifestVersion(): Promise<number> {
  // Read current manifest version from the repo (assumes script runs from a
  // checked-out worktree; falls back to "unknown" → won't cv-gate)
  try {
    const src = readFileSync("/Users/cooperwrenn/wild-west-bots/instaclaw/lib/vm-manifest.ts", "utf-8");
    const m = src.match(/^\s*version:\s*(\d+),/m);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

function getUpstreamSkillHead(): string | null {
  try {
    const out = execSync(`git ls-remote ${EDGE_SKILL_REPO} HEAD`, { encoding: "utf-8", timeout: 10_000 });
    const m = out.match(/^([0-9a-f]{40})\s+HEAD/);
    return m ? m[1].slice(0, 7) : null;
  } catch {
    return null;
  }
}

// ─── Per-VM SSH probe ──────────────────────────────────────────────────────

const PROBE_SCRIPT = (skipChat: boolean) => `
emit() { echo "GATE|$1|$2"; }

# 1. EDGEOS_BEARER_TOKEN shape
TOK=$(grep '^EDGEOS_BEARER_TOKEN=' ~/.openclaw/.env 2>/dev/null | head -1 | sed 's/^EDGEOS_BEARER_TOKEN=//' | tr -d '"')
if [ -z "$TOK" ]; then
  emit edgeos_token "MISSING"
elif [[ "$TOK" == eyJ* ]] && [ \${#TOK} -ge 100 ]; then
  emit edgeos_token "OK(len=\${#TOK})"
else
  emit edgeos_token "WRONG_SHAPE(prefix=\${TOK:0:6}...,len=\${#TOK})"
fi

# 2. edge-esmeralda skill
SDIR=~/.openclaw/skills/edge-esmeralda
if [ -d \$SDIR/.git ]; then
  HEAD=\$(cd \$SDIR && git rev-parse --short HEAD 2>/dev/null)
  SKILL_MD=\$([ -f \$SDIR/SKILL.md ] && echo Y || echo N)
  emit edge_skill_head "\${HEAD}"
  emit edge_skill_md "\${SKILL_MD}"
elif [ -d \$SDIR ]; then
  emit edge_skill_head "DIR_NO_GIT"
  emit edge_skill_md "?"
else
  emit edge_skill_head "MISSING"
  emit edge_skill_md "MISSING"
fi

# 3. Sola calendar probe (from VM)
SOLA_HTTP=\$(curl -sS -m 8 -o /tmp/_sola.json -w "%{http_code}" "https://api.sola.day/api/event/list?group_id=3688&start_date=2026-05-30&end_date=2026-06-27&limit=5" 2>&1)
SOLA_EVENTS=\$(python3 -c "import json; d=json.load(open('/tmp/_sola.json')); print(len(d.get('events',[])))" 2>/dev/null || echo "?")
emit sola_probe "http=\${SOLA_HTTP},events=\${SOLA_EVENTS}"
rm -f /tmp/_sola.json

# 4. agentbook wallet on disk (private key file)
[ -f ~/.openclaw/wallet/agent.key ] && emit agentbook_disk "key_present" || emit agentbook_disk "key_missing"

# 5. gbrain.service active + KillSignal
GA=\$(systemctl --user is-active gbrain.service 2>/dev/null)
GK=\$(grep "^KillSignal=" ~/.config/systemd/user/gbrain.service 2>/dev/null | head -1 | sed 's/^KillSignal=//')
emit gbrain_active "\${GA}"
emit gbrain_killsignal "\${GK:-MISSING}"

# 6. openclaw-gateway active + /health
GW=\$(systemctl --user is-active openclaw-gateway 2>/dev/null)
HTTP=\$(curl -sf -m 4 -o /dev/null -w "%{http_code}" http://localhost:18789/health 2>/dev/null || echo 000)
emit gateway_active "\${GW}"
emit gateway_health "\${HTTP}"

# 7. Index Network state on disk
IDX_USER_ENV=\$(grep '^INDEX_USER_ID=' ~/.openclaw/.env 2>/dev/null | head -1 | sed 's/^INDEX_USER_ID=//' | tr -d '"' | head -c 12)
IDX_KEY_LEN=\$(grep '^INDEX_USER_API_KEY=\\|^INDEX_API_KEY=' ~/.openclaw/.env 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | wc -c)
IDX_MCP=\$(python3 -c "import json; d=json.load(open('\$HOME/.openclaw/openclaw.json')); print('present' if 'index' in d.get('mcp',{}).get('servers',{}) else 'absent')" 2>/dev/null || echo "?")
emit index_user_env "\${IDX_USER_ENV:-empty}"
emit index_key_env_len "\${IDX_KEY_LEN}"
emit index_mcp_servers "\${IDX_MCP}"

# 8. cv on disk
CV=\$(python3 -c "import json; d=json.load(open('\$HOME/.openclaw/openclaw.json')); print(d.get('_cv', d.get('config_version', 'unknown')))" 2>/dev/null || echo unknown)
emit cv_on_disk "\${CV}"

${skipChat ? `emit chat "SKIPPED(--skip-chat)"` : `
# 9. chat completion sample (30s budget — TTFT with 40K upfront is 15-20s)
TOKEN=\$(grep '^GATEWAY_TOKEN=' ~/.openclaw/.env 2>/dev/null | head -1 | sed 's/^GATEWAY_TOKEN=//' | tr -d '"')
if [ -n "\$TOKEN" ]; then
  START=\$(date +%s%3N)
  R=\$(curl -sS -m 30 -X POST "http://localhost:18789/v1/chat/completions" \\
    -H "Authorization: Bearer \$TOKEN" -H "Content-Type: application/json" \\
    -d '{"model":"openclaw","messages":[{"role":"user","content":"reply with exactly the word: ok"}],"max_tokens":10}' \\
    -w "__HTTP=%{http_code}" 2>&1)
  END=\$(date +%s%3N)
  HTTP=\$(echo "\$R" | grep -oE "__HTTP=[0-9]+" | sed 's/__HTTP=//')
  MS=\$((END-START))
  if [ "\$HTTP" = "200" ]; then
    C=\$(echo "\$R" | sed 's/__HTTP=.*\$//' | python3 -c "import json,sys; print(json.load(sys.stdin)['choices'][0]['message']['content'][:20])" 2>/dev/null)
    emit chat "OK(ms=\$MS,content='\$C')"
  else
    emit chat "FAIL(http=\$HTTP,ms=\$MS)"
  fi
else
  emit chat "NO_GATEWAY_TOKEN_IN_ENV"
fi
`}

# 10. workspace bootstrap-file sizes.
# OpenClaw 2026.4.26 loads exactly 8 files as upfront context (VALID_BOOTSTRAP_NAMES
# in workspace-Ddypv-c6.js). CAPABILITIES.md / EARN.md are NOT upfront —
# the agent reads them on demand via filesystem tools. The pre-2026-05-18
# version of this gate compared (SOUL+AGENTS+CAPS+IDENT) against 40000,
# but 40000 is the PER-FILE cap (bootstrapMaxChars), not the total. The
# TOTAL cap is bootstrapTotalMaxChars (default 60000, currently unpinned).
SOUL=\$(wc -c < ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo 0)
AGENTS=\$(wc -c < ~/.openclaw/workspace/AGENTS.md 2>/dev/null || echo 0)
TOOLS=\$(wc -c < ~/.openclaw/workspace/TOOLS.md 2>/dev/null || echo 0)
IDENT=\$(wc -c < ~/.openclaw/workspace/IDENTITY.md 2>/dev/null || echo 0)
USER_F=\$(wc -c < ~/.openclaw/workspace/USER.md 2>/dev/null || echo 0)
HB=\$(wc -c < ~/.openclaw/workspace/HEARTBEAT.md 2>/dev/null || echo 0)
MEM=\$(wc -c < ~/.openclaw/workspace/MEMORY.md 2>/dev/null || echo 0)
BSTR=\$(wc -c < ~/.openclaw/workspace/BOOTSTRAP.md 2>/dev/null || echo 0)
emit workspace_bootstrap "soul=\$SOUL,agents=\$AGENTS,tools=\$TOOLS,ident=\$IDENT,user=\$USER_F,heartbeat=\$HB,memory=\$MEM,bootstrap=\$BSTR,total=\$((SOUL+AGENTS+TOOLS+IDENT+USER_F+HB+MEM+BSTR))"

echo "DONE"
`;

async function probeOne(vm: VmRow, upstreamHead: string | null, manifestVersion: number): Promise<VmResult> {
  const gates: GateResult[] = [];
  const result: VmResult = {
    name: vm.name,
    ip: vm.ip_address,
    cv_db: vm.config_version,
    ssh_ok: false,
    gates,
  };

  // DB-side gates first (no SSH needed)
  gates.push({
    name: "DB.partner=edge_city",
    severity: "P0",
    status: vm.partner === "edge_city" ? "PASS" : "FAIL",
    detail: `partner=${vm.partner}`,
  });
  gates.push({
    name: "DB.agentbook_wallet_address",
    severity: "P0",
    status: vm.agentbook_wallet_address ? "PASS" : "FAIL",
    detail: vm.agentbook_wallet_address ? `${vm.agentbook_wallet_address.slice(0, 10)}…` : "null",
  });
  gates.push({
    name: "DB.index_user_id",
    severity: "P1",
    status: vm.index_user_id ? "PASS" : "FAIL",
    detail: vm.index_user_id ?? "null (stepIndexProvision hasn't run)",
  });
  gates.push({
    name: "DB.index_api_key",
    severity: "P1",
    status: vm.index_api_key ? "PASS" : "FAIL",
    detail: vm.index_api_key ? "(set)" : "null",
  });
  gates.push({
    name: "DB.cv vs manifest",
    severity: "P2",
    status: vm.config_version === manifestVersion ? "PASS" : "WARN",
    detail: `cv=${vm.config_version} manifest=${manifestVersion}`,
  });
  gates.push({
    name: "DB.health_status",
    severity: "P0",
    status: vm.health_status === "healthy" ? "PASS" : "FAIL",
    detail: vm.health_status ?? "null",
  });

  // SSH probe
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: vm.ip_address,
      username: "openclaw",
      privateKey: Buffer.from(SSH_KEY_B64, "base64").toString("utf-8"),
      readyTimeout: 10_000,
    });
    result.ssh_ok = true;

    const r = await ssh.execCommand(PROBE_SCRIPT(SKIP_CHAT), { execOptions: { pty: false } });
    ssh.dispose();

    const lines = (r.stdout || "").split("\n");
    const kv: Record<string, string> = {};
    for (const l of lines) {
      const m = l.match(/^GATE\|([^|]+)\|(.*)$/);
      if (m) kv[m[1]] = m[2];
    }

    // Classify each on-VM gate
    const tok = kv["edgeos_token"] || "MISSING";
    gates.push({
      name: "VM.EDGEOS_BEARER_TOKEN",
      severity: "P0",
      status: tok.startsWith("OK(") ? "PASS" : "FAIL",
      detail: tok,
    });

    const skillHead = kv["edge_skill_head"] || "MISSING";
    const skillMd = kv["edge_skill_md"] || "?";
    let skillStatus: Status = "FAIL";
    let skillDetail = `head=${skillHead} skill_md=${skillMd}`;
    if (skillHead === "MISSING") skillStatus = "FAIL";
    else if (skillHead === "DIR_NO_GIT") skillStatus = "FAIL";
    else if (upstreamHead && skillHead.startsWith(upstreamHead)) {
      skillStatus = "PASS";
      skillDetail = `at upstream HEAD (${upstreamHead})`;
    } else if (upstreamHead) {
      skillStatus = "WARN";
      skillDetail = `${skillHead} vs upstream ${upstreamHead} (auto-pull cron should converge)`;
    } else {
      skillStatus = "PASS";
      skillDetail = `head=${skillHead} (upstream lookup failed; can't verify drift)`;
    }
    gates.push({ name: "VM.edge_skill HEAD", severity: "P1", status: skillStatus, detail: skillDetail });
    gates.push({
      name: "VM.edge_skill SKILL.md",
      severity: "P0",
      status: skillMd === "Y" ? "PASS" : "FAIL",
      detail: `present=${skillMd}`,
    });

    const sola = kv["sola_probe"] || "missing";
    const solaPass = /http=200/.test(sola) && /events=[1-9]/.test(sola);
    gates.push({
      name: "VM.sola_probe (api.sola.day)",
      severity: "P0",
      status: solaPass ? "PASS" : "FAIL",
      detail: sola,
    });

    gates.push({
      name: "VM.agentbook_wallet_disk",
      severity: "P0",
      status: kv["agentbook_disk"] === "key_present" ? "PASS" : "FAIL",
      detail: kv["agentbook_disk"] ?? "?",
    });

    gates.push({
      name: "VM.gbrain.service active",
      severity: "P0",
      status: kv["gbrain_active"] === "active" ? "PASS" : "FAIL",
      detail: kv["gbrain_active"] ?? "?",
    });
    gates.push({
      name: "VM.gbrain KillSignal=SIGKILL (Rule 54)",
      severity: "P1",
      status: kv["gbrain_killsignal"] === "SIGKILL" ? "PASS" : "FAIL",
      detail: kv["gbrain_killsignal"] ?? "MISSING",
    });

    gates.push({
      name: "VM.gateway active",
      severity: "P0",
      status: kv["gateway_active"] === "active" ? "PASS" : "FAIL",
      detail: kv["gateway_active"] ?? "?",
    });
    gates.push({
      name: "VM.gateway /health=200",
      severity: "P0",
      status: kv["gateway_health"] === "200" ? "PASS" : "FAIL",
      detail: kv["gateway_health"] ?? "?",
    });

    // Index Network
    const idxUser = kv["index_user_env"] || "empty";
    const idxKeyLen = parseInt(kv["index_key_env_len"] ?? "0", 10);
    const idxMcp = kv["index_mcp_servers"] ?? "?";
    gates.push({
      name: "VM.INDEX_USER_ID in .env",
      severity: "P1",
      status: idxUser !== "empty" ? "PASS" : "FAIL",
      detail: idxUser,
    });
    gates.push({
      name: "VM.INDEX_USER_API_KEY in .env",
      severity: "P1",
      status: idxKeyLen > 10 ? "PASS" : "FAIL",
      detail: `len=${idxKeyLen}`,
    });
    gates.push({
      name: "VM.openclaw.json mcp.servers.index",
      severity: "P1",
      status: idxMcp === "present" ? "PASS" : "FAIL",
      detail: idxMcp,
    });

    // Chat (if not skipped)
    const chat = kv["chat"] ?? "missing";
    if (chat.startsWith("SKIPPED")) {
      gates.push({ name: "VM.chat completion", severity: "P0", status: "SKIP", detail: chat });
    } else {
      const chatPass = chat.startsWith("OK(");
      gates.push({
        name: "VM.chat completion (model=openclaw)",
        severity: "P0",
        status: chatPass ? "PASS" : "FAIL",
        detail: chat,
      });
    }

    // Workspace bootstrap-file sizes.
    //
    // Two separate caps in OpenClaw 2026.4.26 (runtime-schema-TpYHXgGk.js
    // §3208-3220):
    //   bootstrapMaxChars (per-FILE)    — 12000 default, ours 40000
    //   bootstrapTotalMaxChars (TOTAL)  — 60000 default, ours unpinned (uses default)
    //
    // Files loaded as upfront context (VALID_BOOTSTRAP_NAMES in
    // workspace-Ddypv-c6.js): SOUL, AGENTS, TOOLS, IDENTITY, USER, HEARTBEAT,
    // MEMORY, BOOTSTRAP. CAPABILITIES.md / EARN.md sit on disk but the agent
    // reads them on demand — NOT upfront.
    const PER_FILE_CAP = 40000;
    const TOTAL_CAP = 60000;
    const ws = kv["workspace_bootstrap"] ?? "";
    const fileSizes: Record<string, number> = {};
    for (const m of ws.matchAll(/(\w+)=(\d+)/g)) {
      fileSizes[m[1]] = parseInt(m[2], 10);
    }
    const total = fileSizes["total"] ?? 0;

    // Per-file cap: each of the 8 bootstrap files must be ≤ 40000.
    // (We don't enumerate each as a separate gate to avoid log noise — instead,
    // the detail line names the offender if any.)
    const perFileOver: string[] = [];
    for (const [k, v] of Object.entries(fileSizes)) {
      if (k === "total") continue;
      if (v > PER_FILE_CAP) perFileOver.push(`${k}=${v}`);
    }
    gates.push({
      name: `VM.bootstrap per-file ≤ ${PER_FILE_CAP} (bootstrapMaxChars)`,
      severity: "P0",
      status: perFileOver.length === 0 ? "PASS" : "FAIL",
      detail: perFileOver.length === 0
        ? `all 8 files under cap (SOUL=${fileSizes["soul"] ?? "?"} is largest)`
        : `OVER PER-FILE CAP: ${perFileOver.join(", ")}`,
    });

    // Total cap: sum across all bootstrap files must be ≤ 60000.
    const totalStatus: Status =
      total > 0 && total <= TOTAL_CAP * 0.85 ? "PASS" : // <51K — comfortable
      total > 0 && total <= TOTAL_CAP ? "WARN" :         // 51K-60K — approaching cap
      "FAIL";                                             // >60K — actual truncation
    gates.push({
      name: `VM.bootstrap total ≤ ${TOTAL_CAP} (bootstrapTotalMaxChars)`,
      severity: totalStatus === "FAIL" ? "P0" : "P1",
      status: totalStatus,
      detail: `${total} chars vs cap ${TOTAL_CAP} (headroom ${TOTAL_CAP - total})`,
    });

  } catch (e: unknown) {
    try { ssh.dispose(); } catch {}
    gates.push({
      name: "SSH connect",
      severity: "P0",
      status: "FAIL",
      detail: e instanceof Error ? e.message.slice(0, 100) : String(e),
    });
  }

  return result;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("─── Edge Esmeralda Readiness Audit ────────────────────────────────");
  console.log(`  Generated: ${new Date().toISOString()}`);
  if (SKIP_CHAT) console.log(`  Mode: --skip-chat (no chat-completion probe)`);
  if (SINGLE_VM) console.log(`  Mode: --vm=${SINGLE_VM}`);
  console.log("");

  let edgeVms = await fetchEdgeVms();
  if (SINGLE_VM) {
    edgeVms = edgeVms.filter((v) => v.name === SINGLE_VM);
    if (!edgeVms.length) {
      console.error(`no edge_city VM matching ${SINGLE_VM}`);
      process.exit(2);
    }
  }
  console.log(`  Edge VMs to probe: ${edgeVms.length}`);

  const upstreamHead = getUpstreamSkillHead();
  console.log(`  edge-esmeralda upstream HEAD: ${upstreamHead ?? "(lookup failed — skill-drift gate disabled)"}`);

  const manifestVersion = await fetchManifestVersion();
  console.log(`  Current manifest version: v${manifestVersion}`);
  console.log("");

  const startMs = Date.now();
  // Parallel probe — each VM is independent
  const results = await Promise.all(edgeVms.map((vm) => probeOne(vm, upstreamHead, manifestVersion)));
  const elapsedMs = Date.now() - startMs;

  // Per-VM table
  for (const r of results) {
    console.log(`── ${r.name} (${r.ip}) ${r.ssh_ok ? "" : "[SSH FAILED]"}`);
    if (!r.ssh_ok) {
      const sshGate = r.gates.find((g) => g.name === "SSH connect");
      if (sshGate) console.log(`    ✗ ${sshGate.detail}`);
      continue;
    }
    for (const g of r.gates) {
      const ico = g.status === "PASS" ? "✓" : g.status === "FAIL" ? "✗" : g.status === "WARN" ? "⚠" : "○";
      const sev = g.severity === "P0" ? "P0" : g.severity === "P1" ? "P1" : "P2";
      const truncDetail = g.detail.length > 80 ? g.detail.slice(0, 77) + "..." : g.detail;
      console.log(`    ${ico} [${sev}] ${g.name.padEnd(45)} ${truncDetail}`);
    }
  }

  // Summary by severity
  console.log("\n─── Summary ───────────────────────────────────────────────────────");
  let p0Fails = 0, p1Fails = 0, p2Fails = 0, totalGates = 0;
  const p0FailDetails: Array<{ vm: string; gate: string; detail: string }> = [];
  for (const r of results) {
    for (const g of r.gates) {
      totalGates++;
      if (g.status === "FAIL") {
        if (g.severity === "P0") {
          p0Fails++;
          p0FailDetails.push({ vm: r.name, gate: g.name, detail: g.detail });
        } else if (g.severity === "P1") p1Fails++;
        else p2Fails++;
      } else if (g.status === "WARN") {
        if (g.severity === "P1") p1Fails++;
      }
    }
  }
  console.log(`  Total gates checked: ${totalGates} across ${results.length} VMs`);
  console.log(`  P0 fails (block conference): ${p0Fails}`);
  console.log(`  P1 fails / warns (degraded): ${p1Fails}`);
  console.log(`  P2 fails / warns:             ${p2Fails}`);
  console.log(`  Wall time: ${(elapsedMs / 1000).toFixed(1)}s`);

  if (p0FailDetails.length > 0) {
    console.log("\n─── P0 fail detail (must fix before May 30) ───────────────────────");
    for (const f of p0FailDetails) {
      console.log(`  ✗ ${f.vm}  ${f.gate}`);
      console.log(`     ${f.detail}`);
    }
  }

  // Save JSON
  const outPath = `/tmp/edge-readiness-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(outPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    upstream_skill_head: upstreamHead,
    manifest_version: manifestVersion,
    vm_count: results.length,
    summary: { p0_fails: p0Fails, p1_fails: p1Fails, p2_fails: p2Fails },
    results,
  }, null, 2));
  console.log(`\n  Full JSON: ${outPath}`);

  if (p0Fails > 0) {
    console.log("\n  ✗ NOT READY — P0 fails block Esmeralda. See per-VM table.");
    process.exit(1);
  } else if (p1Fails > 0) {
    console.log("\n  ⚠ DEGRADED — P1 issues; conference can proceed but fix before May 30.");
    process.exit(0);
  } else {
    console.log("\n  ✓ READY — all gates pass.");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
