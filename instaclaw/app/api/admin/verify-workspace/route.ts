import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { connectSSH } from "@/lib/ssh";
import type { VMRecord } from "@/lib/ssh";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const WS = "/home/openclaw/.openclaw/workspace";
const SCRIPTS = "/home/openclaw/.openclaw/scripts";

interface CheckResult {
  vmId: string;
  name: string;
  tier: string;
  health: string;
  capWalletRouting: boolean;
  earnChannel1Oracle: boolean;
  earnChannel3Virtuals: boolean;
  walletSummary: boolean;
  walletDoNotUse: boolean;
  soulBankrRouting: boolean;
  soulWhichWallet: boolean;
  soulMemoryFiling: boolean;
  stripThinkingMinMsgs: boolean;
  cronCount: number;
  allPass: boolean;
}

async function checkVM(vm: VMRecord & { tier?: string }): Promise<CheckResult> {
  const ssh = await connectSSH(vm, { skipDuplicateIPCheck: true });
  try {
    // Run all checks in a single SSH command for speed
    const script = `
echo "CAP_WALLET_ROUTING=$(grep -c 'Wallet Routing — READ THIS' "${WS}/CAPABILITIES.md" 2>/dev/null || echo 0)"
echo "EARN_CH1_ORACLE=$(grep -c 'Oracle Wallet' "${WS}/EARN.md" 2>/dev/null || echo 0)"
echo "EARN_CH3_VIRTUALS=$(grep -c 'Virtuals/ACP Wallet' "${WS}/EARN.md" 2>/dev/null || echo 0)"
echo "WALLET_SUMMARY=$(grep -c 'Wallet Summary' "${WS}/WALLET.md" 2>/dev/null || echo 0)"
echo "WALLET_DONOT=$(grep -c 'do not mix them' "${WS}/WALLET.md" 2>/dev/null || echo 0)"
echo "SOUL_BANKR=$(grep -c 'bankr skill' "${WS}/SOUL.md" 2>/dev/null || echo 0)"
echo "SOUL_WHICH=$(grep -c 'which wallet' "${WS}/SOUL.md" 2>/dev/null || echo 0)"
echo "SOUL_MEMORY_FILING=$(grep -c 'MEMORY_FILING_SYSTEM' "${WS}/SOUL.md" 2>/dev/null || echo 0)"
echo "STRIP_MIN_MSGS=$(grep -c '_MIN_MSGS_FOR_SUMMARY = 1' "${SCRIPTS}/strip-thinking.py" 2>/dev/null || echo 0)"
echo "CRON_COUNT=$(crontab -l 2>/dev/null | grep -v '^#' | grep -v '^$' | wc -l)"
`;
    const result = await ssh.execCommand(script);
    const out = result.stdout;

    const get = (key: string): number => {
      const match = out.match(new RegExp(`${key}=(\\d+)`));
      return match ? parseInt(match[1]) : 0;
    };

    const capWalletRouting = get("CAP_WALLET_ROUTING") > 0;
    const earnChannel1Oracle = get("EARN_CH1_ORACLE") > 0;
    const earnChannel3Virtuals = get("EARN_CH3_VIRTUALS") > 0;
    const walletSummary = get("WALLET_SUMMARY") > 0;
    const walletDoNotUse = get("WALLET_DONOT") > 0;
    const soulBankrRouting = get("SOUL_BANKR") > 0;
    const soulWhichWallet = get("SOUL_WHICH") > 0;
    const soulMemoryFiling = get("SOUL_MEMORY_FILING") > 0;
    const stripThinkingMinMsgs = get("STRIP_MIN_MSGS") > 0;
    const cronCount = get("CRON_COUNT");

    const allPass =
      capWalletRouting &&
      earnChannel1Oracle &&
      earnChannel3Virtuals &&
      walletSummary &&
      walletDoNotUse &&
      soulBankrRouting &&
      soulWhichWallet &&
      soulMemoryFiling &&
      stripThinkingMinMsgs &&
      cronCount >= 7;

    return {
      vmId: vm.id,
      name: (vm as unknown as Record<string, unknown>).name as string,
      tier: vm.tier ?? "unknown",
      health: (vm as unknown as Record<string, unknown>).health_status as string,
      capWalletRouting,
      earnChannel1Oracle,
      earnChannel3Virtuals,
      walletSummary,
      walletDoNotUse,
      soulBankrRouting,
      soulWhichWallet,
      soulMemoryFiling,
      stripThinkingMinMsgs,
      cronCount,
      allPass,
    };
  } finally {
    ssh.dispose();
  }
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const count = Math.min(body.count ?? 10, 20);

  const supabase = getSupabase();

  // Get a random sample of assigned VMs across tiers
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, name, tier, health_status")
    .eq("status", "assigned")
    .not("health_status", "eq", "suspended");

  if (!vms || vms.length === 0) {
    return NextResponse.json({ error: "No assigned VMs found" }, { status: 404 });
  }

  // Shuffle and take `count` VMs, trying to get tier diversity
  const shuffled = vms.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, count);

  const results: CheckResult[] = [];
  // Process 5 at a time
  for (let i = 0; i < selected.length; i += 5) {
    const batch = selected.slice(i, i + 5);
    const batchResults = await Promise.allSettled(
      batch.map((vm) => checkVM(vm as unknown as VMRecord & { tier?: string }))
    );
    for (const r of batchResults) {
      if (r.status === "fulfilled") {
        results.push(r.value);
      } else {
        results.push({
          vmId: "unknown",
          name: "SSH_FAILED",
          tier: "unknown",
          health: "unknown",
          capWalletRouting: false,
          earnChannel1Oracle: false,
          earnChannel3Virtuals: false,
          walletSummary: false,
          walletDoNotUse: false,
          soulBankrRouting: false,
          soulWhichWallet: false,
          soulMemoryFiling: false,
          stripThinkingMinMsgs: false,
          cronCount: 0,
          allPass: false,
        });
      }
    }
  }

  const allPass = results.every((r) => r.allPass);

  return NextResponse.json({
    checked: results.length,
    allPass,
    passCount: results.filter((r) => r.allPass).length,
    failCount: results.filter((r) => !r.allPass).length,
    results,
  });
}
