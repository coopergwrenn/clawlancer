"use client";

import { useState } from "react";
import { Wallet, ExternalLink, Copy, Check, Sparkles } from "lucide-react";

interface BankrWalletCardProps {
  walletId: string | null;
  evmAddress: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenizationPlatform: string | null;
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
      // Refresh page to show updated token status
      window.location.reload();
    } catch {
      setError("Network error — try again");
    } finally {
      setTokenizing(false);
    }
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
        <div
          className="rounded-lg p-3 space-y-2"
          style={{ background: "rgba(0,0,0,0.03)", border: "1px solid var(--border)" }}
        >
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium">${tokenSymbol}</span>
              <span className="text-xs ml-2" style={{ color: "var(--muted)" }}>
                Token Active
              </span>
            </div>
            <a
              href={`https://basescan.org/token/${tokenAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs flex items-center gap-1"
              style={{ color: "var(--muted)" }}
            >
              BaseScan
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <a
            href={`https://bankr.bot/launches/${tokenAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs flex items-center justify-center gap-1 py-2 rounded-md hover:bg-black/5 transition-colors"
            style={{
              border: "1px solid var(--border)",
              color: "var(--muted)",
            }}
          >
            View earnings on Bankr
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      ) : (
        <>
          {!showTokenForm ? (
            <button
              onClick={() => setShowTokenForm(true)}
              className="w-full py-2.5 px-4 rounded-lg text-sm font-medium flex items-center justify-center gap-2 transition-all hover:scale-[1.01] active:scale-[0.99]"
              style={{
                background: "linear-gradient(-75deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.25), rgba(255, 255, 255, 0.08)), linear-gradient(135deg, #f59e0b, #d97706)",
                color: "white",
                backdropFilter: "blur(2px)",
                WebkitBackdropFilter: "blur(2px)",
                boxShadow: `
                  rgba(0, 0, 0, 0.08) 0px 2px 4px 0px,
                  rgba(255, 255, 255, 0.3) 0px 1px 1px 0px inset,
                  rgba(0, 0, 0, 0.1) 0px 2px 2px 0px inset,
                  rgba(255, 255, 255, 0.15) 0px 0px 1.6px 3px inset
                `,
                border: "1px solid rgba(255, 255, 255, 0.15)",
                textShadow: "0 1px 2px rgba(0, 0, 0, 0.15)",
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
                    background: "linear-gradient(-75deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.25), rgba(255, 255, 255, 0.08)), linear-gradient(135deg, #f59e0b, #d97706)",
                    color: "white",
                    boxShadow: `
                      rgba(0, 0, 0, 0.08) 0px 2px 4px 0px,
                      rgba(255, 255, 255, 0.3) 0px 1px 1px 0px inset,
                      rgba(0, 0, 0, 0.1) 0px 2px 2px 0px inset,
                      rgba(255, 255, 255, 0.15) 0px 0px 1.6px 3px inset
                    `,
                    border: "1px solid rgba(255, 255, 255, 0.15)",
                    textShadow: "0 1px 2px rgba(0, 0, 0, 0.15)",
                  }}
                >
                  {tokenizing ? "Launching..." : "Launch Token"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
