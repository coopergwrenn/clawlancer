/**
 * _verify-ape-capital-vm379.ts — Verify Ape Capital's VM has latest changes
 *
 * Checks:
 * 1. DB state: vm-379 status, manifest version, health, assigned user
 * 2. SSH checks: deliver_file.sh, MEMORY.md, active-tasks.md, config values
 * 3. Creates memory/active-tasks.md if missing
 *
 * Usage: npx tsx instaclaw/scripts/_verify-ape-capital-vm379.ts
 */

import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

const BASE_URL = "https://instaclaw.io";
const adminKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function sshExec(vmId: string, command: string): Promise<{ stdout: string; stderr: string; error?: string }> {
  const res = await fetch(`${BASE_URL}/api/vm/ssh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": adminKey,
    },
    body: JSON.stringify({ vmId, command }),
  });
  return res.json();
}

async function main() {
  console.log("=== Ape Capital VM-379 Verification ===\n");

  // Step 1: DB query
  console.log("--- Step 1: Database State ---");
  const { data: vm, error } = await supabase
    .from("instaclaw_vms")
    .select("id, name, status, manifest_version, health_status, assigned_user_id, ip_address, gateway_url")
    .eq("name", "vm-379")
    .single();

  if (error || !vm) {
    console.error("Failed to find vm-379:", error?.message || "not found");
    process.exit(1);
  }

  console.log(`  Name: ${vm.name}`);
  console.log(`  Status: ${vm.status}`);
  console.log(`  Manifest Version: ${vm.manifest_version}`);
  console.log(`  Health: ${vm.health_status}`);
  console.log(`  Assigned User: ${vm.assigned_user_id || "NONE"}`);
  console.log(`  IP: ${vm.ip_address}`);
  console.log(`  Gateway URL: ${vm.gateway_url}`);
  console.log();

  // Step 2: SSH checks
  console.log("--- Step 2: SSH Checks ---");
  const vmId = vm.id;

  const checks = [
    { label: "deliver_file.sh exists + executable", cmd: "test -x ~/scripts/deliver_file.sh && echo 'OK' || echo 'MISSING'" },
    { label: "notify_user.sh exists + executable", cmd: "test -x ~/scripts/notify_user.sh && echo 'OK' || echo 'MISSING'" },
    { label: "MEMORY.md size", cmd: "wc -c < ~/.openclaw/workspace/MEMORY.md 2>/dev/null || echo '0'" },
    { label: "active-tasks.md exists", cmd: "ls ~/.openclaw/workspace/memory/active-tasks.md 2>/dev/null && echo 'EXISTS' || echo 'MISSING'" },
    { label: "memoryFlush.enabled", cmd: "openclaw config get agents.defaults.compaction.memoryFlush.enabled 2>/dev/null || echo 'NOT SET'" },
    { label: "memorySearch.enabled", cmd: "openclaw config get agents.defaults.memorySearch.enabled 2>/dev/null || echo 'NOT SET'" },
    { label: "Gateway status", cmd: "export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user is-active openclaw-gateway 2>/dev/null || echo 'unknown'" },
    { label: "Health endpoint", cmd: "curl -sf http://localhost:18789/health 2>&1 | head -200 || echo 'UNREACHABLE'" },
  ];

  const results: Record<string, string> = {};

  for (const check of checks) {
    try {
      const data = await sshExec(vmId, check.cmd);
      const output = (data.stdout || data.stderr || data.error || "").trim();
      results[check.label] = output;
      console.log(`  ${check.label}: ${output.slice(0, 200)}`);
    } catch (e: any) {
      results[check.label] = `FETCH ERROR: ${e.message}`;
      console.log(`  ${check.label}: FETCH ERROR: ${e.message}`);
    }
  }

  // Step 3: Create active-tasks.md if missing
  console.log("\n--- Step 3: Create active-tasks.md if missing ---");
  if (results["active-tasks.md exists"]?.includes("MISSING")) {
    const template = `# Active Tasks

<!-- Track async tasks and pending notifications here -->
<!-- Status values: pending-notification | notification-failed | completed | notification-abandoned -->
`;
    try {
      const mkdirResult = await sshExec(vmId, "mkdir -p ~/.openclaw/workspace/memory");
      const writeResult = await sshExec(
        vmId,
        `cat > ~/.openclaw/workspace/memory/active-tasks.md << 'TASKEOF'
${template}
TASKEOF`,
      );
      console.log("  Created memory/active-tasks.md with template header");
      // Verify
      const verify = await sshExec(vmId, "cat ~/.openclaw/workspace/memory/active-tasks.md");
      console.log("  Verified:", (verify.stdout || "").slice(0, 100));
    } catch (e: any) {
      console.log("  Failed to create:", e.message);
    }
  } else {
    console.log("  active-tasks.md already exists — skipping creation");
  }

  // Summary
  console.log("\n=== Summary ===");
  const issues: string[] = [];
  if (vm.status !== "assigned") issues.push(`Status is ${vm.status}, expected assigned`);
  if (vm.health_status !== "healthy") issues.push(`Health is ${vm.health_status}`);
  if (results["deliver_file.sh exists + executable"] !== "OK") issues.push("deliver_file.sh missing or not executable");
  if (results["notify_user.sh exists + executable"] !== "OK") issues.push("notify_user.sh missing or not executable (expected until manifest v36 deploys)");
  if (results["MEMORY.md size"] === "0") issues.push("MEMORY.md is empty");

  if (issues.length === 0) {
    console.log("  All checks passed!");
  } else {
    console.log("  Issues found:");
    for (const issue of issues) {
      console.log(`    - ${issue}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
