/**
 * Fleet-wide auth-profiles audit: SSH into every assigned all-inclusive VM
 * and verify auth-profiles.json has the correct baseUrl pointing to the proxy.
 *
 * Catches Chidi-type misconfigurations where all-inclusive VMs are missing
 * baseUrl or have it pointing to the wrong URL.
 *
 * Usage: npx tsx scripts/_audit-auth-profiles.ts [--dry-run] [--fix]
 *   --dry-run: Show what would be checked, don't SSH
 *   --fix:     Auto-fix misconfigured VMs (rewrites auth-profiles.json + restarts gateway)
 */
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load env
const envContent = readFileSync(resolve(".", ".env.local"), "utf-8");
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) {
    process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
  }
}

// Also load SSH key
try {
  const sshEnv = readFileSync(resolve(".", ".env.ssh-key"), "utf-8");
  for (const line of sshEnv.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
} catch {
  // .env.ssh-key may not exist, SSH_PRIVATE_KEY_B64 might be in .env.local
}

const EXPECTED_BASE_URL = "https://instaclaw.io/api/gateway";
const dryRun = process.argv.includes("--dry-run");
const autoFix = process.argv.includes("--fix");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface AuditResult {
  vmId: string;
  vmName: string;
  ip: string;
  status: "ok" | "missing_file" | "missing_baseUrl" | "wrong_baseUrl" | "token_mismatch" | "ssh_failed" | "invalid_json";
  details?: string;
  fixed?: boolean;
}

async function main() {
  console.log(`Auth-profiles fleet audit${dryRun ? " (DRY RUN)" : ""}${autoFix ? " (AUTO-FIX)" : ""}\n`);

  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, name, gateway_token, api_mode, assigned_to")
    .eq("status", "assigned")
    .eq("api_mode", "all_inclusive")
    .not("ip_address", "is", null)
    .not("gateway_token", "is", null);

  if (error) {
    console.error("Failed to query VMs:", error.message);
    process.exit(1);
  }

  if (!vms?.length) {
    console.log("No assigned all-inclusive VMs found.");
    return;
  }

  console.log(`Found ${vms.length} assigned all-inclusive VM(s) to audit.\n`);

  if (dryRun) {
    for (const vm of vms) {
      console.log(`  Would audit: ${vm.name ?? vm.id} (${vm.ip_address})`);
    }
    console.log(`\nRe-run without --dry-run to perform the audit.`);
    return;
  }

  const key = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
  const results: AuditResult[] = [];

  for (const vm of vms) {
    const label = vm.name ?? vm.id;
    process.stdout.write(`  ${label} (${vm.ip_address}) ... `);

    const ssh = new NodeSSH();
    try {
      await ssh.connect({
        host: vm.ip_address,
        port: vm.ssh_port ?? 22,
        username: vm.ssh_user ?? "openclaw",
        privateKey: key,
        readyTimeout: 10000,
      });

      // Read auth-profiles.json
      const readResult = await ssh.execCommand(
        "cat ~/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null"
      );

      if (readResult.code !== 0 || !readResult.stdout.trim()) {
        console.log("MISSING FILE");
        results.push({ vmId: vm.id, vmName: label, ip: vm.ip_address, status: "missing_file" });

        if (autoFix) {
          const fixed = await fixAuthProfile(ssh, vm.gateway_token, label);
          results[results.length - 1].fixed = fixed;
        }
        ssh.dispose();
        continue;
      }

      let authProfile: any;
      try {
        authProfile = JSON.parse(readResult.stdout);
      } catch {
        console.log("INVALID JSON");
        results.push({ vmId: vm.id, vmName: label, ip: vm.ip_address, status: "invalid_json", details: readResult.stdout.slice(0, 100) });

        if (autoFix) {
          const fixed = await fixAuthProfile(ssh, vm.gateway_token, label);
          results[results.length - 1].fixed = fixed;
        }
        ssh.dispose();
        continue;
      }

      const profile = authProfile?.profiles?.["anthropic:default"];
      if (!profile) {
        console.log("MISSING PROFILE");
        results.push({ vmId: vm.id, vmName: label, ip: vm.ip_address, status: "missing_baseUrl", details: "No anthropic:default profile" });

        if (autoFix) {
          const fixed = await fixAuthProfile(ssh, vm.gateway_token, label);
          results[results.length - 1].fixed = fixed;
        }
        ssh.dispose();
        continue;
      }

      // Check baseUrl
      const baseUrl = profile.baseUrl;
      if (!baseUrl) {
        console.log("MISSING baseUrl");
        results.push({ vmId: vm.id, vmName: label, ip: vm.ip_address, status: "missing_baseUrl", details: "baseUrl is null/undefined" });

        if (autoFix) {
          const fixed = await fixAuthProfile(ssh, vm.gateway_token, label);
          results[results.length - 1].fixed = fixed;
        }
        ssh.dispose();
        continue;
      }

      if (baseUrl !== EXPECTED_BASE_URL) {
        console.log(`WRONG baseUrl: ${baseUrl}`);
        results.push({ vmId: vm.id, vmName: label, ip: vm.ip_address, status: "wrong_baseUrl", details: `Got: ${baseUrl}, Expected: ${EXPECTED_BASE_URL}` });

        if (autoFix) {
          const fixed = await fixAuthProfile(ssh, vm.gateway_token, label);
          results[results.length - 1].fixed = fixed;
        }
        ssh.dispose();
        continue;
      }

      // Check key matches DB gateway_token
      const profileKey = profile.key;
      if (profileKey !== vm.gateway_token) {
        console.log("TOKEN MISMATCH");
        results.push({ vmId: vm.id, vmName: label, ip: vm.ip_address, status: "token_mismatch", details: `File key prefix: ${profileKey?.slice(0, 8)}..., DB token prefix: ${vm.gateway_token.slice(0, 8)}...` });

        if (autoFix) {
          const fixed = await fixAuthProfile(ssh, vm.gateway_token, label);
          results[results.length - 1].fixed = fixed;
        }
        ssh.dispose();
        continue;
      }

      console.log("OK");
      results.push({ vmId: vm.id, vmName: label, ip: vm.ip_address, status: "ok" });
      ssh.dispose();
    } catch (err: any) {
      console.log(`SSH FAILED: ${err.message || err}`);
      results.push({ vmId: vm.id, vmName: label, ip: vm.ip_address, status: "ssh_failed", details: String(err.message || err) });
      ssh.dispose();
    }
  }

  // Summary
  const ok = results.filter(r => r.status === "ok").length;
  const issues = results.filter(r => r.status !== "ok" && r.status !== "ssh_failed");
  const sshFailed = results.filter(r => r.status === "ssh_failed").length;
  const fixed = results.filter(r => r.fixed).length;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`AUDIT RESULTS`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Total VMs audited:  ${results.length}`);
  console.log(`  OK:                 ${ok}`);
  console.log(`  Misconfigured:      ${issues.length}`);
  console.log(`  SSH unreachable:    ${sshFailed}`);
  if (autoFix) {
    console.log(`  Auto-fixed:         ${fixed}`);
  }

  if (issues.length > 0) {
    console.log(`\nMisconfigured VMs:`);
    for (const r of issues) {
      console.log(`  ${r.vmName} (${r.ip}): ${r.status}${r.details ? ` — ${r.details}` : ""}${r.fixed ? " [FIXED]" : ""}`);
    }
  }

  if (issues.length > 0 && !autoFix) {
    console.log(`\nRe-run with --fix to auto-repair misconfigured VMs.`);
  }
}

async function fixAuthProfile(ssh: NodeSSH, gatewayToken: string, label: string): Promise<boolean> {
  try {
    process.stdout.write(`    -> Fixing ${label}... `);

    const authProfile = JSON.stringify({
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: gatewayToken,
          baseUrl: EXPECTED_BASE_URL,
        },
      },
    });
    const authB64 = Buffer.from(authProfile).toString("base64");

    // Ensure directory exists
    await ssh.execCommand("mkdir -p ~/.openclaw/agents/main/agent");

    // Write auth-profiles.json
    const writeResult = await ssh.execCommand(
      `echo '${authB64}' | base64 -d > ~/.openclaw/agents/main/agent/auth-profiles.json`
    );
    if (writeResult.code !== 0) {
      console.log("WRITE FAILED");
      return false;
    }

    // Restart gateway to pick up new auth
    await ssh.execCommand("systemctl --user restart openclaw-gateway 2>/dev/null || true");

    // Wait and verify
    await new Promise(r => setTimeout(r, 8000));
    const healthResult = await ssh.execCommand(
      "systemctl --user is-active openclaw-gateway 2>&1"
    );
    const isActive = healthResult.stdout.trim() === "active";

    if (isActive) {
      console.log("FIXED + HEALTHY");
      return true;
    } else {
      console.log("FIXED but gateway not active");
      return true; // File was fixed even if gateway needs more time
    }
  } catch (err: any) {
    console.log(`FIX FAILED: ${err.message || err}`);
    return false;
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
