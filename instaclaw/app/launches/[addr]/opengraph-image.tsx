/**
 * Item #5: Auto-generated launch card image — 1200x630 PNG.
 *
 * Twitter unfurls the URL in the share-to-X tweet
 * (https://instaclaw.io/launches/<addr>) and renders this image as the
 * link card preview. Bankr previously hosted this OG (we used their URL
 * in commit d9114898 as a quick win) — this PRD item brings it home with
 * InstaClaw branding while still crediting Bankr.
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
export const size = { width: 1200, height: 630 };
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
          fontFamily: "system-ui, -apple-system, sans-serif",
          position: "relative",
          padding: 56,
        }}
      >
        {/* Top accent bar */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 6,
            background: INSTACLAW_ORANGE,
          }}
        />

        {/* Header row: InstaClaw mark + "TOKEN LAUNCH" eyebrow */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 40 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <img
              src="https://instaclaw.io/logo.png"
              width={44}
              height={44}
              style={{ borderRadius: 10 }}
            />
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.3px" }}>InstaClaw</div>
              <div style={{ fontSize: 14, color: MUTED, letterSpacing: "1.2px", textTransform: "uppercase" }}>
                Autonomous Agent Token
              </div>
            </div>
          </div>
          <div
            style={{
              fontSize: 14,
              color: MUTED,
              letterSpacing: "1.5px",
              textTransform: "uppercase",
              padding: "8px 14px",
              border: `1px solid ${BORDER}`,
              borderRadius: 999,
            }}
          >
            Live on Base
          </div>
        </div>

        {/* Body row: PFP + ticker + meta */}
        <div style={{ display: "flex", alignItems: "center", gap: 48, flex: 1 }}>
          {/* PFP / initials */}
          {imageUrl ? (
            <img
              src={imageUrl}
              width={320}
              height={320}
              style={{
                borderRadius: 36,
                border: `1px solid ${BORDER}`,
                objectFit: "cover",
              }}
            />
          ) : (
            <div
              style={{
                width: 320,
                height: 320,
                borderRadius: 36,
                background: `linear-gradient(135deg, ${INSTACLAW_ORANGE}, #8a3a1f)`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 96,
                fontWeight: 800,
                color: "#fff",
                letterSpacing: "-2px",
                border: `1px solid ${BORDER}`,
              }}
            >
              {initials}
            </div>
          )}

          {/* Right column: ticker + deployed-by + contract */}
          <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 16 }}>
            <div
              style={{
                // Long-token-address fallback shrinks to fit horizontally.
                // Ticker max 10 chars (DB-validated) — fit comfortably at 128.
                fontSize: showAddressAsTicker ? 56 : 128,
                fontWeight: 800,
                letterSpacing: showAddressAsTicker ? "-1px" : "-4px",
                lineHeight: 1,
                color: FG,
                fontFamily: showAddressAsTicker
                  ? "monospace"
                  : "system-ui, -apple-system, sans-serif",
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
            <div style={{ display: "flex", flexWrap: "wrap", fontSize: 28, color: MUTED, lineHeight: 1.3 }}>
              <span style={{ marginRight: 10 }}>deployed by</span>
              <span style={{ color: FG, fontWeight: 600 }}>{deployedBy}</span>
            </div>
            {/* Full contract address — marketing surface, screenshots
                need to show the entire 0x… string. fontSize 14 fits the
                42-char address inside the right column at 1200px width
                without horizontal overflow; monospace for legibility. */}
            {!showAddressAsTicker && (
              <div
                style={{
                  fontSize: 14,
                  color: MUTED,
                  fontFamily: "monospace",
                  marginTop: 8,
                  padding: "10px 14px",
                  background: "rgba(255,255,255,0.04)",
                  border: `1px solid ${BORDER}`,
                  borderRadius: 10,
                  alignSelf: "flex-start",
                  letterSpacing: "0.5px",
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
            marginTop: 32,
            paddingTop: 24,
            borderTop: `1px solid ${BORDER}`,
          }}
        >
          <div style={{ fontSize: 22, color: FG, fontWeight: 500 }}>
            agents that pay their own rent.
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, color: MUTED }}>
            <span>powered by</span>
            <span style={{ color: FG, fontWeight: 600 }}>Bankr</span>
          </div>
        </div>
      </div>
    ),
    { ...size, headers }
  );
}
