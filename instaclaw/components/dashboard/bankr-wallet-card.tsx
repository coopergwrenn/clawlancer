"use client";

import { useState, useEffect } from "react";
import { Wallet, ExternalLink, Copy, Check, Sparkles, TrendingUp, TrendingDown } from "lucide-react";

interface BankrWalletCardProps {
  walletId: string | null;
  evmAddress: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenizationPlatform: string | null;
}

interface TokenPrice {
  priceUsd: string | null;
  priceChange24h: number | null;
  volume24h: number | null;
}

// Lightweight confetti burst — gold/amber themed, Stripe-style
function fireConfetti() {
  import("canvas-confetti").then((mod) => {
    const confetti = mod.default;
    const gold = ["#f5a623", "#d4911d", "#fbbf24", "#f59e0b", "#fff7ed"];

    // Center burst
    confetti({
      particleCount: 80,
      spread: 70,
      origin: { y: 0.5, x: 0.5 },
      colors: gold,
      ticks: 120,
      gravity: 0.8,
      scalar: 1.1,
      shapes: ["circle", "square"],
      disableForReducedMotion: true,
    });

    // Delayed side bursts for depth
    setTimeout(() => {
      confetti({
        particleCount: 40,
        angle: 60,
        spread: 55,
        origin: { x: 0.15, y: 0.55 },
        colors: gold,
        ticks: 100,
        gravity: 0.9,
        disableForReducedMotion: true,
      });
      confetti({
        particleCount: 40,
        angle: 120,
        spread: 55,
        origin: { x: 0.85, y: 0.55 },
        colors: gold,
        ticks: 100,
        gravity: 0.9,
        disableForReducedMotion: true,
      });
    }, 150);
  }).catch(() => {});
}

