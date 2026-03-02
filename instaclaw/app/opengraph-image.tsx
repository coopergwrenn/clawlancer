import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "InstaClaw.io — Your Personal AI Agent";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#f8f7f4",
          fontFamily: "serif",
          position: "relative",
        }}
      >
        {/* Accent border top */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 6,
            background: "#DC6743",
          }}
        />

        {/* Title */}
        <div
          style={{
            fontSize: 72,
            color: "#333334",
            letterSpacing: "-1.5px",
            marginBottom: 16,
          }}
        >
          InstaClaw.io
        </div>

        {/* Tagline */}
        <div
          style={{
            fontSize: 32,
            color: "#6b6b6b",
            maxWidth: 700,
            textAlign: "center",
            lineHeight: 1.4,
          }}
        >
          Your Personal AI Agent — Live in Minutes
        </div>

        {/* Bottom accent line */}
        <div
          style={{
            position: "absolute",
            bottom: 40,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            style={{
              width: 40,
              height: 2,
              background: "#DC6743",
            }}
          />
          <div
            style={{
              fontSize: 18,
              color: "#6b6b6b",
            }}
          >
            instaclaw.io
          </div>
          <div
            style={{
              width: 40,
              height: 2,
              background: "#DC6743",
            }}
          />
        </div>
      </div>
    ),
    { ...size }
  );
}
