"use client";

/**
 * /videos — the flagship video surface (stage 1 of the parked design).
 *
 * The page a $44.99/mo subscriber sees when they think "where are my
 * videos." Three movements:
 *   ① the quota band — three pools (free daily / plan monthly / banked
 *     packs) + the seed chip, one honest picture;
 *   ② the gallery — every render as a living card: hover wakes it (150ms
 *     intent delay, muted), pending renders BREATHE in place (the animated
 *     -75deg glass sheen is the shimmer — house material, not skeleton
 *     gray), the lightbox celebrates the verbatim prompt as the artifact;
 *   ③ the shelf — the video pack cards + plan card (catalog single-source),
 *     on-page checkout per the routing rule (this page is the seller).
 *
 * Craft sources: the real .glass recipe (-75deg sheen, 4-layer shadow,
 * blur(2px)), Instrument Serif display, coral #DC6743, the signature
 * cubic-bezier(0.23,1,0.32,1). Patterns stolen from the masters: Sora's
 * library scrub/lightbox, Midjourney's prompt-as-artifact, Runway's date
 * grouping — and where our taste differs: uniform 16:9 calm over masonry,
 * provenance chips over per-render cost numbers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Clapperboard, Zap, Package, Download, Copy, X, Check, Gift, Film,
} from "lucide-react";
import { useToast, ToastViewport } from "@/components/ui/toast";
import { VIDEO_PACKS, type CatalogPack } from "@/lib/billing-catalog";
import type { RenderItem, VideoQuotas } from "@/lib/videos";

const EASE = [0.23, 1, 0.32, 1] as const;

/* ── data hook ─────────────────────────────────────────────────────────── */

interface VideosPayload {
  quotas: VideoQuotas;
  renders: RenderItem[];
  next_cursor: string | null;
}

