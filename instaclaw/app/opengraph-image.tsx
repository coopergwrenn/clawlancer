/**
 * Canonical OG card — the rich preview that renders when any
 * instaclaw.io URL gets shared (Twitter/X, iMessage, Telegram,
 * Discord, Slack, LinkedIn, link previews on Mac/iOS quicklook).
 *
 * Especially load-bearing for the channel-onboarding W3 link:
 * the user just got "instaclaw.io/go/<code>" in iMessage and
 * iMessage's preview crawler hits this card. Has to look like
 * it belongs to the landing page.
 *
 * Visual recipe (frozen frame of the landing-page hero):
 *   - Cream #f8f7f4 background (exact match: globals.css --bg).
 *   - Soft coral + blue atmospheric radials in opposite corners
 *     (same recipe as /channels page background).
 *   - Pixel-crab + "instaclaw" wordmark top-left (same treatment
 *     as the site header).
 *   - Big Instrument Serif headline in the center: "Your personalized
 *     agent / with its own computer." — exact landing copy with the
 *     cycling word frozen on "computer" (position 0 of the cycle,
 *     and a literal callback to W1's "fresh linux computer spinning
 *     up" — narrative continuity with the message the user just got).
 *   - "computer" rendered in coral #E96F4D (the new vibrant value
 *     from 2026-05-25 — NOT the older #DC6743).
 *   - Quiet "instaclaw.io" mark bottom-right for source attribution.
 *
 * Implementation notes:
 *   - 1200x630 per OG spec; iMessage downscales to ~280px wide,
 *     Twitter shows ~600px wide. Detail at 1200 is enough.
 *   - Edge runtime + Satori. Cooper's launches OG already pioneered
 *     Google Fonts → TTF spoof so we reuse the pattern.
 *   - Background atmosphere uses radial-gradient strings (Satori
 *     supports them as CSS background values).
 *   - Cache 6 hours: not vm-specific, but the design itself can
 *     evolve and we don't want a 1-year cache pinning a stale image
 *     onto every cached W3 message ever sent.
 */

import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "instaclaw — your personalized agent, with its own computer.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#f8f7f4";        // cream — globals.css --bg
const INK = "#333334";       // primary text — globals.css --fg
const MUTED = "#6b6b6b";     // muted text — globals.css --muted
const CORAL = "#E96F4D";     // vibrant coral — bumped 2026-05-25

// Reuse the launches/opengraph-image font-loading pattern: Google
// Fonts CSS API serves WOFF2 by default which Satori can't parse;
// Mozilla/5.0 UA spoof flips it to the legacy TTF endpoint.
type LoadedFont = { name: string; data: ArrayBuffer; weight: 400; style: "normal" | "italic" };
let fontsCache: LoadedFont[] | null = null;

