/**
 * Item #5: Auto-generated launch card image — 2400x1260 PNG (2x retina).
 *
 * Twitter unfurls the URL in the share-to-X tweet
 * (https://instaclaw.io/launches/<addr>) and renders this image as the
 * link card preview. Bankr previously hosted this OG (we used their URL
 * in commit d9114898 as a quick win) — this PRD item brings it home with
 * InstaClaw branding while still crediting Bankr.
 *
 * Resolution: 2400x1260 (2x the OpenGraph spec of 1200x630). Social
 * platforms (X, Telegram, Discord) downscale to display size, so a 2x
 * source renders crisp on retina displays and high-DPI mobile. Every
 * dimension, font size, padding, and radius below is the 1x value × 2.
 *
 * Data flow:
 *   1. Token address comes from the URL param.
 *   2. Look up instaclaw_vms by bankr_token_address — fetch ticker, agent
 *      name, image URL.
 *   3. Render with next/og's ImageResponse (edge runtime).
 *
 * Fallbacks:
 *   - Token not in DB → render a generic InstaClaw card with the address.
 *   - No image URL stored (Path B chat-launch) → render ticker initials
 *     in a styled circle instead of the agent PFP.
 */

import { ImageResponse } from "next/og";
import { getSupabase } from "@/lib/supabase";

export const runtime = "edge";
export const alt = "InstaClaw — autonomous AI agent token launched on Base";
export const size = { width: 2400, height: 1260 };
export const contentType = "image/png";

interface Props {
  params: Promise<{ addr: string }>;
}

function isValidEvmAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

const INSTACLAW_ORANGE = "#DC6743";
const BG = "#0a0a0a";
const FG = "#ffffff";
const MUTED = "rgba(255,255,255,0.55)";
const BORDER = "rgba(255,255,255,0.12)";

function shortAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function cleanAgentName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let name = raw.trim();
  if (name.startsWith("@")) name = name.slice(1);
  name = name.replace(/[_-]?bot$/i, "");
  name = name.replace(/[\r\n\t]+/g, " ").replace(/[_-]+/g, " ");
  name = name.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  return name.length >= 2 ? name : null;
}

// ── Font loading ──
// Match production typography: Instrument Serif for headlines + the
// InstaClaw wordmark, Inter for body/UI, Roboto Mono for the contract
// address chip. Fetched from Google Fonts at first render and cached
// in module scope — survives across requests within an edge isolate.
//
// Google's CSS API serves WOFF2 to modern UAs (which Satori can't parse
// because it expects TTF/OTF). The Mozilla/5.0 UA spoof flips Google to
// the legacy TTF endpoint that Satori accepts.
type LoadedFont = { name: string; data: ArrayBuffer; weight: 400 | 600; style: "normal" };
let fontsCache: LoadedFont[] | null = null;