function useVideos(filter: string) {
  const [data, setData] = useState<VideosPayload | null>(null);
  const [more, setMore] = useState<RenderItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/videos?filter=${filter}`);
      if (r.ok) { setData(await r.json()); setMore([]); }
    } catch { /* page renders skeleton; next poll retries */ }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  // Gentle poll while anything is rendering — the pending card becomes the
  // video "materializing in place" (AnimatePresence handles the crossfade).
  const hasPending = data?.renders.some((r) => r.status === "pending") ?? false;
  useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [hasPending, load]);

  const loadMore = useCallback(async () => {
    const cursor = more.length
      ? more[more.length - 1]?.created_at
      : data?.next_cursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await fetch(`/api/videos?filter=${filter}&cursor=${encodeURIComponent(cursor)}`);
      if (r.ok) {
        const j: VideosPayload = await r.json();
        setMore((m) => [...m, ...j.renders]);
      }
    } finally { setLoadingMore(false); }
  }, [data, more, filter, loadingMore]);

  const renders = useMemo(
    () => [...(data?.renders ?? []), ...more],
    [data, more],
  );
  return { quotas: data?.quotas ?? null, renders, loaded: data !== null, loadMore, hasMore: !!data?.next_cursor, loadingMore, reload: load };
}

/* ── ① the quota band ──────────────────────────────────────────────────── */

function QuotaTile({
  icon, value, label, sub, highlight, cta,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
  sub: string;
  highlight?: boolean;
  cta?: { text: string; onClick: () => void };
}) {
  return (
    <div
      className="glass rounded-xl p-5 relative overflow-hidden"
      style={{ border: "1px solid var(--border)" }}
    >
      {/* refraction substrate — the color-under-glass move, coral-tinted on
          the highlighted (plan) tile so the glass has something to bend */}
      {highlight && (
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse at 20% 110%, rgba(220,103,67,0.10) 0%, rgba(220,103,67,0.03) 45%, transparent 75%)",
          }}
        />
      )}
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className="text-xs font-medium" style={{ color: "var(--muted)" }}>
          {label}
        </span>
      </div>
      <p className="text-3xl font-normal tracking-tight" style={{ fontFamily: "var(--font-serif)" }}>
        {value}
      </p>
      <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
        {sub}
        {cta && (
          <>
            {" · "}
            <button
              onClick={cta.onClick}
              className="underline underline-offset-2 cursor-pointer transition-opacity hover:opacity-70"
              style={{ color: "var(--accent)" }}
            >
              {cta.text}
            </button>
          </>
        )}
      </p>
    </div>
  );
}

function QuotaBand({
  quotas, onShopClick, hideSeedChip,
}: {
  quotas: VideoQuotas;
  onShopClick: () => void;
  /** The EmptyState sells the seed in its own voice — don't say it twice. */
  hideSeedChip?: boolean;
}) {
  const freeLeft = Math.max(quotas.free.cap - quotas.free.used, 0);
  const plan = quotas.plan;
  const resets = plan?.resets_at
    ? new Date(plan.resets_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : null;
  return (
    <div className="space-y-3">
      {quotas.seed_available && !hideSeedChip && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE }}
          className="glass rounded-xl px-4 py-2.5 inline-flex items-center gap-2"
          style={{ border: "1px solid rgba(220,103,67,0.25)" }}
        >
          <Gift className="w-4 h-4" style={{ color: "var(--accent)" }} />
          <span className="text-sm">
            Your first cinematic video is free. Just text your agent:{" "}
            <em style={{ fontFamily: "var(--font-serif)" }}>&ldquo;make me a video of...&rdquo;</em>
          </span>
        </motion.div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <QuotaTile
          icon={<Zap className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />}
          value={`${freeLeft} of ${quotas.free.cap}`}
          label="free quick clips today"
          sub={freeLeft > 0 ? "images and fast clips · resets midnight UTC" : "replenishes at midnight UTC"}
          cta={freeLeft === 0 ? { text: "go premium", onClick: onShopClick } : undefined}
        />
        {plan ? (
          <QuotaTile
            icon={<Clapperboard className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />}
            value={String(plan.clips_remaining)}
            label="plan videos this month"
            highlight
            sub={
              plan.status === "past_due"
                ? "paused: payment issue · fix on the billing page"
                : resets
                  ? `premium cinema · resets ${resets}`
                  : "premium cinema"
            }
            cta={
              plan.status !== "past_due" && plan.clips_remaining <= 5
                ? { text: "top up with a pack", onClick: onShopClick }
                : undefined
            }
          />
        ) : (
          <QuotaTile
            icon={<Clapperboard className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />}
            value="42 / mo"
            label="the creator plan"
            highlight
            sub="$1.07 a video, our best rate"
            cta={{ text: "subscribe", onClick: onShopClick }}
          />
        )}
        <QuotaTile
          icon={<Package className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />}
          value={String(quotas.pack_clips)}
          label="banked videos"
          sub={quotas.pack_clips > 0 ? "from packs · never expire" : "packs from 99¢ a video"}
          cta={quotas.pack_clips === 0 ? { text: "browse packs", onClick: onShopClick } : undefined}
        />
      </div>
    </div>
  );
}

/* ── ② the gallery ─────────────────────────────────────────────────────── */

const PROVENANCE_CHIP: Record<string, { text: string; always?: boolean }> = {
  seed: { text: "on us", always: true },
  plan: { text: "plan" },
  free: { text: "free" },
  pack: { text: "pack" },
};

function RenderCard({ item, onOpen }: { item: RenderItem; onOpen: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hovered, setHovered] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);

  const wake = () => {
    setHovered(true);
    // 150ms intent delay — grazing the grid shouldn't start a film festival.
    hoverTimer.current = setTimeout(() => {
      videoRef.current?.play().catch(() => {});
    }, 150);
  };
  const sleep = () => {
    setHovered(false);
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    const v = videoRef.current;
    if (v) { v.pause(); v.currentTime = 0; }
  };

  const chip = PROVENANCE_CHIP[item.provenance];

  return (
    <motion.button
      layout
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.45, ease: EASE }}
      onMouseEnter={wake}
      onMouseLeave={sleep}
      onClick={onOpen}
      className="relative w-full aspect-video rounded-xl overflow-hidden text-left cursor-pointer group"
      style={{
        background: "#1a1a1c",
        boxShadow: hovered
          ? "rgba(0,0,0,0.18) 0px 8px 24px 0px, rgba(255,255,255,0.2) 0px 0px 1.6px 4px inset"
          : "rgba(0,0,0,0.10) 0px 2px 8px 0px, rgba(255,255,255,0.2) 0px 0px 1.6px 4px inset",
        transform: hovered ? "translateY(-2px)" : "translateY(0)",
        transition: "transform 0.3s cubic-bezier(0.23,1,0.32,1), box-shadow 0.3s cubic-bezier(0.23,1,0.32,1)",
      }}
    >
      {item.video_url ? (
        <video
          ref={videoRef}
          // #t=0.001 media fragment: forces Chrome to paint the first frame
          // with preload="metadata" — without it the card is a black hole.
          src={`${item.video_url}#t=0.001`}
          muted
          loop
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        // settled but the upstream asset is gone — honest, not blank
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
          <Film className="w-5 h-5" style={{ color: "rgba(255,255,255,0.35)" }} />
          <span className="text-xs" style={{ color: "rgba(255,255,255,0.45)" }}>
            expired upstream
          </span>
        </div>
      )}

      {/* bottom scrim: prompt slides up on hover — the grid stays calm */}
      <div
        className="absolute inset-x-0 bottom-0 p-3 pt-8"
        style={{
          background: "linear-gradient(to top, rgba(0,0,0,0.65), transparent)",
          opacity: hovered ? 1 : 0,
          transform: hovered ? "translateY(0)" : "translateY(6px)",
          transition: "opacity 0.3s cubic-bezier(0.23,1,0.32,1), transform 0.3s cubic-bezier(0.23,1,0.32,1)",
        }}
      >
        {item.prompt && (
          <p
            className="text-xs leading-snug line-clamp-2"
            style={{ color: "rgba(255,255,255,0.92)", fontFamily: "var(--font-serif)" }}
          >
            &ldquo;{item.prompt}&rdquo;
          </p>
        )}
      </div>

      {/* chips */}
      {chip && (chip.always || hovered) && (
        <span
          className="absolute top-2 left-2 text-[10px] font-semibold px-2 py-0.5 rounded-full backdrop-blur-sm"
          style={{
            background: item.provenance === "seed" ? "rgba(220,103,67,0.85)" : "rgba(0,0,0,0.55)",
            color: "#fff",
            transition: "opacity 0.3s cubic-bezier(0.23,1,0.32,1)",
          }}
        >
          {chip.text}
        </span>
      )}
      {duration !== null && (
        <span
          className="absolute bottom-2 right-2 text-[10px] font-medium px-1.5 py-0.5 rounded backdrop-blur-sm tabular-nums"
          style={{
            background: "rgba(0,0,0,0.55)", color: "#fff",
            opacity: hovered ? 0 : 1,
            transition: "opacity 0.3s cubic-bezier(0.23,1,0.32,1)",
          }}
        >
          {Math.round(duration)}s
        </span>
      )}
    </motion.button>
  );
}

