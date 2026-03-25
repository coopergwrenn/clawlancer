import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { connectSSH, NVM_PREAMBLE, type VMRecord } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const DBUS_PREAMBLE = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';

/** Full VM record type for config rebuild */
interface FullVMRecord {
  id: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  name?: string;
  gateway_token?: string;
  telegram_bot_token?: string;
  discord_bot_token?: string;
  brave_api_key?: string;
  default_model?: string;
  channels_enabled?: string[];
  assigned_to?: string;
  telegram_bot_username?: string;
}

/**
 * Build a complete standard openclaw.json from VM database record.
 */
function buildStandardConfig(vm: FullVMRecord): Record<string, unknown> {
  const proxyBaseUrl = `https://instaclaw.io/api/gateway/${vm.assigned_to}`;
  const gatewayToken = vm.gateway_token || "MISSING";
  const openclawModel = `anthropic/${vm.default_model || "claude-sonnet-4-6"}`;

  const cfg: Record<string, unknown> = {
    wizard: {
      lastRunAt: new Date().toISOString(),
      lastRunVersion: "2026.3.22",
      lastRunCommand: "onboard",
      lastRunMode: "local",
    },
    browser: {
      executablePath: "/usr/local/bin/chromium-browser",
      headless: true,
      noSandbox: true,
      defaultProfile: "openclaw",
      profiles: {
        openclaw: { cdpPort: 18800, color: "#FF4500" },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: openclawModel,
          fallbacks: ["anthropic/claude-haiku-4-5-20251001"],
        },
        bootstrapMaxChars: 30000,
        heartbeat: { every: "3h", session: "heartbeat" },
        compaction: {
          reserveTokensFloor: 35000,
          memoryFlush: { enabled: true, softThresholdTokens: 8000 },
        },
        memorySearch: { enabled: true },
      },
    },
    session: {
      reset: { mode: "idle", idleMinutes: 10080 },
      maintenance: { mode: "enforce" },
    },
    messages: {},
    commands: { restart: true, useAccessGroups: false },
    channels: {} as Record<string, unknown>,
    gateway: {
      mode: "local",
      port: 28899,
      bind: "lan",
      controlUi: { dangerouslyAllowHostHeaderOriginFallback: true },
      auth: { mode: "token", token: gatewayToken },
      trustedProxies: ["127.0.0.1", "::1"],
      http: { endpoints: { chatCompletions: { enabled: true } } },
    },
    models: {
      providers: {
        anthropic: {
          baseUrl: proxyBaseUrl,
          api: "anthropic-messages",
          models: [],
        },
      },
    },
    tools: {
      media: {
        image: { enabled: true, timeoutSeconds: 120 },
        audio: { enabled: true, timeoutSeconds: 120 },
        video: { enabled: true, timeoutSeconds: 120 },
      },
      links: { timeoutSeconds: 30 },
    } as Record<string, unknown>,
    skills: {
      load: { extraDirs: ["/home/openclaw/.openclaw/skills"] },
      limits: { maxSkillsPromptChars: 500000 },
    },
    plugins: { entries: {} as Record<string, unknown> },
  };

  // Channels
  const channels = cfg.channels as Record<string, unknown>;
  if (vm.telegram_bot_token) {
    channels.telegram = {
      botToken: vm.telegram_bot_token,
      allowFrom: ["*"],
      dmPolicy: "open",
      groupPolicy: "open",
      streamMode: "partial",
      groups: { "*": { requireMention: false } },
    };
    (cfg.plugins as { entries: Record<string, unknown> }).entries.telegram = { enabled: true };
  }
  if (vm.discord_bot_token) {
    channels.discord = {
      botToken: vm.discord_bot_token,
      allowFrom: ["*"],
    };
    (cfg.plugins as { entries: Record<string, unknown> }).entries.discord = { enabled: true };
  }

  // Brave search
  if (vm.brave_api_key) {
    (cfg.tools as Record<string, unknown>).web = {
      search: { provider: "brave", apiKey: vm.brave_api_key, timeoutSeconds: 30 },
    };
  }

  return cfg;
}