export function BankrWalletCard({
  walletId,
  evmAddress,
  tokenAddress,
  tokenSymbol,
  tokenizationPlatform,
}: BankrWalletCardProps) {
  const [copied, setCopied] = useState(false);
  const [tokenizing, setTokenizing] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [tokenSym, setTokenSym] = useState("");
  const [showTokenForm, setShowTokenForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launchSuccess, setLaunchSuccess] = useState<string | null>(null);
  const [tokenPrice, setTokenPrice] = useState<TokenPrice | null>(null);

  // Fetch live token price from DexScreener (client-side, no auth needed)
  // Must be before any early returns — React hooks must be called unconditionally
  useEffect(() => {
    if (!tokenAddress) return;
    const fetchPrice = async () => {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
        const data = await res.json();
        if (data.pairs?.length > 0) {
          const pair = data.pairs[0];
          setTokenPrice({
            priceUsd: pair.priceUsd ?? null,
            priceChange24h: pair.priceChange?.h24 ?? null,
            volume24h: pair.volume?.h24 ?? null,
          });
        }
      } catch { /* non-critical */ }
    };
    fetchPrice();
    const interval = setInterval(fetchPrice, 60_000);
    return () => clearInterval(interval);
  }, [tokenAddress]);

  // Don't render if no Bankr wallet provisioned
  if (!walletId || !evmAddress) return null;

  const shortAddress = `${evmAddress.slice(0, 6)}...${evmAddress.slice(-4)}`;
  const hasToken = !!tokenAddress;

  async function handleCopy() {
    if (!evmAddress) return;
    await navigator.clipboard.writeText(evmAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleTokenize() {
    if (!tokenName.trim() || !tokenSym.trim()) {
      setError("Token name and symbol are required");
      return;
    }
    setError(null);
    setTokenizing(true);
    try {
      const res = await fetch("/api/bankr/tokenize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token_name: tokenName.trim(),
          token_symbol: tokenSym.trim().toUpperCase(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Tokenization failed");
        return;
      }
      // Celebration: confetti + success message, then reload
      const symbol = tokenSym.trim().toUpperCase();
      setLaunchSuccess(symbol);
      fireConfetti();
      setTimeout(() => window.location.reload(), 2500);
    } catch {
      setError("Network error — try again");
    } finally {
      setTokenizing(false);
    }
  }

  // ── Celebration overlay ──
  if (launchSuccess) {
    return (
      <div
        className="glass rounded-xl p-8 flex flex-col items-center justify-center text-center"
        style={{ border: "1px solid var(--border)", minHeight: 160 }}
      >
        <div
          className="text-3xl font-bold mb-2"
          style={{
            background: "linear-gradient(135deg, #f5a623, #fbbf24)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          ${launchSuccess} is live!
        </div>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Your token is now trading on Base
        </p>
      </div>
    );
  }

  return (
    <div
      className="glass rounded-xl p-6"
      style={{ border: "1px solid var(--border)" }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Wallet className="w-4 h-4" style={{ color: "var(--muted)" }} />
          <span className="text-sm font-medium" style={{ color: "var(--muted)" }}>
            Agent Wallet
          </span>
        </div>
        <a
          href="https://bankr.bot"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs flex items-center gap-1"
          style={{ color: "var(--muted)" }}
        >
          Powered by Bankr
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      {/* Wallet address */}
      <div className="flex items-center gap-2 mb-3">
        <code
          className="text-sm px-2 py-1 rounded"
          style={{ background: "rgba(0,0,0,0.04)" }}
        >
          {shortAddress}
        </code>
        <button
          onClick={handleCopy}
          className="p-1 rounded hover:bg-black/5 transition-colors"
          title="Copy full address"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-green-600" />
          ) : (
            <Copy className="w-3.5 h-3.5" style={{ color: "var(--muted)" }} />
          )}
        </button>
        <a
          href={`https://basescan.org/address/${evmAddress}`}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1 rounded hover:bg-black/5 transition-colors"
          title="View on BaseScan"
        >
          <ExternalLink className="w-3.5 h-3.5" style={{ color: "var(--muted)" }} />
        </a>
      </div>

      <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>
        Base mainnet
      </p>

      {/* Token status or tokenize button */}
      {tokenizationPlatform === "virtuals" && !hasToken ? (
        <div
          className="rounded-lg p-3"
          style={{ background: "rgba(0,0,0,0.03)", border: "1px solid var(--border)" }}
        >
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Your agent is tokenized on Virtuals Protocol. Only one tokenization platform is allowed per agent.
          </p>
        </div>
      ) : hasToken ? (
        /* ── POST-LAUNCH TOKEN DASHBOARD ── */
        <div
          className="rounded-xl overflow-hidden"
          style={{ background: "rgba(0,0,0,0.03)", border: "1px solid var(--border)" }}
        >
          {/* Token header */}
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
                  style={{
                    background: "linear-gradient(135deg, #f5a623, #d4911d)",
                    color: "white",
                    textShadow: "0 1px 1px rgba(0,0,0,0.15)",
                  }}
                >
                  {tokenSymbol?.slice(0, 2)}
                </div>
                <div>
                  <span className="text-sm font-semibold">${tokenSymbol}</span>
                  <span
                    className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                    style={{
                      background: "rgba(34,197,94,0.1)",
                      color: "#22c55e",
                    }}
                  >
                    Active
                  </span>
                </div>
              </div>
            </div>

            {/* Price section */}
            {tokenPrice?.priceUsd ? (
              <div className="mb-1">
                <span className="text-2xl font-bold">
                  ${parseFloat(tokenPrice.priceUsd) < 0.01
                    ? parseFloat(tokenPrice.priceUsd).toExponential(2)
                    : parseFloat(tokenPrice.priceUsd).toFixed(4)}
                </span>
                {tokenPrice.priceChange24h != null && (
                  <span
                    className="ml-2 text-xs font-medium inline-flex items-center gap-0.5"
                    style={{ color: tokenPrice.priceChange24h >= 0 ? "#22c55e" : "#ef4444" }}
                  >
                    {tokenPrice.priceChange24h >= 0 ? (
                      <TrendingUp className="w-3 h-3" />
                    ) : (
                      <TrendingDown className="w-3 h-3" />
                    )}
                    {tokenPrice.priceChange24h >= 0 ? "+" : ""}
                    {tokenPrice.priceChange24h.toFixed(1)}%
                  </span>
                )}
                {tokenPrice.volume24h != null && tokenPrice.volume24h > 0 && (
                  <p className="text-[10px] mt-1" style={{ color: "var(--muted)" }}>
                    24h volume: ${tokenPrice.volume24h.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </p>
                )}
              </div>
            ) : (
              <div className="mb-1">
                <p className="text-xs" style={{ color: "var(--muted)" }}>
                  Trading on Uniswap V4
                </p>
                <code className="text-[10px]" style={{ color: "var(--muted)" }}>
                  {tokenAddress?.slice(0, 10)}...{tokenAddress?.slice(-6)}
                </code>
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div
            className="flex gap-0 border-t"
            style={{ borderColor: "var(--border)" }}
          >
            <a
              href={`https://bankr.bot/launches/${tokenAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 text-xs font-medium flex items-center justify-center gap-1.5 py-3 hover:bg-black/5 transition-colors"
              style={{ color: "var(--foreground)" }}
            >
              Manage on Bankr
              <ExternalLink className="w-3 h-3" />
            </a>
            <div style={{ width: 1, background: "var(--border)" }} />
            <a
              href={`https://basescan.org/token/${tokenAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 text-xs flex items-center justify-center gap-1.5 py-3 hover:bg-black/5 transition-colors"
              style={{ color: "var(--muted)" }}
            >
              BaseScan
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      ) : (
        <>
          {!showTokenForm ? (
            <button
              onClick={() => setShowTokenForm(true)}
              className="w-full py-2.5 px-4 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-all hover:scale-[1.01] active:scale-[0.99]"
              style={{
                background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.06) 40%, transparent 50%, transparent 100%), linear-gradient(180deg, #f5a623 0%, #d4911d 100%)",
                color: "white",
                boxShadow: "0 2px 6px rgba(180, 120, 0, 0.25), 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.25)",
                textShadow: "0 1px 1px rgba(0, 0, 0, 0.12)",
              }}
            >
              <Sparkles className="w-4 h-4" />
              Tokenize Your Agent
            </button>
          ) : (
            <div
              className="rounded-lg p-4 space-y-3"
              style={{ background: "rgba(0,0,0,0.03)", border: "1px solid var(--border)" }}
            >
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Launch a token for your agent. Trading fees help fund your agent&apos;s compute.
              </p>
              <input
                type="text"
                placeholder="Token Name (e.g. MyAgent)"
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                maxLength={32}
                className="w-full px-3 py-2 rounded-md text-sm"
                style={{
                  border: "1px solid var(--border)",
                  background: "white",
                }}
              />
              <input
                type="text"
                placeholder="Symbol (e.g. AGENT)"
                value={tokenSym}
                onChange={(e) => setTokenSym(e.target.value)}
                maxLength={10}
                className="w-full px-3 py-2 rounded-md text-sm uppercase"
                style={{
                  border: "1px solid var(--border)",
                  background: "white",
                }}
              />
              {error && (
                <p className="text-xs text-red-500">{error}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowTokenForm(false);
                    setError(null);
                  }}
                  className="flex-1 py-2 rounded-md text-sm"
                  style={{ border: "1px solid var(--border)" }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleTokenize}
                  disabled={tokenizing}
                  className="flex-1 py-2 rounded-md text-sm font-medium transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-50"
                  style={{
                    background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.06) 40%, transparent 50%, transparent 100%), linear-gradient(180deg, #f5a623 0%, #d4911d 100%)",
                    color: "white",
                    boxShadow: "0 2px 6px rgba(180, 120, 0, 0.25), 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.25)",
                    textShadow: "0 1px 1px rgba(0, 0, 0, 0.12)",
                  }}
                >
                  {tokenizing ? "Launching..." : "Launch Token"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {/* ── TEMP TEST BUTTON — REMOVE BEFORE PUSH ── */}
      <button
        onClick={() => {
          setLaunchSuccess("TEST");
          fireConfetti();
        }}
        className="w-full mt-3 py-2 rounded-md text-xs font-mono"
        style={{ background: "#ff0066", color: "white", opacity: 0.8 }}
      >
        TEST CELEBRATION (remove before push)
      </button>
    </div>
  );
}