/** The generating state — alive, not a spinner. The animated -75deg sheen
 *  IS the shimmer: our own glass material, breathing. */
function PendingCard({ item }: { item: RenderItem }) {
  const [elapsed, setElapsed] = useState(() =>
    Math.max(0, Math.floor((Date.now() - Date.parse(item.created_at)) / 1000)),
  );
  useEffect(() => {
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - Date.parse(item.created_at)) / 1000)),
      1000,
    );
    return () => clearInterval(t);
  }, [item.created_at]);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.45, ease: EASE }}
      className="relative w-full aspect-video rounded-xl overflow-hidden glass"
      style={{ border: "1px solid var(--border)" }}
    >
      {/* the breathing sheen — a -75deg light band sweeping the glass */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(-75deg, transparent 30%, rgba(255,255,255,0.45) 50%, transparent 70%)",
          backgroundSize: "300% 100%",
          animation: "videos-sheen 2.8s cubic-bezier(0.23,1,0.32,1) infinite",
        }}
      />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
        <Clapperboard className="w-5 h-5" style={{ color: "var(--accent)" }} />
        <span className="text-sm font-medium">rendering</span>
        <span className="text-xs tabular-nums" style={{ color: "var(--muted)" }}>
          {m}:{String(s).padStart(2, "0")} · {m >= 5 ? "taking longer than usual, still working" : "usually 2 to 5 min"}
        </span>
      </div>
      {item.prompt && (
        <p
          className="absolute inset-x-0 bottom-0 p-3 text-xs line-clamp-1 text-center"
          style={{ color: "var(--muted)", fontFamily: "var(--font-serif)" }}
        >
          &ldquo;{item.prompt}&rdquo;
        </p>
      )}
      <style jsx global>{`
        @keyframes videos-sheen {
          0% { background-position: 110% 0; }
          100% { background-position: -110% 0; }
        }
      `}</style>
    </motion.div>
  );
}

