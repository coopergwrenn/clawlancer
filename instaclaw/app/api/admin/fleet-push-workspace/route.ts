import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { connectSSH } from "@/lib/ssh";
import { WORKSPACE_CAPABILITIES_MD } from "@/lib/agent-intelligence";
import { WORKSPACE_EARN_MD } from "@/lib/earn-md-template";
import { logger } from "@/lib/logger";
import type { VMRecord } from "@/lib/ssh";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CONCURRENCY = 5;
const WS = "/home/openclaw/.openclaw/workspace";

// Wallet summary section — appended to WALLET.md if the "Wallet Summary" heading is missing
const WALLET_SUMMARY = [
  "",
  "## Wallet Summary",
  "- **Bankr Wallet** — your primary wallet for trading, swaps, and token operations. Use the bankr skill.",
  "- **Virtuals Wallet** (if enabled) — separate wallet for Virtuals Protocol marketplace jobs only. Managed by ACP.",
  "- **AgentBook Wallet** — identity-only wallet for World ID on-chain registration. Do NOT use for transactions.",
  "",
  "## Key Rules",
  "- Never share private keys",
  "- Always verify wallet addresses before transactions",
  "- Use the correct wallet for each purpose — do not mix them",
].join("\n");

async function pushToVM(vm: VMRecord): Promise<{ vmId: string; name: string | null; success: boolean; details: string; error?: string }> {
  let ssh;
  try {
    ssh = await connectSSH(vm, { skipDuplicateIPCheck: true });
    const details: string[] = [];

    // 1. CAPABILITIES.md — full overwrite
    const capB64 = Buffer.from(WORKSPACE_CAPABILITIES_MD, "utf-8").toString("base64");
    await ssh.execCommand(`echo '${capB64}' | base64 -d > "${WS}/CAPABILITIES.md"`);
    details.push("CAPABILITIES.md: overwritten");

    // 2. EARN.md — full overwrite
    const earnB64 = Buffer.from(WORKSPACE_EARN_MD, "utf-8").toString("base64");
    await ssh.execCommand(`echo '${earnB64}' | base64 -d > "${WS}/EARN.md"`);
    details.push("EARN.md: overwritten");

    // 3. WALLET.md — patch: add wallet summary if missing
    const walletCheck = await ssh.execCommand(`grep -c "Wallet Summary" "${WS}/WALLET.md" 2>/dev/null || echo 0`);
    const hasWalletSummary = parseInt(walletCheck.stdout.trim()) > 0;

    if (!hasWalletSummary) {
      // Remove old "## Key Rules" section if present (we're replacing it)
      await ssh.execCommand(`sed -i '/^## Key Rules$/,$ d' "${WS}/WALLET.md" 2>/dev/null || true`);
      // Append new summary + rules
      const summaryB64 = Buffer.from(WALLET_SUMMARY, "utf-8").toString("base64");
      await ssh.execCommand(`echo '${summaryB64}' | base64 -d >> "${WS}/WALLET.md"`);
      details.push("WALLET.md: summary patched");
    } else {
      details.push("WALLET.md: already current");
    }

    // 4. SOUL.md — patch: add bankr + wallet routing entries to quick command table
    const soulCheck = await ssh.execCommand(`grep -c "bankr skill" "${WS}/SOUL.md" 2>/dev/null || echo 0`);
    const hasBankrRouting = parseInt(soulCheck.stdout.trim()) > 0;

    if (!hasBankrRouting) {
      // Write a small Python patch script (avoids sed quoting hell with pipes and backticks)
      const patchScript = `
import re
try:
    with open("${WS}/SOUL.md", "r") as f:
        content = f.read()
    # Add bankr routing line after "buy, sell, trade" line
    bankr_line = "| bankr, bankr wallet, bankr balance, bankr swap, token launch | Use the **bankr skill**. Check WALLET.md for your Bankr address. |"
    wallet_line = "| which wallet, what wallet, my wallet, wallet address | Read WALLET.md — lists all wallets and their purposes |"
    # Find the "buy, sell, trade" routing entry and add after it
    marker = "buy, sell, trade"
    if marker in content and "bankr skill" not in content:
        lines = content.split("\\n")
        new_lines = []
        for line in lines:
            new_lines.append(line)
            if marker in line:
                new_lines.append(bankr_line)
                new_lines.append(wallet_line)
        content = "\\n".join(new_lines)
        with open("${WS}/SOUL.md", "w") as f:
            f.write(content)
        print("PATCHED")
    else:
        print("SKIP")
except Exception as e:
    print(f"ERROR: {e}")
`;
      const patchB64 = Buffer.from(patchScript, "utf-8").toString("base64");
      const patchResult = await ssh.execCommand(
        `echo '${patchB64}' | base64 -d > /tmp/ic-soul-patch.py && python3 /tmp/ic-soul-patch.py && rm -f /tmp/ic-soul-patch.py`
      );
      const patchOut = patchResult.stdout.trim();
      details.push(`SOUL.md: ${patchOut === "PATCHED" ? "bankr routing added" : patchOut}`);
    } else {
      details.push("SOUL.md: already has bankr routing");
    }

    // Verify all files exist
    const verify = await ssh.execCommand(
      `test -f "${WS}/CAPABILITIES.md" && test -f "${WS}/EARN.md" && test -f "${WS}/WALLET.md" && test -f "${WS}/SOUL.md" && echo "ALL_OK" || echo "MISSING_FILES"`
    );
    if (!verify.stdout.includes("ALL_OK")) {
      throw new Error("Post-push verification failed: some workspace files missing");
    }
    details.push("verify: ALL_OK");

    return {
      vmId: vm.id,
      name: (vm as unknown as Record<string, unknown>).name as string | null,
      success: true,
      details: details.join(" | "),
    };
  } catch (err) {
    return {
      vmId: vm.id,
      name: (vm as unknown as Record<string, unknown>).name as string | null,
      success: false,
      details: "",
      error: String(err).slice(0, 300),
    };
  } finally {
    ssh?.dispose();
  }
}