async function fetchGoogleTtf(family: string, weight: number): Promise<ArrayBuffer> {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${weight}&display=swap`;
  const css = await fetch(cssUrl, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.text());
  const m = css.match(/src:\s*url\(([^)]+?)\)\s+format\(['"]?(?:opentype|truetype)['"]?\)/);
  if (!m) throw new Error(`No TTF URL in Google Fonts CSS for ${family} ${weight}`);
  return fetch(m[1]).then((r) => r.arrayBuffer());
}

async function loadFonts(): Promise<LoadedFont[]> {
  if (fontsCache) return fontsCache;
  const [serif, inter400, inter600, mono] = await Promise.all([
    fetchGoogleTtf("Instrument Serif", 400),
    fetchGoogleTtf("Inter", 400),
    fetchGoogleTtf("Inter", 600),
    fetchGoogleTtf("Roboto Mono", 400),
  ]);
  fontsCache = [
    { name: "Instrument Serif", data: serif, weight: 400, style: "normal" },
    { name: "Inter", data: inter400, weight: 400, style: "normal" },
    { name: "Inter", data: inter600, weight: 600, style: "normal" },
    { name: "Roboto Mono", data: mono, weight: 400, style: "normal" },
  ];
  return fontsCache;
}

export default async function LaunchCard({ params }: Props) {
  const { addr } = await params;
  const lowerAddr = (addr ?? "").toLowerCase();
  const validAddr = isValidEvmAddress(lowerAddr);

  let symbol = "";
  let agentName: string | null = null;
  let imageUrl: string | null = null;

  if (validAddr) {
    try {
      const { data } = await getSupabase()
        .from("instaclaw_vms")
        .select("bankr_token_symbol, bankr_token_image_url, agent_name, telegram_bot_username")
        .ilike("bankr_token_address", lowerAddr)
        .maybeSingle();
      if (data) {
        symbol = (data.bankr_token_symbol ?? "").toUpperCase().trim();
        imageUrl = data.bankr_token_image_url ?? null;
        agentName = cleanAgentName(data.agent_name) ?? cleanAgentName(data.telegram_bot_username);
      }
    } catch {
      // DB blip OR pre-migration column-missing → render with no row
      // data. Never throw: Twitter caches OG-render errors aggressively.
    }
  }

  // When we have an address but no symbol (chat-launched, pre-migration,
  // or simply an unknown token) we lead with the truncated address so
  // the preview is informative rather than a generic "$TOKEN" placeholder.
  const ticker = symbol || (validAddr ? shortAddress(lowerAddr) : "TOKEN");
  const showAddressAsTicker = !symbol;
  const initials = (symbol || "TKN").slice(0, 3);
  const deployedBy = agentName ?? "an autonomous AI agent";

  // Cache for 1 hour — long enough that Twitter/X's crawler doesn't burn
  // our edge minutes on every recheck, short enough that an agent rename
  // or PFP regen propagates to share previews same-day. ImageResponse's
  // default is `public, immutable, max-age=31536000` (1y) which is wrong
  // here: the underlying data is mutable, so a stale image gets pinned
  // to a tweet forever.
  const headers = {
    "Cache-Control": "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
  };

  // Load fonts in parallel with the DB read above (already awaited).
  // Module-scoped cache means only the first request per edge isolate
  // pays the ~200KB font fetch.
  const fonts = await loadFonts();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: BG,
          color: FG,
          // Inter is the default for all body/UI text. Headlines and the
          // wordmark override to Instrument Serif inline; the address
          // chip overrides to Roboto Mono.
          fontFamily: "Inter",
          position: "relative",
          padding: 112,
        }}
      >
        {/* Top accent bar */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 12,
            background: INSTACLAW_ORANGE,
          }}
        />

        {/* Header row: InstaClaw mark + "TOKEN LAUNCH" eyebrow */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 80 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
            {/* Inverted (white-on-transparent) variant of /logo.png — the
                base logo is a black pixel crab and is invisible against
                the dark OG card background. logo-white.png was generated
                via Sharp's negate({alpha:false}) and committed to public/. */}
            <img
              src="https://instaclaw.io/logo-white.png"
              width={88}
              height={88}
              style={{ borderRadius: 20 }}
            />
            <div style={{ display: "flex", flexDirection: "column" }}>
              {/* Wordmark uses Instrument Serif to match the website
                  header treatment (--font-serif). Inter is for body/UI. */}
              <div style={{ fontSize: 52, fontFamily: "Instrument Serif", letterSpacing: "-0.6px", lineHeight: 1 }}>InstaClaw</div>
              <div style={{ fontSize: 24, color: MUTED, letterSpacing: "2.4px", textTransform: "uppercase", marginTop: 8 }}>
                Agent-Launched Token
              </div>
            </div>
          </div>
          {/* Base chain pill — official blue Base square (their actual
              brand mark; plain rounded blue rectangle is the canonical
              identity per github.com/base-org/brand-kit). 36px sits
              cleanly with the 28px caps text. marginRight, not gap. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              fontSize: 28,
              color: MUTED,
              letterSpacing: "3px",
              textTransform: "uppercase",
              padding: "16px 32px 16px 24px",
              border: `2px solid ${BORDER}`,
              borderRadius: 999,
            }}
          >
            <img
              src="https://instaclaw.io/base-logo.png"
              width={36}
              height={36}
              style={{ marginRight: 16, borderRadius: 6 }}
            />
            <span>Live on Base</span>
          </div>
        </div>

        {/* Body row: PFP + ticker + meta */}
        <div style={{ display: "flex", alignItems: "center", gap: 96, flex: 1 }}>
          {/* PFP / initials */}
          {imageUrl ? (
            <img
              src={imageUrl}
              width={640}
              height={640}
              style={{
                borderRadius: 72,
                border: `2px solid ${BORDER}`,
                objectFit: "cover",
              }}
            />
          ) : (
            <div
              style={{
                width: 640,
                height: 640,
                borderRadius: 72,
                background: `linear-gradient(135deg, ${INSTACLAW_ORANGE}, #8a3a1f)`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 192,
                fontWeight: 800,
                color: "#fff",
                letterSpacing: "-4px",
                border: `2px solid ${BORDER}`,
              }}
            >
              {initials}
            </div>
          )}

          {/* Right column: ticker + deployed-by + contract */}
          <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 32 }}>
            <div
              style={{
                // Long-token-address fallback shrinks to fit horizontally.
                // Ticker max 10 chars (DB-validated) — fit comfortably at 288.
                fontSize: showAddressAsTicker ? 96 : 288,
                letterSpacing: showAddressAsTicker ? "-2px" : "-6px",
                lineHeight: 1,
                color: FG,
                // $TICKER → Instrument Serif (matches website headlines).
                // Address-as-ticker fallback uses Roboto Mono for legibility.
                fontFamily: showAddressAsTicker ? "Roboto Mono" : "Instrument Serif",
              }}
            >
              {showAddressAsTicker ? ticker : `$${ticker}`}
            </div>
            {/* Satori (next/og) requires display:flex on any element with
                multiple children. Use marginRight on the leading span
                instead of flex `gap` — Satori doesn't reliably honor
                gap on flex layouts, which collapsed the visual space
                ("deployed byedgecity"). marginRight is universally
                respected. */}
            <div style={{ display: "flex", flexWrap: "wrap", fontSize: 56, color: MUTED, lineHeight: 1.3 }}>
              <span style={{ marginRight: 20 }}>deployed by</span>
              <span style={{ color: FG, fontWeight: 600 }}>{deployedBy}</span>
            </div>
            {/* Full contract address — marketing surface, screenshots
                need to show the entire 0x… string. fontSize 28 (2x of 14)
                fits the 42-char address inside the right column at 2400px
                width without horizontal overflow; monospace for legibility. */}
            {!showAddressAsTicker && (
              <div
                style={{
                  fontSize: 28,
                  color: MUTED,
                  fontFamily: "Roboto Mono",
                  marginTop: 16,
                  padding: "20px 28px",
                  background: "rgba(255,255,255,0.04)",
                  border: `2px solid ${BORDER}`,
                  borderRadius: 20,
                  alignSelf: "flex-start",
                  letterSpacing: "1px",
                }}
              >
                {lowerAddr}
              </div>
            )}
          </div>
        </div>

        {/* Footer: tagline + Bankr credit */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 64,
            paddingTop: 48,
            borderTop: `2px solid ${BORDER}`,
          }}
        >
          {/* Brand tagline — Instrument Serif matches the headline
              treatment (consistent voice with $TICKER + wordmark). */}
          <div style={{ fontSize: 52, color: FG, fontFamily: "Instrument Serif", lineHeight: 1 }}>
            agents that pay their own rent.
          </div>
          {/* "powered by Bankr" credit — Bankr's official pixel-art logo
              (their PWA icon, multicolor). Brand identity is intrinsically
              colorful so a "white version" wouldn't feel right; the colors
              still pop on the dark BG. Rounded corners match the visual
              language of the rest of the card. marginRight, not gap. */}
          <div style={{ display: "flex", alignItems: "center", fontSize: 32, color: MUTED }}>
            <span style={{ marginRight: 20 }}>powered by</span>
            <img
              src="https://instaclaw.io/bankr-logo.png"
              width={44}
              height={44}
              style={{ marginRight: 16, borderRadius: 10 }}
            />
            <span style={{ color: FG, fontWeight: 600 }}>Bankr</span>
          </div>
        </div>
      </div>
    ),
    { ...size, headers, fonts }
  );
}
