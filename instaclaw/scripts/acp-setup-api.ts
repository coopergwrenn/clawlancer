/**
 * acp-setup-api.ts — API-only ACP setup for VM-050.
 *
 * Exercises the full flow: validate existing key → auth if needed →
 * register offering → write config → restart seller → verify.
 *
 * Usage:  npx tsx scripts/acp-setup-api.ts
 *
 * Inline fetch calls (not importing from acp-api.ts) because scripts run
 * via `npx tsx` outside Next.js and @/lib path aliases don't resolve.
 */

import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../.env.local.full") });

// ---------------------------------------------------------------------------
// Constants (mirror acp-api.ts)
// ---------------------------------------------------------------------------

const ACP_AUTH_BASE = "https://acpx.virtuals.io";
const ACP_API_BASE = "https://claw-api.virtuals.io";
const POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 600_000;
const AUTH_REQUEST_LIFETIME_MS = 1_740_000;

const VM_NAME = "instaclaw-vm-050";
const ACP_DIR = "~/virtuals-protocol-acp";
const OFFERING_DIR = `${ACP_DIR}/src/seller/offerings/instaclaw-agent/ai_research_task_completion`;

const XDG = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';

// ---------------------------------------------------------------------------
// Inline API helpers (same logic as acp-api.ts, console.log instead of logger)
// ---------------------------------------------------------------------------

async function validateAcpApiKey(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${ACP_API_BASE}/acp/me`, {
      headers: { "x-api-key": apiKey },
    });
    console.log(`  validateAcpApiKey: HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    console.log(`  validateAcpApiKey: failed — ${err}`);
    return false;
  }
}

async function getAcpAuthUrl(): Promise<{
  authUrl: string;
  requestId: string;
  generatedAt: number;
}> {
  const res = await fetch(`${ACP_AUTH_BASE}/api/auth/lite/auth-url`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`getAcpAuthUrl: HTTP ${res.status} — ${body}`);
  }
  const raw = await res.json();
  // API may wrap response in { data: { ... } }
  const data = raw.data ?? raw;
  const authUrl: string = data.authUrl ?? data.url ?? "";
  const requestId: string = data.requestId ?? data.request_id ?? "";
  if (!authUrl || !requestId) {
    throw new Error(`getAcpAuthUrl: missing fields — ${JSON.stringify(raw)}`);
  }
  return { authUrl, requestId, generatedAt: Date.now() };
}

async function pollAcpAuthStatus(
  requestId: string,
  onAuthUrl?: (url: string, reqId: string) => void,
): Promise<{ sessionToken: string }> {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  let currentRequestId = requestId;
  let requestGeneratedAt = Date.now();

  while (Date.now() < deadline) {
    // Proactive refresh
    if (Date.now() - requestGeneratedAt > AUTH_REQUEST_LIFETIME_MS) {
      console.log("\n  Auth URL expired (proactive refresh)...");
      const fresh = await getAcpAuthUrl();
      currentRequestId = fresh.requestId;
      requestGeneratedAt = fresh.generatedAt;
      onAuthUrl?.(fresh.authUrl, fresh.requestId);
    }

    const res = await fetch(
      `${ACP_AUTH_BASE}/api/auth/lite/auth-status?requestId=${encodeURIComponent(currentRequestId)}`,
    );

    // Reactive refresh
    if (res.status === 410 || res.status === 404) {
      console.log("\n  Auth request expired/gone, refreshing...");
      const fresh = await getAcpAuthUrl();
      currentRequestId = fresh.requestId;
      requestGeneratedAt = fresh.generatedAt;
      onAuthUrl?.(fresh.authUrl, fresh.requestId);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (res.ok) {
      const raw = await res.json();
      // API may wrap response in { data: { ... } }
      const data = raw.data ?? raw;
      const token: string | undefined =
        data.sessionToken ?? data.session_token ?? data.token;
      if (token) {
        console.log("\n  Authenticated!");
        return { sessionToken: token };
      }
    }

    process.stdout.write(".");
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`pollAcpAuthStatus: timed out after ${DEFAULT_TIMEOUT_MS}ms`);
}

async function fetchAcpAgents(sessionToken: string): Promise<any[]> {
  const res = await fetch(`${ACP_AUTH_BASE}/api/auth/lite/agents`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`fetchAcpAgents: HTTP ${res.status} — ${body}`);
  }
  const raw = await res.json();
  // API may wrap response in { data: [...] } or { data: { agents: [...] } }
  const data = raw.data ?? raw;
  return Array.isArray(data) ? data : data.agents ?? [];
}

