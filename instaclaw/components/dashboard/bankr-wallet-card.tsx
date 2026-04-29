"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { Wallet, ExternalLink, Copy, Check, Sparkles, TrendingUp, TrendingDown, Upload, Wand2, X } from "lucide-react";
import { HowToBuy } from "./how-to-buy";
import { pickTweetTemplate } from "@/lib/bankr-tweet-templates";

interface BankrWalletCardProps {
  walletId: string | null;
  evmAddress: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  tokenizationPlatform: string | null;
  agentName?: string | null;
  // Set by /api/vm/status on the one poll that discovered a chat-driven
  // launch (Path B). Triggers the same celebration view the dashboard
  // button shows after a successful launch. launchNumber populates the
  // "You're #N to deploy autonomously" line on the celebration card.
  freshLaunch?: { tokenAddress: string; tokenSymbol: string; launchNumber?: number } | null;
  /**
   * World ID verified status of the user. When true, the celebration
   * card shows a "verified human creator" badge and the share-to-X
   * tweet appends a "verified human" suffix to the credits line so
   * external readers see the trust signal.
   */
  worldIdVerified?: boolean;
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
  agentName,
  freshLaunch,
  worldIdVerified,
}: BankrWalletCardProps) {
  const [copied, setCopied] = useState(false);
  const [tokenizing, setTokenizing] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [tokenSym, setTokenSym] = useState("");
  const [showTokenForm, setShowTokenForm] = useState(false);
  // Two-step launch flow: showConfirm gates the actual /api/bankr/tokenize
  // call. Form's "Launch Token" button validates fields then sets this true,
  // showing a summary card with one big LAUNCH button. Reduces "did I just
  // press the button?" anxiety and primes the celebration emotionally.
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Lazy-init from freshLaunch so a chat-driven launch lands directly on
  // the celebration view on first paint. Without this, the first render
  // would show the post-launch dashboard view (token info + trade buttons)
  // for one frame before the useEffect side effects swap to celebration.
  // The effect below covers the freshLaunch-arrives-later case.
  const [launchSuccess, setLaunchSuccess] = useState<{ symbol: string; address: string; launchNumber?: number } | null>(
    () =>
      freshLaunch
        ? {
            symbol: freshLaunch.tokenSymbol,
            address: freshLaunch.tokenAddress,
            launchNumber: freshLaunch.launchNumber,
          }
        : null,
  );
  const [showShareCard, setShowShareCard] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [tokenPrice, setTokenPrice] = useState<TokenPrice | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageLoadingText, setImageLoadingText] = useState("Creating your token PFP...");
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageVariation, setImageVariation] = useState(0);
  const [personalityHash, setPersonalityHash] = useState<string | null>(null);
  // Elapsed seconds during a button-flow launch — drives the phased status
  // text on the Launch Token button so the 60s wait does not feel hung.
  const [launchElapsed, setLaunchElapsed] = useState(0);
  const autoReloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Once the chat-launch celebration has been triggered for a given
  // freshLaunch payload, don't re-fire on prop re-renders within the
  // same lifecycle (the next poll will return freshLaunch=null because
  // the row's bankr_token_address is now set, but this guard protects
  // against any edge where the same payload arrives twice).
  const freshLaunchHandled = useRef(false);

  // ── Path B: chat-driven launch celebration trigger ──
  // /api/vm/status sets `freshLaunch` exactly once — on the poll that
  // discovers the launch via Bankr's public API. We mirror the dashboard-
  // button celebration flow (confetti + share card + auto-reload) so the
  // viral share flywheel works for chat-launched users too.
  //
  // launchSuccess may already be set via the useState lazy init above
  // (first-paint case). The functional updater preserves that value or
  // initializes it from freshLaunch (poll-arrives-later case). The ref
  // guard ensures the side effects fire exactly once per lifecycle.
  // Hook must run before any early return — React hooks rules.
  useEffect(() => {
    if (!freshLaunch) return;
    if (freshLaunchHandled.current) return;
    freshLaunchHandled.current = true;
    setLaunchSuccess(
      (prev) =>
        prev ?? {
          symbol: freshLaunch.tokenSymbol,
          address: freshLaunch.tokenAddress,
          launchNumber: freshLaunch.launchNumber,
        },
    );
    fireConfetti();
    setTimeout(() => setShowShareCard(true), 800);
    autoReloadTimer.current = setTimeout(() => window.location.reload(), 8000);
  }, [freshLaunch]);

  // Phased launch status — increments elapsed counter every 500ms while
  // the tokenize POST is in flight. The button label maps elapsed → phase
  // text so users see progress through the typical ~10-30s deploy window.
  // Hook order matters: must run before any early return.
  useEffect(() => {
    if (!tokenizing) return;
    setLaunchElapsed(0);
    const start = Date.now();
    const interval = setInterval(() => {
      setLaunchElapsed(Math.floor((Date.now() - start) / 1000));
    }, 500);
    return () => clearInterval(interval);
  }, [tokenizing]);

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

  async function handleGenerateImage(nameOverride?: string, isRegenerate?: boolean) {
    const name = nameOverride || tokenName.trim() || agentName || "Agent";
    const nextVariation = isRegenerate ? imageVariation + 1 : imageVariation;
    console.log("[PFP] handleGenerateImage called", {
      isRegenerate,
      currentImageVariation: imageVariation,
      nextVariation,
      hasCachedPersonalityHash: !!personalityHash,
      personalityHashPreview: personalityHash ? personalityHash.slice(0, 12) : null,
    });
    if (isRegenerate) setImageVariation(nextVariation);
    setImageError(null);
    setImageLoading(true);
    // First call reads SOUL.md over SSH → show personality loading text.
    // Regen uses the cached hash → fast, just "regenerating".
    setImageLoadingText(
      isRegenerate && personalityHash
        ? "Regenerating..."
        : "Reading your agent's personality...",
    );
    try {
      const res = await fetch("/api/bankr/generate-token-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token_name: name,
          variation: nextVariation,
          personality_hash: isRegenerate ? personalityHash : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setImageError(data.error ?? "Generation failed");
        return;
      }
      setImageUrl(data.imageUrl);
      if (data.personalityHash) setPersonalityHash(data.personalityHash);
    } catch {
      setImageError("Generation failed — try again or skip");
    } finally {
      setImageLoading(false);
    }
  }

  function handleOpenForm() {
    setShowTokenForm(true);
    // Auto-generate a personalized PFP immediately
    handleGenerateImage(agentName || "Agent");
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

  // Step 1 of two-step launch: validate, then move to confirmation card.
  // Field state (name, symbol, image) is preserved so the user can step
  // back without losing input. Actual API call happens only when the user
  // clicks Launch on the confirmation card (handleTokenize, below).
  function handleShowConfirm() {
    if (!tokenName.trim() || !tokenSym.trim()) {
      setError("Token name and symbol are required");
      return;
    }
    setError(null);
    setShowConfirm(true);
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
      // Success-with-warning path: if the response includes a tokenAddress,
      // the launch IS on-chain even when status is non-2xx. The 500 case
      // we care about is "Bankr launched but our DB finalize failed" — the
      // token is live, an admin alert went out for manual reconcile, and
      // the user deserves their celebration + share flow either way. Only
      // treat as a hard failure when there's no tokenAddress to celebrate.
      const responseTokenAddress = typeof data.tokenAddress === "string" ? data.tokenAddress : null;
      if (!res.ok && !responseTokenAddress) {
        setError(data.error ?? "Tokenization failed");
        return;
      }
      // Celebration: confetti + share card
      const symbol = tokenSym.trim().toUpperCase();
      const addr = responseTokenAddress ?? "";
      const launchNumber = typeof data.launchNumber === "number" && data.launchNumber > 0 ? data.launchNumber : undefined;
      // Mark Path B handled here too — if the on-demand sync in /api/vm/status
      // races us and fires freshLaunch on the next poll, the useEffect must
      // not re-trigger confetti / replace the auto-reload timer.
      freshLaunchHandled.current = true;
      setLaunchSuccess({ symbol, address: addr, launchNumber });
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

  // Pick from 5 randomized templates with agentName + ticker interpolation.
  // Hoisted above the celebration early-return so it doesn't violate Rules
  // of Hooks. Memoized on (symbol, address, agentName) so the copy doesn't
  // re-shuffle when other state flips (linkCopied, showShareCard, etc.).
  const tweetText = useMemo(() => {
    if (!launchSuccess) return "";
    return pickTweetTemplate({
      tokenSymbol: launchSuccess.symbol,
      agentName,
      address: launchSuccess.address || null,
      verifiedHuman: !!worldIdVerified,
    });
  }, [launchSuccess, agentName, worldIdVerified]);

  // ── Celebration + Share Card ──
  if (launchSuccess) {
    const hasAddress = !!launchSuccess.address;
    // Share URL — bankr.bot/launches/:addr is the branded destination for the
    // partnership announcement. Tweet copy ends with the URL so Twitter renders
    // it as a link card with token PFP + chart preview from Bankr.
    const chartUrl = hasAddress ? `https://bankr.bot/launches/${launchSuccess.address}` : "";
    const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;

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
      navigator.clipboard.writeText(chartUrl);
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
        {typeof launchSuccess.launchNumber === "number" && launchSuccess.launchNumber > 0 && (
          <p className="text-xs mb-1" style={{ color: "var(--muted)" }}>
            You&apos;re #{launchSuccess.launchNumber} to deploy a token autonomously.
          </p>
        )}
        {worldIdVerified && (
          <div
            className="text-[11px] mb-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-full"
            style={{
              background: "rgba(34,197,94,0.10)",
              border: "1px solid rgba(34,197,94,0.30)",
              color: "#15803d",
              fontWeight: 500,
            }}
          >
            <Check className="w-3 h-3" />
            Verified human creator
          </div>
        )}
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
            <div className="text-left">
              <HowToBuy tokenAddress={launchSuccess.address} tokenSymbol={launchSuccess.symbol} />
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

          {/* Primary CTA — Trade on Bankr (the only reliable V4/Doppler trade surface today) */}
          <a
            href="https://bankr.bot/terminal"
            target="_blank"
            rel="noopener noreferrer"
            className="block text-center py-3 text-sm font-semibold flex items-center justify-center gap-2 transition-all hover:scale-[1.005] active:scale-[0.995]"
            style={{
              background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.06) 40%, transparent 50%, transparent 100%), linear-gradient(180deg, #f5a623 0%, #d4911d 100%)",
              color: "white",
              textShadow: "0 1px 1px rgba(0, 0, 0, 0.12)",
              borderTop: "1px solid var(--border)",
            }}
          >
            Trade on Bankr
            <ExternalLink className="w-3.5 h-3.5" />
          </a>

          {/* How-to-buy disclosure — V4/Doppler tokens need a short explainer */}
          <div
            className="px-4 pt-3 pb-2"
            style={{ borderTop: "1px solid var(--border)" }}
          >
            <HowToBuy tokenAddress={tokenAddress!} tokenSymbol={tokenSymbol} />
          </div>

          {/* Secondary row — chart, fee management, explorer */}
          <div
            className="flex gap-0 border-t"
            style={{ borderColor: "var(--border)" }}
          >
            <a
              href={`https://dexscreener.com/base/${tokenAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 text-[11px] flex items-center justify-center gap-1 py-2.5 hover:bg-black/5 transition-colors"
              style={{ color: "var(--muted)" }}
            >
              View Chart
              <ExternalLink className="w-3 h-3" />
            </a>
            <div style={{ width: 1, background: "var(--border)" }} />
            <a
              href={`https://bankr.bot/launches/${tokenAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 text-[11px] flex items-center justify-center gap-1 py-2.5 hover:bg-black/5 transition-colors"
              style={{ color: "var(--muted)" }}
            >
              Manage Fees
              <ExternalLink className="w-3 h-3" />
            </a>
            <div style={{ width: 1, background: "var(--border)" }} />
            <a
              href={`https://basescan.org/token/${tokenAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 text-[11px] flex items-center justify-center gap-1 py-2.5 hover:bg-black/5 transition-colors"
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
              onClick={handleOpenForm}
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
          ) : !showConfirm ? (
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
              {/* ── Token Image (auto-generated) ── */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleUploadImage}
                className="hidden"
              />
              <div
                className="rounded-md p-3 space-y-2.5"
                style={{ border: "1px solid var(--border)", background: "rgba(0,0,0,0.02)" }}
              >
                <p className="text-[11px] font-medium" style={{ color: "var(--muted)" }}>
                  Token Image <span style={{ opacity: 0.6 }}>(optional)</span>
                </p>

                {imageLoading ? (
                  /* Shimmer loading state */
                  <div className="flex flex-col items-center py-4 gap-3">
                    <div
                      className="w-28 h-28 rounded-full"
                      style={{
                        background: "linear-gradient(90deg, rgba(0,0,0,0.04) 25%, rgba(0,0,0,0.08) 50%, rgba(0,0,0,0.04) 75%)",
                        backgroundSize: "200% 100%",
                        animation: "shimmer 1.5s infinite linear",
                      }}
                    />
                    <p className="text-[11px] transition-opacity duration-300" style={{ color: "var(--muted)" }}>
                      {imageLoadingText}
                    </p>
                    <style>{`@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>
                  </div>
                ) : imageUrl ? (
                  /* Preview + action buttons */
                  <div className="flex flex-col items-center gap-2.5">
                    <img
                      src={imageUrl}
                      alt="Token PFP"
                      className="w-28 h-28 rounded-full object-cover"
                    />
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleGenerateImage(undefined, true)}
                        className="text-[11px] px-2.5 py-1 rounded flex items-center gap-1 hover:bg-black/5 transition-colors"
                        style={{ border: "1px solid var(--border)", color: "var(--muted)" }}
                      >
                        <Wand2 className="w-3 h-3" /> Regenerate
                      </button>
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-[11px] px-2.5 py-1 rounded flex items-center gap-1 hover:bg-black/5 transition-colors"
                        style={{ border: "1px solid var(--border)", color: "var(--muted)" }}
                      >
                        <Upload className="w-3 h-3" /> Upload my own
                      </button>
                      <button
                        type="button"
                        onClick={() => { setImageUrl(null); setImageError(null); }}
                        className="text-[11px] px-2.5 py-1 rounded flex items-center gap-1 hover:bg-black/5 transition-colors"
                        style={{ color: "var(--muted)" }}
                      >
                        <X className="w-3 h-3" /> Remove
                      </button>
                    </div>
                  </div>
                ) : (
                  /* No image — generation failed or removed */
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => handleGenerateImage()}
                      className="flex-1 py-1.5 rounded text-[11px] flex items-center justify-center gap-1 hover:bg-black/5 transition-colors"
                      style={{ border: "1px solid var(--border)", color: "var(--muted)" }}
                    >
                      <Wand2 className="w-3 h-3" /> Generate PFP
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex-1 py-1.5 rounded text-[11px] flex items-center justify-center gap-1 hover:bg-black/5 transition-colors"
                      style={{ border: "1px solid var(--border)", color: "var(--muted)" }}
                    >
                      <Upload className="w-3 h-3" /> Upload my own
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

              {/* Subtle reassurance hint — full emphatic version lives on
                  the confirmation card. Two surfaces, same message, both
                  reinforce that there is no per-launch cost to the user. */}
              <div
                className="rounded-md px-3 py-2 text-[11px] flex items-start gap-1.5"
                style={{
                  background: "rgba(34,197,94,0.06)",
                  border: "1px solid rgba(34,197,94,0.18)",
                  color: "var(--muted)",
                }}
              >
                <span aria-hidden>🎁</span>
                <span>
                  Free to launch — InstaClaw covers gas. Trading fees flow back to your agent automatically.
                </span>
              </div>

              {error && (
                <p className="text-xs text-red-500">{error}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowTokenForm(false);
                    setShowConfirm(false);
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
                  onClick={handleShowConfirm}
                  className="flex-1 py-2 rounded-md text-sm font-medium transition-all hover:scale-[1.01] active:scale-[0.99]"
                  style={{
                    background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.06) 40%, transparent 50%, transparent 100%), linear-gradient(180deg, #f5a623 0%, #d4911d 100%)",
                    color: "white",
                    boxShadow: "0 2px 6px rgba(180, 120, 0, 0.25), 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.25)",
                    textShadow: "0 1px 1px rgba(0, 0, 0, 0.12)",
                  }}
                >
                  Review &amp; Launch
                </button>
              </div>
            </div>
          ) : null}

          {/* ── Step 2: Pre-launch confirmation card ──
              Renders when user has filled the form and clicked Review.
              Replaces the form (state preserved on Back) and frames the
              moment so the user explicitly opts in before the on-chain
              deploy. While tokenizing, this card stays mounted with phased
              status text on the Launch button until the celebration view
              fires via launchSuccess. */}
          {showTokenForm && showConfirm && (
            <div
              className="rounded-lg p-5 space-y-4 mt-3"
              style={{ background: "rgba(245,166,35,0.05)", border: "1px solid rgba(245,166,35,0.25)" }}
            >
              <div className="flex flex-col items-center text-center gap-2 pt-2">
                {imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageUrl}
                    alt="Token PFP"
                    className="w-20 h-20 rounded-full object-cover"
                    style={{ boxShadow: "0 4px 12px rgba(180,120,0,0.20)" }}
                  />
                ) : (
                  <div
                    className="w-20 h-20 rounded-full flex items-center justify-center text-base font-bold"
                    style={{
                      background: "linear-gradient(135deg, #f5a623, #d4911d)",
                      color: "white",
                      textShadow: "0 1px 2px rgba(0,0,0,0.18)",
                      boxShadow: "0 4px 12px rgba(180,120,0,0.20)",
                    }}
                  >
                    {tokenSym.trim().toUpperCase().slice(0, 3) || "?"}
                  </div>
                )}
                <div
                  className="text-2xl font-bold"
                  style={{
                    background: "linear-gradient(135deg, #f5a623, #fbbf24)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                  }}
                >
                  ${tokenSym.trim().toUpperCase() || "TOKEN"}
                </div>
                <div className="text-sm font-medium">{tokenName.trim()}</div>
                {agentName && (
                  <div className="text-xs" style={{ color: "var(--muted)" }}>
                    deployed for {agentName}
                  </div>
                )}
              </div>

              <p className="text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
                You&apos;re about to deploy <strong style={{ color: "var(--foreground)" }}>${tokenSym.trim().toUpperCase()}</strong> on
                {" "}<strong style={{ color: "var(--foreground)" }}>Base mainnet</strong>. Trading fees flow back to your agent&apos;s
                wallet automatically and fund its compute over time.
              </p>

              <div
                className="rounded-md px-3 py-2 text-[11px] flex items-center gap-2"
                style={{ background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.25)", color: "#15803d" }}
              >
                🎁 Free to launch — InstaClaw covers gas.
              </div>

              {error && (
                <p className="text-xs text-red-500">{error}</p>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => setShowConfirm(false)}
                  disabled={tokenizing}
                  className="flex-1 py-2 rounded-md text-sm transition-all disabled:opacity-50"
                  style={{ border: "1px solid var(--border)" }}
                >
                  Back
                </button>
                <button
                  onClick={handleTokenize}
                  disabled={tokenizing}
                  className="flex-[2] py-2.5 rounded-md text-sm font-semibold transition-all hover:scale-[1.01] active:scale-[0.99] disabled:opacity-60"
                  style={{
                    background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.06) 40%, transparent 50%, transparent 100%), linear-gradient(180deg, #f5a623 0%, #d4911d 100%)",
                    color: "white",
                    boxShadow: "0 2px 6px rgba(180, 120, 0, 0.25), 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.25)",
                    textShadow: "0 1px 1px rgba(0, 0, 0, 0.12)",
                  }}
                >
                  {tokenizing
                    ? launchElapsed < 4
                      ? "Deploying on Base..."
                      : launchElapsed < 12
                      ? "Creating Uniswap V4 pool..."
                      : launchElapsed < 25
                      ? "Wiring fees & metadata..."
                      : "Almost there..."
                    : "Launch Token"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
