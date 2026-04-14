"use client";

import { useState } from "react";
import { Sparkles, ExternalLink, Copy, Check } from "lucide-react";

interface BankrTokenizeCardProps {
  walletId: string | null;
  evmAddress: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenizationPlatform: string | null;
}

export default function BankrTokenizeCard({
  walletId,
  evmAddress,
  tokenAddress,
  tokenSymbol,
  tokenizationPlatform,
}: BankrTokenizeCardProps) {
  const [copied, setCopied] = useState(false);
  const [tokenizing, setTokenizing] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [tokenSym, setTokenSym] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Don't render if no Bankr wallet
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
      const res = await fetch("/api/proxy/bankr/tokenize", {
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
      window.location.reload();
    } catch {
      setError("Network error — try again");
    } finally {
      setTokenizing(false);
    }
  }

  // Already tokenized on Virtuals — show message
  if (tokenizationPlatform === "virtuals" && !hasToken) {
    return (
      <div className="animate-fade-in-up glass-card rounded-2xl p-4" style={{ opacity: 0 }}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-[10px] font-medium tracking-wide text-muted">AGENT WALLET</span>
          <a href="https://bankr.bot" target="_blank" rel="noopener noreferrer" className="text-[10px] text-muted flex items-center gap-1">
            Powered by Bankr <ExternalLink size={10} />
          </a>
        </div>
        <div className="flex items-center gap-2 mb-2">
          <code className="text-xs px-2 py-1 rounded glass-inner">{shortAddress}</code>
        </div>
        <p className="text-[11px] text-muted">Tokenized on Virtuals Protocol. One platform per agent.</p>
      </div>
    );
  }

  // Token is live — show status
  if (hasToken) {
    return (
      <div className="animate-fade-in-up glass-card rounded-2xl p-4" style={{ opacity: 0 }}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-[10px] font-medium tracking-wide text-muted">AGENT WALLET</span>
          <a href="https://bankr.bot" target="_blank" rel="noopener noreferrer" className="text-[10px] text-muted flex items-center gap-1">
            Powered by Bankr <ExternalLink size={10} />
          </a>
        </div>
        <div className="flex items-center gap-2 mb-3">
          <code className="text-xs px-2 py-1 rounded glass-inner">{shortAddress}</code>
          <button onClick={handleCopy} className="p-1.5 rounded-lg glass-button" aria-label="Copy address">
            {copied ? <Check size={12} className="text-success" /> : <Copy size={12} className="text-muted" />}
          </button>
        </div>
        <div className="glass-inner rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-bold">${tokenSymbol}</span>
              <span className="text-[10px] text-muted ml-2">Token Active</span>
            </div>
          </div>
          <div className="flex gap-2">
            <a
              href={`https://basescan.org/token/${tokenAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 text-center text-[11px] text-muted py-2 rounded-lg glass-button flex items-center justify-center gap-1"
            >
              BaseScan <ExternalLink size={10} />
            </a>
            <a
              href={`https://bankr.bot/launches/${tokenAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 text-center text-[11px] text-muted py-2 rounded-lg glass-button flex items-center justify-center gap-1"
            >
              View earnings <ExternalLink size={10} />
            </a>
          </div>
        </div>
      </div>
    );
  }

  // No token — show tokenize flow
  return (
    <div className="animate-fade-in-up glass-card rounded-2xl p-4" style={{ opacity: 0 }}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-medium tracking-wide text-muted">AGENT WALLET</span>
        <a href="https://bankr.bot" target="_blank" rel="noopener noreferrer" className="text-[10px] text-muted flex items-center gap-1">
          Powered by Bankr <ExternalLink size={10} />
        </a>
      </div>
      <div className="flex items-center gap-2 mb-3">
        <code className="text-xs px-2 py-1 rounded glass-inner">{shortAddress}</code>
        <button onClick={handleCopy} className="p-1.5 rounded-lg glass-button" aria-label="Copy address">
          {copied ? <Check size={12} className="text-success" /> : <Copy size={12} className="text-muted" />}
        </button>
      </div>

      {!showForm ? (
        <button
          onClick={() => setShowForm(true)}
          className="w-full py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
          style={{
            background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.06) 40%, transparent 50%, transparent 100%), linear-gradient(180deg, #f5a623 0%, #d4911d 100%)",
            color: "white",
            boxShadow: "0 2px 6px rgba(180, 120, 0, 0.25), 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.25)",
            textShadow: "0 1px 1px rgba(0, 0, 0, 0.12)",
          }}
        >
          <Sparkles size={16} />
          Tokenize Your Agent
        </button>
      ) : (
        <div className="glass-inner rounded-xl p-4 space-y-3">
          <p className="text-[11px] text-muted">
            Launch a token for your agent. Trading fees help fund your agent&apos;s compute.
          </p>
          <input
            type="text"
            placeholder="Token Name (e.g. MyAgent)"
            value={tokenName}
            onChange={(e) => setTokenName(e.target.value)}
            maxLength={32}
            className="w-full px-3 py-2.5 rounded-lg text-sm bg-black/20 border border-white/10 placeholder:text-muted/50 focus:outline-none focus:border-white/20"
          />
          <input
            type="text"
            placeholder="Symbol (e.g. AGENT)"
            value={tokenSym}
            onChange={(e) => setTokenSym(e.target.value)}
            maxLength={10}
            className="w-full px-3 py-2.5 rounded-lg text-sm uppercase bg-black/20 border border-white/10 placeholder:text-muted/50 focus:outline-none focus:border-white/20"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => { setShowForm(false); setError(null); }}
              className="flex-1 py-2.5 rounded-lg text-sm glass-button"
            >
              Cancel
            </button>
            <button
              onClick={handleTokenize}
              disabled={tokenizing}
              className="flex-1 py-2.5 rounded-lg text-sm font-bold active:scale-[0.98] transition-transform disabled:opacity-50"
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
    </div>
  );
}
