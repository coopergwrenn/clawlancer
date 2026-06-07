/**
 * Shared display vocabulary for the /economy surface.
 *
 * Single source for how a counterparty / decision is NAMED and described, so the
 * activity feed (economy-activity-feed) and the relationships card
 * (economy-counterparties) can never disagree about what the same supplier is
 * called or what category a purchase belongs to. Extracted verbatim from the feed
 * (Rule 14 — duplicated label logic drifts: tweak the feed's naming later and a
 * second copy silently keeps the old format). These are pure, module-level
 * helpers/data — no React state, no I/O.
 */
import type { CSSProperties } from "react";
import {
  Bot,
  Database,
  Search,
  Cpu,
  Image as ImageIcon,
  TrendingUp,
  Coins,
  Sparkles,
} from "lucide-react";

// ── shared design tokens ──────────────────────────────────────────────────────
export const ACCENT = "var(--accent, #DC6743)";
export const SUCCESS = "var(--success, #16a34a)";
export const SERIF = "var(--font-serif)";
export const EASE = [0.23, 1, 0.32, 1] as const;
// the one red, reserved for the rare decision that didn't go through.
export const FAIL = "rgb(192,74,60)";

// a warm cream disc for a leading glyph — present + dimensional against the
// near-white card, not a faint or flat-gray tile.
export const ICON_DISC_SPEND: CSSProperties = {
  background: "linear-gradient(155deg, rgba(255,253,251,0.95), rgba(242,231,223,0.95))",
  border: "1px solid rgba(0,0,0,0.05)",
  boxShadow: "0 1px 2px rgba(120,70,50,0.06), inset 0 1px 0 rgba(255,255,255,0.85)",
};
export const ICON_DISC_EARN: CSSProperties = {
  background: "linear-gradient(155deg, rgba(244,253,247,0.95), rgba(214,246,224,0.9))",
  border: "1px solid rgba(34,197,94,0.22)",
  boxShadow: "0 1px 2px rgba(34,120,70,0.07), inset 0 1px 0 rgba(255,255,255,0.85)",
};

// ── formatting ────────────────────────────────────────────────────────────────
export function fmtRelTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// A clean supplier label, NEVER a raw IP or port (which reads like debug output
// in an otherwise-premium surface). For an IP host we surface the meaningful
// path segment ("canary-echo"); for a real supplier the registrable domain
// ("polymarket.com"). Version/api path noise is stripped. Used by both the feed
// row and the relationships card so neither ever shows an IP.
export function serviceLabel(endpoint?: string | null): string | null {
  if (!endpoint) return null;
  try {
    const u = new URL(endpoint);
    const host = u.hostname;
    const segs = u.pathname
      .split("/")
      .filter(Boolean)
      .filter((s) => !/^v\d+$/i.test(s) && s.toLowerCase() !== "api");
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === "localhost";
    if (isIp) return segs.pop() || "external service";
    const domain = host.replace(/^www\./, "");
    const parts = domain.split(".");
    return parts.length >= 2 ? parts.slice(-2).join(".") : domain;
  } catch {
    return null;
  }
}

// ── category vocabulary — what a purchase IS, in the agent's own voice ─────────
// CAT is a CHARACTER-IDENTICAL lift of the feed's inline map (Rule 14). CAT_SHORT
// is an additive compact label used by the relationships card only — kept separate
// so CAT stays byte-for-byte what the feed rendered.
export const CAT: Record<string, { spend: string; earn: string; noun: string; icon: typeof Bot }> = {
  agent: { spend: "Hired another agent", earn: "Did a job for another agent", noun: "another agent", icon: Bot },
  data: { spend: "Bought live data", earn: "Sold live data", noun: "a data feed", icon: Database },
  search: { spend: "Ran a web search", earn: "Searched for a client", noun: "a search", icon: Search },
  inference: { spend: "Ran an inference", earn: "Sold an inference", noun: "an inference", icon: Sparkles },
  compute: { spend: "Rented compute", earn: "Sold compute", noun: "compute", icon: Cpu },
  media: { spend: "Generated media", earn: "Sold media", noun: "media", icon: ImageIcon },
  market: { spend: "Pulled market data", earn: "Sold market data", noun: "market data", icon: TrendingUp },
  other: { spend: "Made a purchase", earn: "Earned from a service", noun: "a service", icon: Coins },
};
export const catMeta = (c?: string | null) => (c && CAT[c]) || CAT.other;

/** Compact category label for the relationships card ("Agent work", "Live data"). */
export const CAT_SHORT: Record<string, string> = {
  agent: "Agent work",
  data: "Live data",
  search: "Web search",
  inference: "Inference",
  compute: "Compute",
  media: "Media",
  market: "Market data",
  other: "Services",
};

export const STATUS: Record<string, { label: string; color: string }> = {
  settled: { label: "settled", color: SUCCESS },
  failed: { label: "didn’t go through", color: FAIL },
  pending: { label: "pending", color: "rgb(176,128,22)" },
  disputed: { label: "disputed", color: "rgb(176,128,22)" },
  refunded: { label: "refunded", color: "var(--muted)" },
};
export const statusMeta = (s: string) => STATUS[s] || { label: s, color: "var(--muted)" };