async function fetchGoogleTtf(family: string, weight: number, italic: boolean): Promise<ArrayBuffer> {
  const axis = italic ? "ital,wght" : "wght";
  const val = italic ? `1,${weight}` : `${weight}`;
  const cssUrl = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:${axis}@${val}&display=swap`;
  const css = await fetch(cssUrl, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.text());
  const m = css.match(/src:\s*url\(([^)]+?)\)\s+format\(['"]?(?:opentype|truetype)['"]?\)/);
  if (!m) throw new Error(`No TTF URL in Google Fonts CSS for ${family} ${weight} italic=${italic}`);
  return fetch(m[1]).then((r) => r.arrayBuffer());
}

async function loadFonts(): Promise<LoadedFont[]> {
  if (fontsCache) return fontsCache;
  const [serifRoman, serifItalic] = await Promise.all([
    fetchGoogleTtf("Instrument Serif", 400, false),
    fetchGoogleTtf("Instrument Serif", 400, true),
  ]);
  fontsCache = [
    { name: "Instrument Serif", data: serifRoman, weight: 400, style: "normal" },
    { name: "Instrument Serif", data: serifItalic, weight: 400, style: "italic" },
  ];
  return fontsCache;
}

export default async function Image() {
  const fonts = await loadFonts();

  // 6h edge cache. Long enough that iMessage's crawler isn't pounding
  // us on every send; short enough that a copy iteration (e.g. swapping
  // "computer" for "wallet" later) propagates same-day to new previews.
  // Per-tweet/per-thread caches at downstream platforms can pin older
  // versions for longer — that's their behavior, not ours.
  const headers = {
    "Cache-Control": "public, max-age=21600, s-maxage=21600, stale-while-revalidate=86400",
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
          // Satori reads `backgroundImage` for layered backgrounds.
          // Two soft radial glows — coral top-right, blue bottom-left,
          // very low opacity — same recipe as the channels page.
          // The base cream still shows through; the radials add warmth
          // and depth without distracting from the headline.
          backgroundImage: [
            "radial-gradient(circle at 90% 8%, rgba(233,111,77,0.18), transparent 55%)",
            "radial-gradient(circle at 10% 95%, rgba(95,140,180,0.10), transparent 50%)",
            "radial-gradient(circle at 92% 92%, rgba(220,103,67,0.06), transparent 60%)",
          ].join(", "),
          fontFamily: "Instrument Serif",
          position: "relative",
          padding: "72px 80px",
        }}
      >
        {/* Top-left: pixel-crab mark + wordmark.
            Matches the site header (components/marketing/site-header.tsx:30-45). */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <img
            src="https://instaclaw.io/logo.png"
            width={48}
            height={48}
            style={{
              imageRendering: "pixelated",
            }}
          />
          <div
            style={{
              fontFamily: "Instrument Serif",
              fontSize: 36,
              letterSpacing: "-0.8px",
              color: INK,
              lineHeight: 1,
            }}
          >
            instaclaw
          </div>
        </div>

        {/* Centered headline block. Flex-1 lets it absorb the vertical
            space between the top mark and the bottom attribution.
            justifyContent center pins it visually. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            justifyContent: "center",
            alignItems: "flex-start",
            // Pull up slightly so the headline reads as the optical
            // center, not geometric (compensates for the top mark
            // having less visual weight than the bottom line).
            marginTop: -20,
          }}
        >
          {/* Line 1 — matches landing exactly. */}
          <div
            style={{
              fontFamily: "Instrument Serif",
              fontSize: 100,
              letterSpacing: "-2.5px",
              lineHeight: 1.02,
              color: INK,
            }}
          >
            Your personalized agent
          </div>

          {/* Line 2 — "with its own [coral]computer.[/]" — the period
              stays in ink because it's structural, not part of the
              cycling word. Satori requires `display:flex` on any
              element with multiple children — using marginRight on
              the leading span to space "own" from the coral word. */}
          <div
            style={{
              display: "flex",
              fontFamily: "Instrument Serif",
              fontSize: 100,
              letterSpacing: "-2.5px",
              lineHeight: 1.02,
              color: INK,
              marginTop: 4,
            }}
          >
            <span style={{ marginRight: 24 }}>with its own</span>
            <span style={{ color: CORAL }}>computer.</span>
          </div>

          {/* Subtle benefit line, mirrors landing's hero subhead but
              tightened for OG card readability at small render sizes.
              Italic Instrument Serif feels editorial — sets InstaClaw
              apart from boilerplate gray-card OG previews. */}
          <div
            style={{
              fontFamily: "Instrument Serif",
              fontStyle: "italic",
              fontSize: 36,
              color: MUTED,
              marginTop: 36,
              letterSpacing: "-0.4px",
              lineHeight: 1.3,
            }}
          >
            never forgets a detail. never sleeps. live in minutes.
          </div>
        </div>

        {/* Bottom row: url left, hairline right. The hairline gives
            the card a visual base — matches the landing's bottom
            atmosphere where the gradient fades into the page edge. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 8,
          }}
        >
          <div
            style={{
              fontFamily: "Instrument Serif",
              fontSize: 24,
              color: MUTED,
              letterSpacing: "-0.2px",
              display: "flex",
              alignItems: "center",
            }}
          >
            <span style={{ marginRight: 10, color: CORAL, opacity: 0.85 }}>→</span>
            <span>instaclaw.io</span>
          </div>
          {/* No-op spacer — using space-between requires two children.
              The empty div is intentional. */}
          <div />
        </div>
      </div>
    ),
    { ...size, headers, fonts },
  );
}