/**
 * Apply infrastructure fixes to a single VM over SSH.
 * Reused for both single-VM and fleet modes.
 */
async function applyFixes(
  vm: Pick<VMRecord, "id" | "ip_address" | "ssh_port" | "ssh_user"> & { name?: string },
  fixes: string[],
  fullVm?: FullVMRecord,
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  const ssh = await connectSSH(vm);

  try {
    for (const fix of fixes) {
      switch (fix) {
        case "systemd-override": {
          const check = await ssh.execCommand(
            "grep -c MemoryHigh ~/.config/systemd/user/openclaw-gateway.service.d/override.conf 2>/dev/null || echo 0"
          );
          if (parseInt(check.stdout.trim()) > 0) {
            results["systemd-override"] = "already-present";
            break;
          }
          const writeCmd =
            "mkdir -p ~/.config/systemd/user/openclaw-gateway.service.d && " +
            "cat > ~/.config/systemd/user/openclaw-gateway.service.d/override.conf << 'HEREDOC'\n" +
            "[Service]\n" +
            "KillMode=mixed\n" +
            "RestartSec=10\n" +
            "StartLimitBurst=10\n" +
            "StartLimitIntervalSec=300\n" +
            "StartLimitAction=stop\n" +
            "MemoryHigh=3G\n" +
            "MemoryMax=3500M\n" +
            "TasksMax=150\n" +
            "OOMScoreAdjust=500\n" +
            "RuntimeMaxSec=86400\n" +
            "RuntimeRandomizedExtraSec=3600\n" +
            "HEREDOC";
          await ssh.execCommand(writeCmd);
          await ssh.execCommand(`${DBUS_PREAMBLE} && systemctl --user daemon-reload 2>/dev/null || true`);
          const verify = await ssh.execCommand(
            "grep -c MemoryHigh ~/.config/systemd/user/openclaw-gateway.service.d/override.conf 2>/dev/null || echo 0"
          );
          results["systemd-override"] = parseInt(verify.stdout.trim()) > 0 ? "fixed" : "failed";
          break;
        }

        case "swap": {
          const check = await ssh.execCommand("swapon --show 2>/dev/null | grep -c swapfile || echo 0");
          if (parseInt(check.stdout.trim()) > 0) {
            results["swap"] = "already-active";
            break;
          }
          const swapCmd = [
            "sudo fallocate -l 2G /swapfile",
            "sudo chmod 600 /swapfile",
            "sudo mkswap /swapfile",
            "sudo swapon /swapfile",
            "grep -q swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab",
          ].join(" && ");
          const r = await ssh.execCommand(swapCmd);
          const verify = await ssh.execCommand("swapon --show 2>/dev/null | grep -c swapfile || echo 0");
          results["swap"] = parseInt(verify.stdout.trim()) > 0 ? "fixed" : `failed: ${r.stderr?.slice(0, 200)}`;
          break;
        }

        case "pip3": {
          const check = await ssh.execCommand("which pip3 2>/dev/null && echo OK || echo MISSING");
          if (check.stdout.trim().includes("OK")) {
            await ssh.execCommand("pip3 install --break-system-packages --quiet openai 2>/dev/null || true");
            results["pip3"] = "already-present-openai-installed";
            break;
          }
          const installCmd = [
            "sudo apt-get update -qq",
            "sudo apt-get install -y -qq python3-pip",
            "pip3 install --break-system-packages --quiet openai",
          ].join(" && ");
          const r = await ssh.execCommand(installCmd);
          const verify = await ssh.execCommand("pip3 show openai 2>/dev/null | grep -q Name && echo OK || echo MISSING");
          results["pip3"] = verify.stdout.trim() === "OK" ? "fixed" : `failed: ${r.stderr?.slice(0, 200)}`;
          break;
        }

        case "playwright": {
          const check = await ssh.execCommand(
            'find ~/.cache/ms-playwright -name "chrome" -type f 2>/dev/null | grep chrome-linux64/chrome | head -1'
          );
          if (check.stdout.trim()) {
            await ssh.execCommand(`sudo ln -sfn "${check.stdout.trim()}" /usr/local/bin/chromium-browser`);
            results["playwright"] = "already-present-symlink-fixed";
            break;
          }
          await ssh.execCommand(`${NVM_PREAMBLE} && npx playwright install chromium`);
          const chromeCheck = await ssh.execCommand(
            'find ~/.cache/ms-playwright -name "chrome" -type f 2>/dev/null | grep chrome-linux64/chrome | head -1'
          );
          if (chromeCheck.stdout.trim()) {
            await ssh.execCommand(`sudo ln -sfn "${chromeCheck.stdout.trim()}" /usr/local/bin/chromium-browser`);
            results["playwright"] = "fixed";
          } else {
            results["playwright"] = "failed-no-chrome-found";
          }
          break;
        }

        case "diagnose": {
          // Read key config files and gateway logs for support diagnosis
          const diag: Record<string, string> = {};

          // openclaw.json config
          const ocJson = await ssh.execCommand("cat ~/.openclaw/agents/main/agent/openclaw.json 2>/dev/null || echo MISSING");
          diag["openclaw.json"] = ocJson.stdout.trim().slice(0, 4000);

          // auth-profiles.json (redact key)
          const authP = await ssh.execCommand("cat ~/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null | sed 's/\"key\":\"[^\"]*\"/\"key\":\"REDACTED\"/g' || echo MISSING");
          diag["auth-profiles.json"] = authP.stdout.trim().slice(0, 2000);

          // MEMORY.md size and first 20 lines
          const mem = await ssh.execCommand("wc -c ~/.openclaw/agents/main/agent/workspace/MEMORY.md 2>/dev/null; echo '---'; head -20 ~/.openclaw/agents/main/agent/workspace/MEMORY.md 2>/dev/null || echo MISSING");
          diag["MEMORY.md"] = mem.stdout.trim().slice(0, 2000);

          // SOUL.md size
          const soul = await ssh.execCommand("wc -c ~/.openclaw/agents/main/agent/workspace/SOUL.md 2>/dev/null || echo MISSING");
          diag["SOUL.md-size"] = soul.stdout.trim();

          // Session files
          const sessions = await ssh.execCommand("ls -la ~/.openclaw/agents/main/agent/sessions/ 2>/dev/null | tail -20 || echo 'NO SESSIONS DIR'");
          diag["sessions"] = sessions.stdout.trim().slice(0, 2000);

          // Control UI check
          const controlUI = await ssh.execCommand("ls -la ~/.openclaw/agents/main/ui/ 2>/dev/null | head -10 || echo 'NO UI DIR'; ls ~/.openclaw/agents/main/ui/dist/ 2>/dev/null | head -5 || echo 'NO DIST DIR'");
          diag["control-ui"] = controlUI.stdout.trim().slice(0, 1000);

          // Gateway journal logs (last 50 lines)
          const logs = await ssh.execCommand(`${DBUS_PREAMBLE} && journalctl --user -u openclaw-gateway --no-pager -n 50 2>/dev/null || echo 'NO JOURNAL'`);
          diag["gateway-logs"] = logs.stdout.trim().slice(0, 4000);

          // Health endpoint
          const health = await ssh.execCommand("curl -s http://localhost:18789/api/health 2>/dev/null || echo 'HEALTH UNREACHABLE'");
          diag["health"] = health.stdout.trim().slice(0, 1000);

          // Disk usage
          const disk = await ssh.execCommand("df -h / | tail -1; echo '---'; du -sh ~/.openclaw/ 2>/dev/null || echo 'N/A'");
          diag["disk"] = disk.stdout.trim();

          // Crontab
          const cron = await ssh.execCommand("crontab -l 2>/dev/null || echo 'NO CRONTAB'");
          diag["crontab"] = cron.stdout.trim().slice(0, 2000);

          // Process check
          const procs = await ssh.execCommand("ps aux | grep -E '(openclaw|node|chrome)' | grep -v grep | head -20");
          diag["processes"] = procs.stdout.trim().slice(0, 2000);

          results["diagnose"] = JSON.stringify(diag);
          break;
        }

        case "reset-config": {
          // Reset openclaw.json to standard config
          // First read current config to preserve necessary values
          const currentCfg = await ssh.execCommand("cat ~/.openclaw/agents/main/agent/openclaw.json 2>/dev/null");
          if (!currentCfg.stdout.trim() || currentCfg.stdout.trim() === "MISSING") {
            results["reset-config"] = "failed-no-config";
            break;
          }

          let cfg;
          try {
            cfg = JSON.parse(currentCfg.stdout.trim());
          } catch {
            results["reset-config"] = "failed-parse-error";
            break;
          }

          // Reset to standard values while preserving identity
          cfg.gateway = cfg.gateway || {};
          cfg.gateway.port = 18789;
          cfg.gateway.groupPolicy = "open";
          cfg.gateway.requireMention = false;
          cfg.gateway.useAccessGroups = false;

          cfg.agent = cfg.agent || {};
          cfg.agent.maxTurns = 50;
          cfg.agent.idleTimeout = 300;
          cfg.agent.sessionTimeout = 3600;
          cfg.agent.maxSkillsPromptChars = 30000;

          // Remove any bad user-added keys
          delete cfg.agent.memoryReset;
          delete cfg.agent.clearSessionOnIdle;

          const cfgStr = JSON.stringify(cfg, null, 2);
          const writeRes = await ssh.execCommand(`cat > ~/.openclaw/agents/main/agent/openclaw.json << 'CFGEOF'\n${cfgStr}\nCFGEOF`);
          if (writeRes.stderr && !writeRes.stderr.includes("warning")) {
            results["reset-config"] = `failed-write: ${writeRes.stderr.slice(0, 200)}`;
          } else {
            results["reset-config"] = "done";
          }
          break;
        }

        case "write-config": {
          // Create openclaw.json from scratch using DB data
          if (!fullVm) {
            results["write-config"] = "failed-no-full-vm-data";
            break;
          }
          const cfg = buildStandardConfig(fullVm);
          const cfgJson = JSON.stringify(cfg, null, 2);
          // Ensure directory exists
          await ssh.execCommand("mkdir -p ~/.openclaw/agents/main/agent");
          const wr = await ssh.execCommand(
            `cat > ~/.openclaw/agents/main/agent/openclaw.json << 'CFGEOF'\n${cfgJson}\nCFGEOF`
          );
          // Verify
          const verifyWr = await ssh.execCommand("test -f ~/.openclaw/agents/main/agent/openclaw.json && echo OK || echo MISSING");
          results["write-config"] = verifyWr.stdout.trim() === "OK"
            ? "created"
            : `failed: ${wr.stderr?.slice(0, 200)}`;
          break;
        }

        case "rebuild-ui": {
          // Rebuild OpenClaw Control UI by reinstalling the package
          // First try: npm rebuild to trigger postinstall which builds UI
          const rebuildCmd = `${NVM_PREAMBLE} && npm install -g openclaw@latest 2>&1 | tail -10`;
          const rebuildRes = await ssh.execCommand(rebuildCmd);
          // Check if index.html exists after rebuild
          const uiCheck = await ssh.execCommand(
            `${NVM_PREAMBLE} && test -f $(npm root -g)/openclaw/dist/control-ui/index.html && echo OK || echo MISSING`
          );
          if (uiCheck.stdout.trim() === "OK") {
            results["rebuild-ui"] = "built";
            break;
          }
          // Fallback: try running the build script directly
          const buildCmd = `${NVM_PREAMBLE} && cd $(npm root -g)/openclaw && node -e "const{execSync}=require('child_process');execSync('npm run ui:build',{stdio:'inherit'})" 2>&1 | tail -5`;
          const buildRes = await ssh.execCommand(buildCmd);
          const uiCheck2 = await ssh.execCommand(
            `${NVM_PREAMBLE} && test -f $(npm root -g)/openclaw/dist/control-ui/index.html && echo OK || echo MISSING`
          );
          results["rebuild-ui"] = uiCheck2.stdout.trim() === "OK"
            ? "built"
            : `failed: ${rebuildRes.stdout?.slice(0, 200)} | ${buildRes.stdout?.slice(0, 200)}`;
          break;
        }

        case "init-workspace": {
          // Create minimal workspace files if missing
          const wsBase = "~/.openclaw/agents/main/agent/workspace";
          await ssh.execCommand(`mkdir -p ${wsBase}/memory`);

          // MEMORY.md
          const memCheck = await ssh.execCommand(`test -s ${wsBase}/MEMORY.md && echo EXISTS || echo MISSING`);
          if (memCheck.stdout.trim() === "MISSING") {
            await ssh.execCommand(`echo "# Memory" > ${wsBase}/MEMORY.md`);
          }

          // SOUL.md — only create if missing, reconciler will fill it properly on next health check
          const soulCheck = await ssh.execCommand(`test -s ${wsBase}/SOUL.md && echo EXISTS || echo MISSING`);
          if (soulCheck.stdout.trim() === "MISSING") {
            await ssh.execCommand(`cat > ${wsBase}/SOUL.md << 'SEOF'
# SOUL.md — Core Identity & Operating Guidelines

## Core Truths
- Be genuinely helpful — not performatively helpful
- Have opinions. Share them when relevant.
- Be resourceful — use your tools, skills, and memory proactively.

## How I Communicate
- Be concise. Direct. No corporate speak.
- Read the room — DMs vs groups vs heartbeats need different energy.
- If you remember something about your human, show it.

## Memory Persistence (CRITICAL)
After every substantive conversation, update MEMORY.md:
- Format: ## YYYY-MM-DD — [Brief title] followed by 2-3 sentences
- Keep under 25KB; consolidate if >20KB
- These files ARE your memory across session resets

_This is a minimal SOUL.md. The full version will be deployed on next health check._
SEOF`);
          }

          // Sessions dir
          await ssh.execCommand(`mkdir -p ~/.openclaw/agents/main/agent/sessions`);

          const verify = await ssh.execCommand(
            `test -f ${wsBase}/SOUL.md && test -f ${wsBase}/MEMORY.md && echo OK || echo INCOMPLETE`
          );
          results["init-workspace"] = verify.stdout.trim() === "OK" ? "created" : "partial";
          break;
        }

        case "update-caddyfile": {
          // Block OpenClaw Control UI — redirect / to instaclaw.io/dashboard
          const caddyCheck = await ssh.execCommand(
            "sudo grep -c 'instaclaw.io/dashboard' /etc/caddy/Caddyfile 2>/dev/null || echo 0"
          );
          if (parseInt(caddyCheck.stdout.trim()) > 0) {
            results["update-caddyfile"] = "already-present";
            break;
          }
          // Read current Caddyfile to extract hostname
          const caddyCat = await ssh.execCommand("sudo cat /etc/caddy/Caddyfile 2>/dev/null");
          const caddyHostMatch = caddyCat.stdout.match(/^([a-zA-Z0-9][a-zA-Z0-9.\-]+)\s*\{/);
          if (!caddyHostMatch) {
            results["update-caddyfile"] = "no-caddyfile";
            break;
          }
          const caddyHost = caddyHostMatch[1];
          const newCaddyfile = [
            `${caddyHost} {`,
            `  handle /.well-known/* {`,
            `    root * /home/openclaw`,
            `    file_server`,
            `  }`,
            `  handle /tmp-media/* {`,
            `    root * /home/openclaw/workspace`,
            `    file_server`,
            `  }`,
            `  handle /relay/* {`,
            `    uri strip_prefix /relay`,
            `    reverse_proxy localhost:18792`,
            `  }`,
            `  # Block Control UI — redirect to dashboard`,
            `  handle / {`,
            `    header Content-Type "text/html; charset=utf-8"`,
            `    respond "<html><head><meta http-equiv='refresh' content='0;url=https://instaclaw.io/dashboard'><title>InstaClaw</title></head><body style='font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa'><div style='text-align:center'><h2 style='color:#1a1a1a'>Manage your agent at</h2><a href='https://instaclaw.io/dashboard' style='color:#2563eb;font-size:1.25rem'>instaclaw.io/dashboard</a></div></body></html>" 200`,
            `  }`,
            `  reverse_proxy localhost:18789`,
            `}`,
            ``,
          ].join("\n");
          const caddyB64 = Buffer.from(newCaddyfile, "utf-8").toString("base64");
          await ssh.execCommand(
            `echo '${caddyB64}' | base64 -d | sudo tee /etc/caddy/Caddyfile > /dev/null`
          );
          const caddyReload = await ssh.execCommand("sudo systemctl reload caddy 2>/dev/null");
          results["update-caddyfile"] = caddyReload.code === 0 ? "updated" : `reload-failed: ${caddyReload.stderr}`;
          break;
        }

        case "push-soul-principles": {
          // Force-push updated Operating Principles to SOUL.md (bypasses reconciler skip)
          const soulPath = "$HOME/.openclaw/workspace/SOUL.md";
          const soulCheck = await ssh.execCommand(`test -f ${soulPath} && echo EXISTS || echo MISSING`);
          if (soulCheck.stdout.trim() === "MISSING") {
            results["push-soul-principles"] = "no-soul-md";
            break;
          }
          // Check if latest principle (#4 self-restart ban) is already present
          const p4Check = await ssh.execCommand(`grep -qF "NEVER self-restart" ${soulPath} 2>/dev/null && echo PRESENT || echo ABSENT`);
          if (p4Check.stdout.trim() === "PRESENT") {
            results["push-soul-principles"] = "already-present";
            break;
          }
          // Build the full Operating Principles block
          const principlesBlock = [
            "## Operating Principles",
            "",
            "1. **Error handling:** Fix routine errors immediately without bothering the user. For anything involving security, data loss, or money — ask first.",
            "",
            "2. **Config safety:** Always back up files before modifying them. For unfamiliar systems, read docs first. For routine changes, proceed confidently.",
            "",
            '3. **Never go silent:** When starting any operation that may take more than 30 seconds (browser navigation, API calls, authentication flows, file generation, trading, etc.), ALWAYS send a quick message to the user FIRST like "Working on this, give me a minute..." or "On it — this might take a sec." NEVER go silent for more than 30 seconds without acknowledging what you\'re doing. The user will think you crashed.',
            "",
            "4. **NEVER self-restart:** NEVER restart your own gateway (`systemctl restart openclaw-gateway`) to fix browser issues or any other problem. This kills your Telegram connection and creates a crash loop where you go silent, come back, try again, and go silent again. If a website times out in the browser, try a different approach — use curl, API calls, web fetch, or ask the user for help. Do NOT restart yourself.",
            "",
          ].join("\n");
          const principlesB64 = Buffer.from(principlesBlock, "utf-8").toString("base64");
          // Replace existing Operating Principles section or insert before ## Boundaries
          // Strategy: delete old section (from "## Operating Principles" to next "## "), then insert new
          const sedResult = await ssh.execCommand(
            `python3 -c "
import re
with open('${soulPath.replace("$HOME", "/home/openclaw")}', 'r') as f:
    content = f.read()
# Remove old Operating Principles section (up to next ## heading)
content = re.sub(r'## Operating Principles.*?(?=## )', '', content, flags=re.DOTALL)
# Insert new principles before ## Boundaries (or append if no Boundaries)
import base64
new_block = base64.b64decode('${principlesB64}').decode()
if '## Boundaries' in content:
    content = content.replace('## Boundaries', new_block + '## Boundaries')
else:
    content = content.rstrip() + '\\n\\n' + new_block
with open('${soulPath.replace("$HOME", "/home/openclaw")}', 'w') as f:
    f.write(content)
print('OK')
" 2>&1`
          );
          results["push-soul-principles"] = sedResult.stdout.trim() === "OK" ? "updated" : `failed: ${sedResult.stdout.trim().slice(0, 200)}`;
          break;
        }

        case "restart-gateway": {
          await ssh.execCommand(`${DBUS_PREAMBLE} && systemctl --user restart openclaw-gateway 2>/dev/null || true`);
          // Wait for startup
          await new Promise((r) => setTimeout(r, 8000));
          const healthCheck = await ssh.execCommand("curl -s http://localhost:18789/api/health 2>/dev/null || echo UNREACHABLE");
          results["restart-gateway"] = healthCheck.stdout.trim().includes("ok") ? "restarted-healthy" : `restarted-status: ${healthCheck.stdout.trim().slice(0, 200)}`;
          break;
        }

        default:
          results[fix] = "unknown-fix";
      }
    }
  } finally {
    ssh.dispose();
  }

  return results;
}

/**
 * POST /api/vm/fix-infra
 *
 * Single VM:  { vmId: string, fixes: string[] }
 * Fleet mode: { fleet: true, dryRun?: true, fixes: string[] }
 * Auth: CRON_SECRET
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as {
    vmId?: string;
    fleet?: boolean;
    dryRun?: boolean;
    fixes: string[];
  };
  const { vmId, fleet, dryRun, fixes } = body;

  if (!fixes?.length) {
    return NextResponse.json({ error: "fixes required" }, { status: 400 });
  }

  const supabase = getSupabase();

  // Fleet mode
  if (fleet) {
    const { data: vms } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, name")
      .eq("status", "assigned")
      .not("ip_address", "is", null);

    if (!vms?.length) {
      return NextResponse.json({ message: "No assigned VMs", results: [] });
    }

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        vmCount: vms.length,
        fixes,
        vms: vms.map((v) => v.name),
      });
    }

    const fleetResults: Array<{ vm: string; results: Record<string, string> }> = [];
    const BATCH = 10;
    for (let i = 0; i < vms.length; i += BATCH) {
      const batch = vms.slice(i, i + BATCH);
      const batchResults = await Promise.allSettled(
        batch.map(async (vm) => {
          try {
            const r = await applyFixes(vm, fixes);
            return { vm: vm.name ?? vm.id, results: r };
          } catch (err) {
            return { vm: vm.name ?? vm.id, results: { error: String(err).slice(0, 200) } };
          }
        })
      );
      for (const r of batchResults) {
        if (r.status === "fulfilled") {
          fleetResults.push(r.value);
        } else {
          fleetResults.push({ vm: "unknown", results: { error: String(r.reason).slice(0, 200) } });
        }
      }
    }

    const summary = {
      total: fleetResults.length,
      fixed: fleetResults.filter((r) => Object.values(r.results).some((v) => v === "fixed")).length,
      alreadyOk: fleetResults.filter((r) => Object.values(r.results).every((v) => v.startsWith("already"))).length,
      failed: fleetResults.filter((r) => Object.values(r.results).some((v) => v.startsWith("failed") || v === "error")).length,
    };

    logger.info("Fleet fix-infra completed", { summary, fixes });
    return NextResponse.json({ summary, results: fleetResults });
  }

  // Single VM mode
  if (!vmId) {
    return NextResponse.json({ error: "vmId or fleet required" }, { status: 400 });
  }

  // Fetch full VM record (needed for write-config and deploy-workspace)
  const needsFullData = fixes.some((f) => ["write-config"].includes(f));
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id,ip_address,ssh_port,ssh_user,name,gateway_token,telegram_bot_token,discord_bot_token,brave_api_key,default_model,channels_enabled,assigned_to,telegram_bot_username")
    .eq("id", vmId)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "VM not found" }, { status: 404 });
  }

  try {
    const results = await applyFixes(vm, fixes, needsFullData ? (vm as unknown as FullVMRecord) : undefined);
    logger.info("fix-infra completed", { vm: vm.name, results });
    return NextResponse.json({ vm: vm.name, results });
  } catch (err) {
    return NextResponse.json({ error: `SSH failed: ${String(err)}` }, { status: 500 });
  }
}
