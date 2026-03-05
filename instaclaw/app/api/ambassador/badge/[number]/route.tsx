import { ImageResponse } from "next/og";
import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";

// ── Cached assets (loaded once at module init) ──

const logoB64 = (() => {
  const buf = readFileSync(join(process.cwd(), "public/logo.png"));
  return `data:image/png;base64,${buf.toString("base64")}`;
})();

const crabPatternB64 = (() => {
  const buf = readFileSync(join(process.cwd(), "public/crab-pattern.jpg"));
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
})();

// Fetch Instrument Serif TTF from Google Fonts (cached in module scope)
let fontDataPromise: Promise<ArrayBuffer> | null = null;

function getFontData(): Promise<ArrayBuffer> {
  if (!fontDataPromise) {
    fontDataPromise = fetch(
      "https://fonts.googleapis.com/css2?family=Instrument+Serif&display=swap"
    )
      .then((r) => r.text())
      .then((css) => {
        const match = css.match(/src:\s*url\(([^)]+)\)/);
        if (!match) throw new Error("Could not find font URL in CSS");
        return fetch(match[1]);
      })
      .then((r) => r.arrayBuffer());
  }
  return fontDataPromise;
}

// ── Route handler ──

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ number: string }> }
) {
  const { number } = await params;

  if (!/^\d{1,3}$/.test(number)) {
    return NextResponse.json({ error: "Invalid number" }, { status: 400 });
  }

  const paddedNum = number.padStart(3, "0");

  try {
    const fontData = await getFontData();

    return new ImageResponse(
      (
        <div
          style={{
            width: 680,
            height: 680,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 44,
            background: "linear-gradient(165deg, #fafafa 0%, #f5f5f5 50%, #f0f0f0 100%)",
            border: "1px solid rgba(230,230,230,0.8)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.06)",
            position: "relative",
            overflow: "hidden",
            fontFamily: "Instrument Serif",
          }}
        >
          {/* Crab pattern watermark — opacity higher than CSS card (0.06)
              because Satori renders opacity differently and vignette covers center */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: 680,
              height: 680,
              backgroundImage: `url(${crabPatternB64})`,
              backgroundSize: "360px 360px",
              backgroundRepeat: "repeat",
              opacity: 0.15,
            }}
          />

          {/* Vignette — clears center for text, lets pattern show at edges */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: 680,
              height: 680,
              background:
                "radial-gradient(circle at 50% 46%, rgba(255,255,255,0.98) 0%, rgba(255,255,255,0.85) 25%, rgba(255,255,255,0.3) 55%, transparent 75%)",
            }}
          />

          {/* Verified badge — top-right, glassmorphic */}
          <div
            style={{
              position: "absolute",
              top: 32,
              right: 32,
              fontSize: 18,
              letterSpacing: "0.08em",
              color: "#DC6743",
              backgroundColor: "rgba(255,255,255,0.65)",
              padding: "8px 20px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.5)",
              boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
              display: "flex",
            }}
          >
            VERIFIED
          </div>

          {/* Logo with orange glow */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
              marginBottom: 16,
            }}
          >
            {/* Orange glow behind logo */}
            <div
              style={{
                position: "absolute",
                width: 280,
                height: 280,
                borderRadius: 9999,
                background:
                  "radial-gradient(circle at center, rgba(220,103,67,0.18) 0%, rgba(220,103,67,0.06) 50%, transparent 75%)",
              }}
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={logoB64}
              width={152}
              height={152}
              alt=""
            />
          </div>

          {/* AMBASSADOR — 27px * 2 */}
          <div
            style={{
              fontSize: 54,
              letterSpacing: "0.22em",
              color: "#2d2d2e",
              lineHeight: 1,
              display: "flex",
            }}
          >
            AMBASSADOR
          </div>

          {/* INSTACLAW — 13.5px * 2, orange */}
          <div
            style={{
              fontSize: 27,
              letterSpacing: "0.18em",
              color: "#DC6743",
              marginTop: 24,
              display: "flex",
            }}
          >
            INSTACLAW
          </div>

          {/* Thin separator line — gradient orange to tan */}
          <div
            style={{
              width: 112,
              height: 2,
              background: "linear-gradient(90deg, transparent 0%, rgba(220,103,67,0.35) 50%, transparent 100%)",
              marginTop: 40,
              marginBottom: 40,
            }}
          />

          {/* AMBASSADOR #NNN — 11px * 2 */}
          <div
            style={{
              fontSize: 22,
              letterSpacing: "0.2em",
              color: "#9ca3af",
              display: "flex",
            }}
          >
            AMBASSADOR #{paddedNum}
          </div>
        </div>
      ),
      {
        width: 680,
        height: 680,
        headers: {
          "Cache-Control": "public, max-age=31536000, immutable",
        },
        fonts: [
          {
            name: "Instrument Serif",
            data: fontData,
            weight: 400,
            style: "normal",
          },
        ],
      }
    );
  } catch (err) {
    console.error("Badge generation error:", err);
    return NextResponse.json(
      { error: "Failed to generate badge" },
      { status: 500 }
    );
  }
}
