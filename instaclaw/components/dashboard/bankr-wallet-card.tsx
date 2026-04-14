"use client";

import { useState, useEffect, useRef } from "react";
import { Wallet, ExternalLink, Copy, Check, Sparkles, TrendingUp, TrendingDown, Upload, Wand2, X } from "lucide-react";

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
  const [launchSuccess, setLaunchSuccess] = useState<{ symbol: string; address: string } | null>(null);
  const [showShareCard, setShowShareCard] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [tokenPrice, setTokenPrice] = useState<TokenPrice | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const autoReloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  async function handleGenerateImage() {
    if (!tokenName.trim()) {
      setImageError("Enter a token name first");
      return;
    }
    setImageError(null);
    setImageLoading(true);
    try {
      const res = await fetch("/api/bankr/generate-token-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token_name: tokenName.trim() }),
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
      setImageLoading(false);
    }
  }

  async function handleUploadImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setImageError("Image must be under 5MB");
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setImageError("Image must be JPG, PNG, or WebP");
      return;
    }
    setImageError(null);
    setImageLoading(true);
    try {
      const formData = new FormData();
      formData.append("image", file);
      const res = await fetch("/api/bankr/upload-token-image", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setImageError(data.error ?? "Upload failed");
        return;
      }
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
      const res = await fetch("/api/bankr/tokenize", {
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
      // Celebration: confetti + share card
      const symbol = tokenSym.trim().toUpperCase();
      const addr = data.tokenAddress ?? "";
      setLaunchSuccess({ symbol, address: addr });
      fireConfetti();
      // Show share card after brief celebration moment
      setTimeout(() => setShowShareCard(true), 800);
      // Auto-reload after 8s if user doesn't interact — stored so we can cancel on interaction
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
    const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;
    const basescanUrl = hasAddress ? `https://basescan.org/token/${launchSuccess.address}` : "";

    function cancelAutoReload() {
      if (autoReloadTimer.current) {
        clearTimeout(autoReloadTimer.current);
        autoReloadTimer.current = null;
      }
    }

    function handleShare() {
      cancelAutoReload();
      window.open(tweetUrl, "_blank");
      setTimeout(() => window.location.reload(), 1500);
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
      <div
        className="glass rounded-xl p-8 flex flex-col items-center justify-center text-center"
        style={{ border: "1px solid var(--border)" }}
      >
        <div
          className="text-3xl font-bold mb-2"
          style={{
            background: "linear-gradient(135deg, #f5a623, #fbbf24)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}
        >
          ${launchSuccess.symbol} is live!
        </div>
        <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>
          Your token is now trading on Base
        </p>

        {showShareCard && hasAddress && (
          <div className="w-full space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="flex gap-2">
              <button
                onClick={handleShare}
                className="flex-[2] py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-2 transition-all hover:scale-[1.01] active:scale-[0.99]"
                style={{
                  background: "#000",
                  color: "#fff",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                </svg>
                Share to X
              </button>
              <button
                onClick={handleCopyLink}
                className="flex-1 py-2.5 rounded-lg text-sm flex items-center justify-center gap-1.5 transition-all hover:scale-[1.01] active:scale-[0.99]"
                style={{
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                }}
              >
                {linkCopied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-green-600" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    Copy link
                  </>
                )}
              </button>
            </div>
            <button
              onClick={handleSkip}
              className="text-xs transition-colors hover:opacity-70"
              style={{ color: "var(--muted)" }}
            >
              Maybe later
            </button>
          </div>
        )}
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
              {/* ── Token Image (optional) ── */}
              <div
                className="rounded-md p-3 space-y-2"
                style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
              >
                <p className="text-[11px] font-medium" style={{ color: "var(--muted)" }}>
                  Token Image <span style={{ opacity: 0.6 }}>(optional)</span>
                </p>

                {imageUrl ? (
                  /* Preview state */
                  <div className="flex items-center gap-3">
                    <img
                      src={imageUrl}
                      alt="Token PFP"
                      className="w-14 h-14 rounded-full object-cover"
                      style={{ border: "2px solid var(--border)" }}
                    />
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => { setImageUrl(null); setImageError(null); }}
                        className="text-[11px] px-2 py-1 rounded flex items-center gap-1 hover:bg-black/5"
                        style={{ color: "var(--muted)" }}
                      >
                        <X className="w-3 h-3" /> Remove
                      </button>
                    </div>
                  </div>
                ) : imageLoading ? (
                  /* Loading state */
                  <div className="flex items-center justify-center py-3">
                    <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "var(--border)", borderTopColor: "transparent" }} />
                    <span className="text-xs ml-2" style={{ color: "var(--muted)" }}>
                      Creating your token PFP...
                    </span>
                  </div>
                ) : (
                  /* Upload / Generate buttons */
                  <div className="flex gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={handleUploadImage}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex-1 py-1.5 rounded text-[11px] flex items-center justify-center gap-1 hover:bg-black/5 transition-colors"
                      style={{ border: "1px solid var(--border)", color: "var(--muted)" }}
                    >
                      <Upload className="w-3 h-3" /> Upload
                    </button>
                    <button
                      type="button"
                      onClick={handleGenerateImage}
                      className="flex-1 py-1.5 rounded text-[11px] flex items-center justify-center gap-1 hover:bg-black/5 transition-colors"
                      style={{ border: "1px solid var(--border)", color: "var(--muted)" }}
                    >
                      <Wand2 className="w-3 h-3" /> Generate
                    </button>
                  </div>
                )}

                {imageError && (
                  <p className="text-[11px] text-red-500">{imageError}</p>
                )}

                <p className="text-[10px]" style={{ color: "var(--muted)", opacity: 0.6 }}>
                  You can update this later on Bankr
                </p>
              </div>

              {error && (
                <p className="text-xs text-red-500">{error}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowTokenForm(false);
                    setError(null);
                    setImageUrl(null);
                    setImageError(null);
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
    </div>
  );
}
