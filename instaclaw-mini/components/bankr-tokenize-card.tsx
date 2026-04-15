"use client";

import { useState, useEffect, useRef } from "react";
import { Sparkles, ExternalLink, Copy, Check, TrendingUp, TrendingDown, Upload, Wand2, X } from "lucide-react";

interface BankrTokenizeCardProps {
  walletId: string | null;
  evmAddress: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenizationPlatform: string | null;
  agentName?: string | null;
}

interface TokenPrice {
  priceUsd: string | null;
  priceChange24h: number | null;
  volume24h: number | null;
}

// Lightweight confetti burst — gold/amber themed
function fireConfetti() {
  import("canvas-confetti").then((mod) => {
    const confetti = mod.default;
    const gold = ["#f5a623", "#d4911d", "#fbbf24", "#f59e0b", "#fff7ed"];
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

export default function BankrTokenizeCard({
  walletId,
  evmAddress,
  tokenAddress,
  tokenSymbol,
  tokenizationPlatform,
  agentName,
}: BankrTokenizeCardProps) {
  const [copied, setCopied] = useState(false);
  const [tokenizing, setTokenizing] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [tokenSym, setTokenSym] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launchSuccess, setLaunchSuccess] = useState<{ symbol: string; address: string } | null>(null);
  const [showShareCard, setShowShareCard] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [tweetCopied, setTweetCopied] = useState(false);
  const [tokenPrice, setTokenPrice] = useState<TokenPrice | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageLoadingText, setImageLoadingText] = useState("Reading your agent's personality...");
  const [imageError, setImageError] = useState<string | null>(null);
  const autoReloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch live token price from DexScreener
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

  async function handleGenerateImage(nameOverride?: string) {
    const name = nameOverride || tokenName.trim() || agentName || "Agent";
    setImageError(null);
    setImageLoading(true);
    setImageLoadingText("Reading your agent's personality...");
    const phaseTimer = setTimeout(() => setImageLoadingText("Creating your personalized token PFP..."), 5000);
    try {
      const res = await fetch("/api/proxy/bankr/generate-token-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token_name: name }),
      });
      const data = await res.json();
      if (!res.ok) {
        setImageError(data.error ?? "Generation failed");
        return;
      }
      setImageUrl(data.imageUrl);
    } catch {
      setImageError("Generation failed — try again or skip");
    } finally {
      clearTimeout(phaseTimer);
      setImageLoading(false);
    }
  }

  function handleOpenForm() {
    setShowForm(true);
    handleGenerateImage(agentName || "Agent");
  }

  async function handleUploadImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setImageError("Image must be under 5MB"); return; }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setImageError("Image must be JPG, PNG, or WebP"); return; }
    setImageError(null);
    setImageLoading(true);
    try {
      const formData = new FormData();
      formData.append("image", file);
      const res = await fetch("/api/proxy/bankr/upload-token-image", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) { setImageError(data.error ?? "Upload failed"); return; }
      setImageUrl(data.imageUrl);
    } catch {
      setImageError("Upload failed — try again or skip");
    } finally {
      setImageLoading(false);
    }
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
          ...(imageUrl ? { image: imageUrl } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Tokenization failed");
        return;
      }
      const symbol = tokenSym.trim().toUpperCase();
      const addr = data.tokenAddress ?? "";
      setLaunchSuccess({ symbol, address: addr });
      fireConfetti();
      setTimeout(() => setShowShareCard(true), 800);
      autoReloadTimer.current = setTimeout(() => window.location.reload(), 8000);
    } catch {
      setError("Network error — try again");
    } finally {
      setTokenizing(false);
    }
  }

  // ── Celebration + Share Card ──
  if (launchSuccess) {
    const hasAddress = !!launchSuccess.address;
    const tweetText = hasAddress
      ? `my AI agent launched a token and now it pays for its own thoughts. one click. $${launchSuccess.symbol} on Base. launched on @instaclaws, powered by @bankrbot.\n\nbankr.bot/launches/${launchSuccess.address}`
      : `my AI agent launched a token and now it pays for its own thoughts. one click. $${launchSuccess.symbol} on Base. launched on @instaclaws, powered by @bankrbot.`;
    const basescanUrl = hasAddress ? `https://basescan.org/token/${launchSuccess.address}` : "";

    function cancelAutoReload() {
      if (autoReloadTimer.current) {
        clearTimeout(autoReloadTimer.current);
        autoReloadTimer.current = null;
      }
    }

    // Mini app: copy tweet text to clipboard, then show "Open X" button.
    // Avoids window.location.href which navigates away and strands the user.
    function handleCopyTweet() {
      cancelAutoReload();
      navigator.clipboard.writeText(tweetText);
      setTweetCopied(true);
    }

    function handleOpenX() {
      // Open X in the system browser — user pastes the copied text
      window.location.href = "https://twitter.com/intent/tweet";
    }

    function handleCopyLink() {
      cancelAutoReload();
      navigator.clipboard.writeText(basescanUrl);
      setLinkCopied(true);
      setTimeout(() => window.location.reload(), 1500);
    }

    function handleSkip() {
      cancelAutoReload();
      window.location.reload();
    }

    return (
      <div className="animate-fade-in-up glass-card rounded-2xl p-8 flex flex-col items-center justify-center text-center" style={{ opacity: 0 }}>
        <div
          className="text-2xl font-bold mb-2"
          style={{
            background: "linear-gradient(135deg, #f5a623, #fbbf24)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          ${launchSuccess.symbol} is live!
        </div>
        <p className="text-xs text-muted mb-6">Your token is now trading on Base</p>

        {showShareCard && hasAddress && (
          <div className="w-full space-y-3">
            {!tweetCopied ? (
              /* Step 1: Copy tweet text */
              <div className="flex gap-2">
                <button
                  onClick={handleCopyTweet}
                  className="flex-[2] py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
                  style={{ background: "#000", color: "#fff" }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                  </svg>
                  Share to X
                </button>
                <button
                  onClick={handleCopyLink}
                  className="flex-1 py-3 rounded-xl text-sm flex items-center justify-center gap-1.5 glass-button active:scale-[0.98] transition-transform"
                >
                  {linkCopied ? (
                    <><Check size={14} className="text-success" /> Copied</>
                  ) : (
                    <><Copy size={14} /> Copy link</>
                  )}
                </button>
              </div>
            ) : (
              /* Step 2: Tweet copied — show "Open X" to paste */
              <div className="space-y-2">
                <p className="text-[11px] text-success flex items-center justify-center gap-1">
                  <Check size={12} /> Tweet copied to clipboard
                </p>
                <button
                  onClick={handleOpenX}
                  className="w-full py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
                  style={{ background: "#000", color: "#fff" }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                  </svg>
                  Open X to paste
                </button>
              </div>
            )}
            <button onClick={handleSkip} className="text-xs text-muted">
              Maybe later
            </button>
          </div>
        )}
      </div>
    );
  }

  // Already tokenized on Virtuals
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

  // ── POST-LAUNCH TOKEN DASHBOARD ──
  if (hasToken) {
    return (
      <div className="animate-fade-in-up glass-card rounded-2xl overflow-hidden" style={{ opacity: 0 }}>
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[10px] font-medium tracking-wide text-muted">AGENT WALLET</span>
            <a href="https://bankr.bot" target="_blank" rel="noopener noreferrer" className="text-[10px] text-muted flex items-center gap-1">
              Powered by Bankr <ExternalLink size={10} />
            </a>
          </div>

          {/* Token header */}
          <div className="flex items-center gap-2.5 mb-3">
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold"
              style={{
                background: "linear-gradient(135deg, #f5a623, #d4911d)",
                color: "white",
                textShadow: "0 1px 1px rgba(0,0,0,0.15)",
              }}
            >
              {tokenSymbol?.slice(0, 2)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold">${tokenSymbol}</span>
                <span
                  className="text-[9px] px-1.5 py-0.5 rounded-full font-medium"
                  style={{ background: "rgba(34,197,94,0.15)", color: "#22c55e" }}
                >
                  Active
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <code className="text-[10px] text-muted">{shortAddress}</code>
                <button onClick={handleCopy} className="p-0.5" aria-label="Copy address">
                  {copied ? <Check size={10} className="text-success" /> : <Copy size={10} className="text-muted" />}
                </button>
              </div>
            </div>
          </div>

          {/* Price section */}
          {tokenPrice?.priceUsd ? (
            <div className="glass-inner rounded-xl p-3 mb-1">
              <div className="flex items-baseline gap-2">
                <span className="text-xl font-bold">
                  ${parseFloat(tokenPrice.priceUsd) < 0.01
                    ? parseFloat(tokenPrice.priceUsd).toExponential(2)
                    : parseFloat(tokenPrice.priceUsd).toFixed(4)}
                </span>
                {tokenPrice.priceChange24h != null && (
                  <span
                    className="text-xs font-medium flex items-center gap-0.5"
                    style={{ color: tokenPrice.priceChange24h >= 0 ? "#22c55e" : "#ef4444" }}
                  >
                    {tokenPrice.priceChange24h >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                    {tokenPrice.priceChange24h >= 0 ? "+" : ""}{tokenPrice.priceChange24h.toFixed(1)}%
                  </span>
                )}
              </div>
              {tokenPrice.volume24h != null && tokenPrice.volume24h > 0 && (
                <p className="text-[10px] text-muted mt-1">
                  24h vol: ${tokenPrice.volume24h.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </p>
              )}
            </div>
          ) : (
            <div className="glass-inner rounded-xl p-3 mb-1">
              <p className="text-[11px] text-muted">Trading on Uniswap V4</p>
              <code className="text-[10px] text-muted">
                {tokenAddress?.slice(0, 10)}...{tokenAddress?.slice(-6)}
              </code>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex border-t border-white/5">
          <a
            href={`https://bankr.bot/launches/${tokenAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 text-[11px] font-medium flex items-center justify-center gap-1.5 py-3 active:bg-white/5 transition-colors"
          >
            Manage on Bankr <ExternalLink size={10} />
          </a>
          <div className="w-px bg-white/5" />
          <a
            href={`https://basescan.org/token/${tokenAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 text-[11px] text-muted flex items-center justify-center gap-1.5 py-3 active:bg-white/5 transition-colors"
          >
            BaseScan <ExternalLink size={10} />
          </a>
        </div>
      </div>
    );
  }

  // ── No token — show tokenize flow ──
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
          onClick={handleOpenForm}
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
          {/* ── Token Image (auto-generated) ── */}
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={handleUploadImage} className="hidden" />
          <div className="rounded-lg p-3 space-y-2.5 bg-white/5 border border-white/5">
            <p className="text-[10px] font-medium text-muted">
              Token Image <span className="opacity-50">(optional)</span>
            </p>

            {imageLoading ? (
              /* Shimmer loading */
              <div className="flex flex-col items-center py-4 gap-3">
                <div
                  className="w-16 h-16 rounded-xl"
                  style={{
                    background: "linear-gradient(90deg, rgba(255,255,255,0.03) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.03) 75%)",
                    backgroundSize: "200% 100%",
                    animation: "shimmer 1.5s infinite linear",
                  }}
                />
                <p className="text-[10px] text-muted transition-opacity duration-300">{imageLoadingText}</p>
                <style>{`@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
              </div>
            ) : imageUrl ? (
              /* Preview + actions */
              <div className="flex flex-col items-center gap-2.5">
                <img src={imageUrl} alt="Token PFP" className="w-16 h-16 rounded-xl object-cover border border-white/10" />
                <div className="flex gap-1.5 flex-wrap justify-center">
                  <button type="button" onClick={() => handleGenerateImage()} className="text-[10px] px-2 py-1 rounded-lg flex items-center gap-1 glass-button active:scale-[0.98]">
                    <Wand2 size={10} /> Regenerate
                  </button>
                  <button type="button" onClick={() => fileInputRef.current?.click()} className="text-[10px] px-2 py-1 rounded-lg flex items-center gap-1 glass-button active:scale-[0.98]">
                    <Upload size={10} /> Upload my own
                  </button>
                  <button type="button" onClick={() => { setImageUrl(null); setImageError(null); }} className="text-[10px] px-2 py-1 rounded-lg flex items-center gap-1 text-muted active:scale-[0.98]">
                    <X size={10} /> Remove
                  </button>
                </div>
              </div>
            ) : (
              /* Fallback: generation failed or image removed */
              <div className="flex gap-2">
                <button type="button" onClick={() => handleGenerateImage()} className="flex-1 py-2 rounded-lg text-[11px] flex items-center justify-center gap-1.5 glass-button active:scale-[0.98] transition-transform">
                  <Wand2 size={12} /> Generate PFP
                </button>
                <button type="button" onClick={() => fileInputRef.current?.click()} className="flex-1 py-2 rounded-lg text-[11px] flex items-center justify-center gap-1.5 glass-button active:scale-[0.98] transition-transform">
                  <Upload size={12} /> Upload my own
                </button>
              </div>
            )}

            {imageError && <p className="text-[10px] text-red-400">{imageError}</p>}
            <p className="text-[9px] text-muted opacity-50">You can update this later on Bankr</p>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => { setShowForm(false); setError(null); setImageUrl(null); setImageError(null); }}
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