function FailedCard({ item }: { item: RenderItem }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4, ease: EASE }}
      className="relative w-full aspect-video rounded-xl overflow-hidden glass flex flex-col items-center justify-center gap-1.5"
      style={{ border: "1px dashed rgba(0,0,0,0.15)" }}
    >
      <Film className="w-5 h-5" style={{ color: "var(--muted)" }} />
      <span className="text-sm" style={{ color: "var(--muted)" }}>
        didn&apos;t render
      </span>
      <span className="text-xs" style={{ color: "var(--muted)" }}>
        you weren&apos;t charged · ask your agent to try again
      </span>
    </motion.div>
  );
}

/* ── the lightbox — the prompt is the artifact ─────────────────────────── */

function Lightbox({ item, onClose }: { item: RenderItem; onClose: () => void }) {
  const { toast, showToast, dismissToast } = useToast();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  async function download() {
    if (!item.video_url) return;
    try {
      const res = await fetch(item.video_url);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "instaclaw-video.mp4";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      // CDN without CORS: hand the user the tab instead — still one click.
      window.open(item.video_url, "_blank", "noopener");
    }
  }
  async function copyPrompt() {
    if (!item.prompt) return;
    await navigator.clipboard.writeText(item.prompt).catch(() => {});
    showToast({ message: "Prompt copied. Text it to your agent with your tweak." });
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: EASE }}
      className="fixed inset-0 z-[90] flex items-center justify-center p-4 sm:p-8"
      style={{ background: "rgba(20,18,16,0.55)", backdropFilter: "blur(14px)" }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.97, y: 4 }}
        transition={{ duration: 0.35, ease: EASE }}
        className="w-full max-w-4xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="rounded-2xl overflow-hidden"
          style={{ background: "#000", boxShadow: "rgba(0,0,0,0.45) 0px 24px 80px 0px" }}
        >
          {item.video_url ? (
            <video
              src={item.video_url}
              controls
              autoPlay
              loop
              playsInline
              className="w-full max-h-[68vh] object-contain"
            />
          ) : (
            <div className="aspect-video flex items-center justify-center text-sm" style={{ color: "rgba(255,255,255,0.5)" }}>
              this clip has expired upstream
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-col sm:flex-row sm:items-end gap-4">
          <div className="flex-1 min-w-0">
            {item.prompt && (
              <>
                <p className="text-[11px] uppercase tracking-wide mb-1" style={{ color: "rgba(255,255,255,0.55)" }}>
                  your words
                </p>
                <p
                  className="text-lg leading-snug"
                  style={{ color: "rgba(255,255,255,0.95)", fontFamily: "var(--font-serif)" }}
                >
                  &ldquo;{item.prompt}&rdquo;
                </p>
              </>
            )}
            <p className="text-xs mt-2" style={{ color: "rgba(255,255,255,0.5)" }}>
              {item.label} · {new Date(item.created_at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}
              {item.provenance === "seed" && " · on us"}
              {item.provenance === "plan" && " · plan video"}
              {item.provenance === "free" && " · free clip"}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {item.prompt && (
              <button
                onClick={copyPrompt}
                className="px-3.5 py-2 rounded-lg text-sm font-medium cursor-pointer transition-all hover:opacity-80 flex items-center gap-1.5"
                style={{ background: "rgba(255,255,255,0.12)", color: "#fff", backdropFilter: "blur(8px)" }}
              >
                <Copy className="w-3.5 h-3.5" /> Copy prompt
              </button>
            )}
            {item.video_url && (
              <button
                onClick={download}
                className="px-3.5 py-2 rounded-lg text-sm font-semibold cursor-pointer transition-all hover:opacity-90 flex items-center gap-1.5"
                style={{
                  background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                  boxShadow: "rgba(255,255,255,0.2) 0px 2px 2px 0px inset, rgba(220,103,67,0.35) 0px 4px 16px 0px",
                  color: "#fff",
                }}
              >
                <Download className="w-3.5 h-3.5" /> Download
              </button>
            )}
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-2 rounded-lg cursor-pointer transition-opacity hover:opacity-70"
              style={{ color: "rgba(255,255,255,0.7)" }}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      </motion.div>
      <ToastViewport toast={toast} onDismiss={dismissToast} />
    </motion.div>
  );
}

/* ── the empty state — the ghost receipts that sell ────────────────────── */

const GHOSTS = [
  { prompt: "a samurai walking through rain", tint: "rgba(76,93,128,0.35)" },
  { prompt: "my puppy chasing the sunset", tint: "rgba(220,103,67,0.30)" },
  { prompt: "a city growing out of the ocean", tint: "rgba(86,120,104,0.32)" },
];

function EmptyState({ seedAvailable }: { seedAvailable: boolean }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" aria-hidden>
        {GHOSTS.map((g, i) => (
          <motion.div
            key={g.prompt}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: i * 0.08, ease: EASE }}
            className="relative aspect-video rounded-xl overflow-hidden"
            style={{
              background: `linear-gradient(135deg, ${g.tint}, rgba(0,0,0,0.06) 60%), linear-gradient(-75deg, rgba(255,255,255,0.05), rgba(255,255,255,0.2), rgba(255,255,255,0.05))`,
              boxShadow: "rgba(0,0,0,0.05) 0px 2px 2px 0px inset, rgba(255,255,255,0.5) 0px -2px 2px 0px inset, rgba(0,0,0,0.06) 0px 2px 4px 0px",
            }}
          >
            <div className="absolute inset-x-0 bottom-0 p-3">
              <p className="text-xs italic" style={{ color: "rgba(51,51,52,0.62)", fontFamily: "var(--font-serif)" }}>
                &ldquo;{g.prompt}&rdquo;
              </p>
            </div>
            <span
              className="absolute top-2 right-2 text-[10px] px-1.5 py-0.5 rounded tabular-nums"
              style={{ background: "rgba(0,0,0,0.06)", color: "rgba(51,51,52,0.45)" }}
            >
              5s
            </span>
          </motion.div>
        ))}
      </div>
      <div className="text-center space-y-2">
        <p className="text-2xl" style={{ fontFamily: "var(--font-serif)" }}>
          Your agent turns a sentence into cinema.
        </p>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          {seedAvailable
            ? <>The first one&apos;s free. Text your agent: <em style={{ fontFamily: "var(--font-serif)" }}>&ldquo;make me a video of a fox leaping through snow&rdquo;</em></>
            : "Every video your agent makes lands here, ready to rewatch, download, and share."}
        </p>
      </div>
    </div>
  );
}

