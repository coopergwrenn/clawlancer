import { LenisProvider } from "@/components/landing/lenis-provider";

/**
 * /edge — pure Edge brand chrome.
 *
 * Pulled out of (marketing) so we escape SiteHeader (InstaClaw orange + nav)
 * and SiteFooter (InstaClaw links). The page renders its own minimal
 * Edge-styled header + footer, per partner PRD §5.1: "pre-signup pure Edge
 * brand, Powered by InstaClaw in footer only."
 *
 * LenisProvider kept for smooth scroll (matches the rest of the marketing
 * site UX).
 *
 * CSS variables for the Edge palette:
 *   --edge-bg          warm off-white page background
 *   --edge-ink         near-black warm body color
 *   --edge-ink-soft    muted variant for secondary copy
 *   --edge-olive       dark olive — primary brand accent (button + heading hits)
 *   --edge-olive-hover deeper olive for button hover
 *   --edge-sage        light sage — hover/secondary surface
 *   --edge-line        hairline border color
 */
export default function EdgeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <LenisProvider>
      <div
        data-theme="edge"
        style={
          {
            "--edge-bg": "#FAFAF7",
            "--edge-ink": "#0E0F0B",
            "--edge-ink-soft": "#5A5C53",
            "--edge-olive": "#29311E",
            "--edge-olive-hover": "#1B210F",
            "--edge-sage": "#E4F0D2",
            "--edge-line": "rgba(14, 15, 11, 0.10)",
            "--edge-line-soft": "rgba(14, 15, 11, 0.06)",
            background: "var(--edge-bg)",
            color: "var(--edge-ink)",
            minHeight: "100vh",
          } as React.CSSProperties
        }
      >
        {children}
      </div>
    </LenisProvider>
  );
}