async function processBatch(vms: VMRecord[], batchSize: number) {
  const results: Awaited<ReturnType<typeof pushToVM>>[] = [];
  for (let i = 0; i < vms.length; i += batchSize) {
    const batch = vms.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(pushToVM));
    results.push(...batchResults);
    logger.info(`Fleet push workspace: batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(vms.length / batchSize)}`, {
      processed: results.length,
      total: vms.length,
      batchSuccess: batchResults.filter((r) => r.success).length,
      batchFail: batchResults.filter((r) => !r.success).length,
    });
  }
  return results;
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body.dryRun === true;
  const testFirst = body.testFirst === true;
  const vmId = body.vmId as string | undefined;

  const supabase = getSupabase();

  let query = supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, name, health_status")
    .eq("status", "assigned");

  if (vmId) {
    query = query.eq("id", vmId);
  }

  const { data: vms, error } = await query;
  if (error || !vms) {
    return NextResponse.json({ error: "Failed to query VMs", details: error?.message }, { status: 500 });
  }

  logger.info("Fleet push workspace initiated", {
    vmCount: vms.length,
    dryRun,
    testFirst,
    singleVm: vmId ?? null,
  });

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      vmCount: vms.length,
      vms: vms.map((v) => ({ id: v.id, name: v.name, ip: v.ip_address, health: v.health_status })),
    });
  }

  if (testFirst && vms.length > 1) {
    const testVm = vms[0];
    const result = await pushToVM(testVm as unknown as VMRecord);
    return NextResponse.json({
      testFirst: true,
      testResult: result,
      remainingVMs: vms.length - 1,
      message: result.success
        ? `Test VM ${result.name ?? result.vmId} succeeded. Call again without testFirst to push to all ${vms.length - 1} remaining VMs.`
        : "Test VM FAILED. Do NOT proceed. Investigate the error.",
    });
  }

  const results = await processBatch(vms as unknown as VMRecord[], CONCURRENCY);
  const success = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  logger.info("Fleet push workspace complete", {
    total: results.length,
    success: success.length,
    failed: failed.length,
    failedVMs: failed.map((f) => ({ id: f.vmId, name: f.name, error: f.error })),
  });

  return NextResponse.json({
    total: results.length,
    success: success.length,
    failed: failed.length,
    failedDetails: failed,
    successDetails: success.map((s) => ({ vmId: s.vmId, name: s.name, details: s.details })),
  });
}