/* ── ③ the shelf (catalog single-source) ───────────────────────────────── */

function Shelf({
  plan, buying, onBuy,
}: {
  plan: VideoQuotas["plan"];
  buying: string | null;
  onBuy: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      {!plan && (
        <div className="glass rounded-xl p-5" style={{ border: "1px solid rgba(220,103,67,0.25)" }}>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
            <div>
              <p className="text-base" style={{ fontFamily: "var(--font-serif)" }}>
                Video Creator Plan
              </p>
              <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                42 premium videos every month · $1.07 a video, our best rate · cancel anytime
              </p>
            </div>
            <button
              onClick={() => onBuy("video_plan_monthly")}
              disabled={buying !== null}
              className="shrink-0 px-5 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer disabled:opacity-50"
              style={{
                background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                boxShadow: "rgba(255,255,255,0.2) 0px 2px 2px 0px inset, rgba(220,103,67,0.35) 0px 4px 16px 0px",
                color: "#fff",
              }}
            >
              {buying === "video_plan_monthly" ? "Opening checkout..." : "Subscribe · $44.99/mo"}
            </button>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {VIDEO_PACKS.map((pack: CatalogPack) => (
          <button
            key={pack.id}
            onClick={() => onBuy(pack.id)}
            disabled={buying !== null}
            className="glass rounded-xl p-4 text-left cursor-pointer transition-all disabled:opacity-50"
            style={{
              border: pack.best ? "1.5px solid rgba(220,103,67,0.3)" : "1px solid var(--border)",
              background: pack.best ? "rgba(220,103,67,0.03)" : undefined,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-1px)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = ""; }}
          >
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-semibold">{pack.title}</span>
                <span className="text-xs block" style={{ color: "var(--muted)" }}>
                  {pack.perUnit}
                </span>
              </div>
              <span
                className="text-sm font-bold px-3 py-1.5 rounded-lg"
                style={{
                  background: pack.best ? "linear-gradient(135deg, #c75a34, #DC6743)" : "rgba(0,0,0,0.05)",
                  color: pack.best ? "#fff" : "var(--accent)",
                }}
              >
                {buying === pack.id ? "..." : pack.price}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── the page ──────────────────────────────────────────────────────────── */

const FILTERS = [
  { id: "all", label: "All" },
  { id: "premium", label: "Premium" },
  { id: "quick", label: "Quick clips" },
];

export default function VideosPage() {
  const [filter, setFilter] = useState("all");
  const { quotas, renders, loaded, loadMore, hasMore, loadingMore } = useVideos(filter);
  const [open, setOpen] = useState<RenderItem | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const { toast, showToast, dismissToast } = useToast();
  const shelfRef = useRef<HTMLDivElement | null>(null);

  async function handleBuy(packId: string) {
    setBuying(packId);
    try {
      const res = await fetch("/api/billing/credit-pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // return_to: the buyer comes back HERE — the seller page closes its
        // own loop (allow-listed server-side, never an open redirect).
        body: JSON.stringify({ pack: packId, return_to: "/videos" }),
      });
      const data = await res.json();
      if (res.ok && data.url) { window.location.href = data.url; return; }
      showToast({ message: data.error || "Checkout failed. Please try again.", variant: "error" });
    } catch {
      showToast({ message: "Network error. Please try again.", variant: "error" });
    }
    setBuying(null);
  }

  // Post-checkout return: Stripe lands the buyer back here with the success
  // params. Pack-aware confirmation via the toast primitive (overlay, never
  // layout shift) + fresh clip balance — same pattern as the dashboard's.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const purchased = params.get("credits") === "purchased";
    const subscribed = params.get("plan") === "video_subscribed";
    if (!purchased && !subscribed) return;
    const packId = params.get("pack");
    window.history.replaceState({}, "", "/videos");
    (async () => {
      if (subscribed) {
        showToast({ message: "Welcome to the creator plan · 42 premium videos every month" });
        return;
      }
      const pack = VIDEO_PACKS.find((p) => p.id === packId);
      let suffix = "";
      try {
        const d = await fetch("/api/credits/video").then((r) => r.json());
        if (typeof d.clips === "number") suffix = ` · balance: ${d.clips} videos`;
      } catch { /* title-only is honest */ }
      showToast({ message: pack ? `${pack.title} added${suffix}` : `Credits added${suffix}` });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scrollToShelf = () =>
    shelfRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });

  // month grouping
  const groups = useMemo(() => {
    const map = new Map<string, RenderItem[]>();
    for (const r of renders) {
      const k = new Date(r.created_at).toLocaleDateString(undefined, { month: "long", year: "numeric" });
      (map.get(k) ?? map.set(k, []).get(k)!).push(r);
    }
    return [...map.entries()];
  }, [renders]);

  return (
    <div className="space-y-8" data-tour="page-videos">
      <div>
        <h1
          className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Videos
        </h1>
        <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
          Everything your agent has made for you, and the fuel to make more.
        </p>
      </div>

      {/* ① quota band */}
      {quotas ? (
        <QuotaBand
          quotas={quotas}
          onShopClick={scrollToShelf}
          hideSeedChip={loaded && renders.length === 0 && filter === "all"}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="glass rounded-xl h-[104px] animate-pulse" style={{ border: "1px solid var(--border)" }} />
          ))}
        </div>
      )}

      {/* ② gallery — the true EmptyState only when "All" is genuinely empty;
          a filtered zero keeps the chips mounted (no way-back trap) */}
      {loaded && renders.length === 0 && filter === "all" ? (
        <EmptyState seedAvailable={quotas?.seed_available ?? true} />
      ) : (
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className="px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer transition-all"
                style={
                  filter === f.id
                    ? { background: "var(--foreground)", color: "var(--background)" }
                    : { background: "rgba(0,0,0,0.05)", color: "var(--muted)" }
                }
              >
                {f.label}
              </button>
            ))}
          </div>

          {loaded && renders.length === 0 && (
            <p className="text-sm py-6 text-center" style={{ color: "var(--muted)" }}>
              {filter === "premium"
                ? "No premium videos yet · your cinematic renders will land here"
                : "No quick clips yet · free image-to-video clips will land here"}
            </p>
          )}

          {groups.map(([month, items]) => (
            <div key={month} className="space-y-3">
              <h2 className="text-sm font-medium" style={{ color: "var(--muted)" }}>
                {month}
              </h2>
              <div
                className="grid gap-4"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}
              >
                <AnimatePresence mode="popLayout">
                  {items.map((item) =>
                    item.status === "pending" ? (
                      <PendingCard key={item.request_id} item={item} />
                    ) : item.status === "failed" ? (
                      <FailedCard key={item.request_id} item={item} />
                    ) : (
                      <RenderCard key={item.request_id} item={item} onOpen={() => setOpen(item)} />
                    ),
                  )}
                </AnimatePresence>
              </div>
            </div>
          ))}

          {hasMore && (
            <div className="flex justify-center">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="px-4 py-2 rounded-lg text-sm cursor-pointer transition-all hover:opacity-70 disabled:opacity-50"
                style={{ color: "var(--muted)" }}
              >
                {loadingMore ? "Loading..." : "Show more"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ③ the shelf */}
      <div ref={shelfRef} className="pt-2 space-y-3">
        <div>
          <h2 className="text-xl font-normal" style={{ fontFamily: "var(--font-serif)" }}>
            More videos
          </h2>
          <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
            Premium text-to-video in widescreen 16:9. Your monthly plan videos always get used first.
          </p>
        </div>
        <Shelf plan={quotas?.plan ?? null} buying={buying} onBuy={handleBuy} />
      </div>

      <AnimatePresence>
        {open && <Lightbox item={open} onClose={() => setOpen(null)} />}
      </AnimatePresence>
      <ToastViewport toast={toast} onDismiss={dismissToast} />
    </div>
  );
}