async function createAcpAgent(
  sessionToken: string,
  name: string,
): Promise<any> {
  const res = await fetch(`${ACP_AUTH_BASE}/api/auth/lite/agents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`createAcpAgent: HTTP ${res.status} — ${body}`);
  }
  const raw = await res.json();
  // API may wrap response in { data: { ... } }
  return raw.data ?? raw;
}

async function registerAcpOffering(
  apiKey: string,
  offering: Record<string, unknown>,
): Promise<void> {
  if (typeof offering.price !== "number") {
    throw new Error(
      `registerAcpOffering: price must be number, got ${typeof offering.price}`,
    );
  }
  const res = await fetch(`${ACP_API_BASE}/acp/job-offerings`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    // API expects body wrapped in { data: { ... } }
    body: JSON.stringify({ data: offering }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`registerAcpOffering: HTTP ${res.status} — ${body}`);
  }
  console.log("  Offering registered/updated successfully");
}

async function getAcpAgentProfile(apiKey: string): Promise<any> {
  const res = await fetch(`${ACP_API_BASE}/acp/me`, {
    headers: { "x-api-key": apiKey },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`getAcpAgentProfile: HTTP ${res.status} — ${body}`);
  }
  const raw = await res.json();
  // API wraps response in { data: { ... } }
  return raw.data ?? raw;
}

// ---------------------------------------------------------------------------
// Offering definition (corrected: `requirement` not `requirementSchema`,
// `jobFee` is number not string)
// ---------------------------------------------------------------------------

const OFFERING = {
  name: "ai_research_task_completion",
  description:
    "General-purpose AI agent capable of research, writing, analysis, code execution, and web search. Completes most tasks in under 5 minutes.",
  price: 1,
  priceV2: { type: "fixed", value: 1 },
  slaMinutes: 5,
  deliverable: "string",
  requiredFunds: false,
  requirement: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Description of the task to complete",
      },
    },
    required: ["task"],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function run(
  ssh: NodeSSH,
  cmd: string,
  label: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const r = await ssh.execCommand(cmd);
  console.log(`\n=== ${label} ===`);
  if (r.stdout) console.log(r.stdout);
  if (r.stderr) console.log("STDERR:", r.stderr);
  return r;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== ACP API-Only Setup ===\n");

  // --- 1. Init ---
  const keyB64 = process.env.SSH_PRIVATE_KEY_B64;
  if (!keyB64) throw new Error("SSH_PRIVATE_KEY_B64 not set");
  const sshKey = Buffer.from(keyB64, "base64").toString("utf-8");

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // --- 2. Fetch VM-050 ---
  console.log(`Fetching ${VM_NAME} from Supabase...`);
  const { data: vm, error } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, gateway_token, assigned_to")
    .eq("name", VM_NAME)
    .single();

  if (error || !vm) {
    throw new Error(`Failed to fetch ${VM_NAME}: ${error?.message ?? "not found"}`);
  }
  console.log(`  Found: ${vm.name} @ ${vm.ip_address} (assigned: ${vm.assigned_to ?? "none"})`);

  // --- 3. SSH in, read config.json ---
  console.log("\nConnecting via SSH...");
  const ssh = new NodeSSH();
  await ssh.connect({
    host: vm.ip_address,
    port: vm.ssh_port || 22,
    username: vm.ssh_user || "openclaw",
    privateKey: sshKey,
    readyTimeout: 10000,
  });
  console.log("  Connected.");

  const configResult = await ssh.execCommand(`cat ${ACP_DIR}/config.json 2>/dev/null`);
  let existingApiKey: string | null = null;
  let existingConfig: any = null;

  if (configResult.code === 0 && configResult.stdout.trim()) {
    try {
      existingConfig = JSON.parse(configResult.stdout.trim());
      existingApiKey = existingConfig.LITE_AGENT_API_KEY ?? null;
      console.log(`  Existing config.json found. LITE_AGENT_API_KEY: ${existingApiKey ? existingApiKey.slice(0, 12) + "..." : "(none)"}`);
    } catch {
      console.log("  config.json exists but is not valid JSON — will recreate");
    }
  } else {
    console.log("  No config.json found on VM");
  }

  // --- 4. Validate existing key ---
  let apiKey: string | null = existingApiKey;
  let needsAuth = true;

  if (apiKey) {
    console.log("\nValidating existing API key...");
    const valid = await validateAcpApiKey(apiKey);
    if (valid) {
      console.log("  Key is valid — skipping auth flow");
      needsAuth = false;
    } else {
      console.log("  Key is invalid/expired — need fresh auth");
      apiKey = null;
    }
  }

  // --- 5–7. Auth flow (only if needed) ---
  let sessionToken: string | null = null;

  if (needsAuth) {
    // Step 5: Get auth URL
    console.log("\nGenerating auth URL...");
    const auth = await getAcpAuthUrl();
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║  >>> OPEN THIS URL IN YOUR BROWSER <<<                      ║");
    console.log("╚══════════════════════════════════════════════════════════════╝");
    console.log(`\n  ${auth.authUrl}\n`);

    // Step 6: Poll for auth
    console.log("Waiting for authentication (polling every 5s, 10 min timeout)...");
    const result = await pollAcpAuthStatus(auth.requestId, (newUrl, _reqId) => {
      console.log("\n  New auth URL (previous expired):");
      console.log(`  ${newUrl}\n`);
    });
    sessionToken = result.sessionToken;

    // Step 7: Fetch or create agent
    console.log("\nFetching agents...");
    const agents = await fetchAcpAgents(sessionToken);
    console.log(`  Found ${agents.length} agent(s)`);

    let agent: any;
    if (agents.length > 0) {
      agent = agents[0];
      console.log(`  Using existing agent: ${agent.name ?? agent.id}`);
    } else {
      console.log("  No agents found — creating 'InstaClaw Agent'...");
      agent = await createAcpAgent(sessionToken, "InstaClaw Agent");
      console.log(`  Created agent: ${agent.name ?? agent.id}`);
    }

    apiKey = agent.apiKey ?? agent.api_key ?? agent.key;
    if (!apiKey) {
      console.error("  ERROR: Agent response has no apiKey field:", JSON.stringify(agent, null, 2));
      throw new Error("No API key in agent response");
    }
    console.log(`  API key: ${apiKey.slice(0, 12)}...`);
  }

  if (!apiKey) {
    throw new Error("No API key available after auth flow");
  }

  // --- 8. Write config to VM (only if auth was needed) ---
  if (needsAuth) {
    console.log("\nWriting config files to VM...");

    // config.json — match the format `acp setup` produces
    const configJson = JSON.stringify(
      {
        SESSION_TOKEN: sessionToken ? { token: sessionToken } : undefined,
        LITE_AGENT_API_KEY: apiKey,
        agents: [], // populated by CLI if it runs later
      },
      null,
      2,
    );
    const configB64 = Buffer.from(configJson, "utf-8").toString("base64");
    await run(
      ssh,
      `echo '${configB64}' | base64 -d > ${ACP_DIR}/config.json`,
      "Write config.json",
    );

    // .env — all 4 ACP env vars the CLI would write
    const envContent = [
      `ACP_API_URL=${ACP_API_BASE}`,
      `ACP_AUTH_URL=${ACP_AUTH_BASE}`,
      `ACP_SOCKET_URL=wss://claw-api.virtuals.io`,
      `ACP_BOUNTY_API_URL=https://claw-api.virtuals.io`,
      `LITE_AGENT_API_KEY=${apiKey}`,
    ].join("\n");
    const envB64 = Buffer.from(envContent, "utf-8").toString("base64");
    await run(
      ssh,
      `echo '${envB64}' | base64 -d > ${ACP_DIR}/.env`,
      "Write .env",
    );
  }

  // --- 9. Register offering ---
  console.log("\nRegistering offering via API...");
  try {
    await registerAcpOffering(apiKey, OFFERING);
  } catch (err: any) {
    console.log(`  WARNING: Offering registration failed — ${err.message}`);
    console.log("  (Continuing — offering may already be registered)");
  }

  // --- 10. Ensure offering files on disk ---
  console.log("\nEnsuring offering files on disk...");
  await run(ssh, `mkdir -p ${OFFERING_DIR}`, "Create offering dir");

  const offeringB64 = Buffer.from(JSON.stringify(OFFERING, null, 2), "utf-8").toString("base64");
  await run(
    ssh,
    `echo '${offeringB64}' | base64 -d > ${OFFERING_DIR}/offering.json`,
    "Write offering.json",
  );

  // Check if handlers.ts exists (don't overwrite — it may have custom logic)
  const handlersCheck = await ssh.execCommand(`test -f ${OFFERING_DIR}/handlers.ts && echo "exists" || echo "missing"`);
  if (handlersCheck.stdout.trim() === "missing") {
    console.log("  handlers.ts missing — this is expected if the offering was never initialized via CLI.");
    console.log("  The seller runtime needs handlers.ts to serve this offering.");
    console.log("  Skipping write (handlers.ts should be provisioned via installAgdpSkill).");
  } else {
    console.log("  handlers.ts already exists — OK");
  }

  // --- 11. Restart seller ---
  console.log("\nRestarting seller service...");

  // Kill any old seller processes first (match the actual runtime command)
  await run(ssh, "pkill -f 'seller/runtime/seller' 2>/dev/null; sleep 1; echo 'killed old processes'", "Kill old sellers");

  // Detect which systemd services exist
  const serveCheck = await ssh.execCommand(
    `${XDG} && systemctl --user cat acp-serve.service >/dev/null 2>&1 && echo "acp-serve" || echo "none"`,
  );
  const sellerCheck = await ssh.execCommand(
    `${XDG} && systemctl --user cat acp-seller.service >/dev/null 2>&1 && echo "acp-seller" || echo "none"`,
  );

  const hasServe = serveCheck.stdout.trim() === "acp-serve";
  const hasSeller = sellerCheck.stdout.trim() === "acp-seller";

  // `acp serve start` daemonizes (forks a background seller.ts process then exits).
  // acp-serve.service (Type=simple) will show "inactive" after the launcher exits,
  // even though the seller daemon is running. acp-seller.service (Restart=always)
  // keeps the daemonized process alive. Restart whichever exists.
  if (hasServe) {
    console.log("  Restarting acp-serve.service (canonical)...");
    await run(ssh, `${XDG} && systemctl --user daemon-reload && systemctl --user restart acp-serve.service`, "Restart acp-serve");
  }
  if (hasSeller) {
    console.log("  Restarting acp-seller.service (VM-050 manual fix)...");
    await run(ssh, `${XDG} && systemctl --user daemon-reload && systemctl --user restart acp-seller.service`, "Restart acp-seller");
  }
  if (!hasServe && !hasSeller) {
    console.log("  No systemd seller service found — skipping restart.");
    console.log("  You may need to run installAgdpSkill() to create the service first.");
  }

  // Wait for seller daemon to start
  console.log("  Waiting 5s for seller daemon...");
  await sleep(5000);

  // --- 12. Verify ---
  console.log("\n=== VERIFICATION ===\n");

  // Check seller status via ACP CLI (the authoritative source)
  const NVM = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"';
  const serveStatus = await ssh.execCommand(`${NVM} && cd ~/virtuals-protocol-acp && npx tsx bin/acp.ts serve status 2>&1`);
  const sellerRunning = serveStatus.stdout.includes("Running");
  console.log(`  Seller runtime:  ${sellerRunning ? "RUNNING" : "NOT RUNNING"}`);
  if (sellerRunning) {
    const pidMatch = serveStatus.stdout.match(/PID\s+(\d+)/);
    if (pidMatch) console.log(`    PID: ${pidMatch[1]}`);
  } else {
    console.log(`    Output: ${serveStatus.stdout.trim()}`);
  }

  // Call GET /acp/me to confirm profile + offerings
  try {
    const profile = await getAcpAgentProfile(apiKey);
    const offeringCount = Array.isArray(profile.jobs) ? profile.jobs.length : 0;
    console.log(`  Agent name:     ${profile.name ?? "(unknown)"}`);
    console.log(`  Wallet:         ${profile.walletAddress ?? "(unknown)"}`);
    console.log(`  Token:          ${profile.token?.symbol ?? "(none)"}`);
    console.log(`  Offerings:      ${offeringCount}`);
  } catch (err: any) {
    console.log(`  WARNING: Profile check failed — ${err.message}`);
  }

  ssh.dispose();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
