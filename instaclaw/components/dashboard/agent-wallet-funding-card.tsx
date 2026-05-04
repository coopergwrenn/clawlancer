"use client";

/**
 * Agent Wallet Funding Card
 *
 * Sits below BankrWalletCard on the dashboard. Tells the user:
 *   - their agent's wallet needs a small amount of Base ETH (~$0.50) to claim
 *     trading fees, since gas sponsorship isn't live for all users yet
 *   - the wallet address (with copy button) so they can fund it
 *   - their current Base ETH balance (best-effort fetch from public RPC)
 *
 * Only renders when an EVM address is provisioned. Style matches
 * BankrWalletCard exactly (glass + var(--border) + var(--muted) tokens).
 */

import { useEffect, useState } from "react";
import { Fuel, Copy, Check, ExternalLink } from "lucide-react";

interface AgentWalletFundingCardProps {
  evmAddress: string | null;
}

const BASE_RPC = "https://mainnet.base.org";
// Fee-claim transactions on Base are well under a cent in normal conditions;
// $0.50 of ETH is comfortable headroom that survives a moderate gas spike.
const SUGGESTED_FUNDING_USD = 0.50;

export function AgentWalletFundingCard({ evmAddress }: AgentWalletFundingCardProps) {
  const [copied, setCopied] = useState(false);
  const [balanceEth, setBalanceEth] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(true);

  // Best-effort balance fetch — public RPC, no auth required. Failures are
  // silent; we just show the address without a balance row.
  useEffect(() => {
    if (!evmAddress) {
      setBalanceLoading(false);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    (async () => {
      try {
        const res = await fetch(BASE_RPC, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_getBalance",
            params: [evmAddress, "latest"],
            id: 1,
          }),
          signal: ctrl.signal,
        });
        const data = await res.json();
        if (cancelled) return;
        if (typeof data.result === "string") {
          // hex wei → ETH (4 dp). BigInt because balances exceed Number safety.
          // Using BigInt() function form (not n-literal) for older TS targets.
          const wei = BigInt(data.result);
          const tenThousand = BigInt(10000);
          const ten = BigInt(10);
          // 10^18 wei per ETH — keep one extra precision step then back to Number.
          const ethTimes10k = Number((wei * tenThousand) / ten ** BigInt(18));
          setBalanceEth((ethTimes10k / 10000).toFixed(4));
        }
      } catch {
        // swallow — non-critical, address-only mode is fine
      } finally {
        clearTimeout(timer);
        if (!cancelled) setBalanceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [evmAddress]);

  if (!evmAddress) return null;

  const shortAddress = `${evmAddress.slice(0, 6)}...${evmAddress.slice(-4)}`;

  async function handleCopy() {
    if (!evmAddress) return;
    await navigator.clipboard.writeText(evmAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div
      className="glass rounded-xl p-6"
      style={{ border: "1px solid var(--border)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Fuel className="w-4 h-4" style={{ color: "var(--muted)" }} />
          <span className="text-sm font-medium" style={{ color: "var(--muted)" }}>
            Gas Funding
          </span>
        </div>
        {!balanceLoading && balanceEth !== null && (
          <span
            className="text-xs px-2 py-0.5 rounded-full font-mono"
            style={{
              background: "rgba(0,0,0,0.04)",
              border: "1px solid var(--border)",
              color: "var(--muted)",
            }}
          >
            {balanceEth} ETH
          </span>
        )}
      </div>

      {/* Explanation */}
      <p className="text-sm mb-4" style={{ color: "var(--muted)", lineHeight: 1.55 }}>
        To claim trading fees, your agent needs a small amount of ETH on Base for
        gas (~${SUGGESTED_FUNDING_USD.toFixed(2)}). Send ETH on Base to your
        agent&apos;s wallet address below.
      </p>

      {/* Address row — mirror of BankrWalletCard pattern */}
      <div className="flex items-center gap-2 mb-3">
        <code
          className="text-sm px-2 py-1 rounded flex-1 truncate"
          style={{ background: "rgba(0,0,0,0.04)" }}
          title={evmAddress}
        >
          {shortAddress}
        </code>
        <button
          onClick={handleCopy}
          className="px-2.5 py-1 rounded-md text-xs flex items-center gap-1.5 hover:bg-black/5 transition-colors"
          style={{ border: "1px solid var(--border)", color: "var(--muted)" }}
          title="Copy full address"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-green-600" />
              Copied
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              Copy address
            </>
          )}
        </button>
        <a
          href={`https://basescan.org/address/${evmAddress}`}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1.5 rounded hover:bg-black/5 transition-colors"
          title="View on BaseScan"
        >
          <ExternalLink className="w-3.5 h-3.5" style={{ color: "var(--muted)" }} />
        </a>
      </div>

      {/* Subtle footnote */}
      <p
        className="text-xs"
        style={{ color: "var(--muted)", opacity: 0.65 }}
      >
        Auto-gas is coming soon. This step will be handled automatically in a
        future update.
      </p>
    </div>
  );
}
