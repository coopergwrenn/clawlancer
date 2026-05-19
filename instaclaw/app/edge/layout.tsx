/**
 * /edge — pure Edge brand chrome with the edgeclaw-site cream/forest palette.
 *
 * Scroll behavior is intentionally the browser's native scroll — we removed
 * the LenisProvider wrapper that the rest of the marketing site uses, so the
 * cinematic in HealdsburgMap is the only thing that ever modifies scroll, and
 * only over its own section. The (marketing) route-group layout still wraps
 * non-/edge pages in LenisProvider, so smooth-scroll elsewhere is unchanged.
 *
 * CSS variables for the Edge palette (single source of truth so styling never
 * leaks into a parent shell):
 *   --edge-bg          warm cream page background
 *   --edge-ink         warm dark olive body text
 *   --edge-ink-soft    muted variant for secondary copy
 *   --edge-olive       deep forest — primary CTA + heading hits
 *   --edge-olive-hover deeper forest for button hover
 *   --edge-sage        light sage — secondary surface
 *   --edge-line        hairline border color
 *
 * The values are aligned with globals.css ([data-theme="edge"] block —
 * --cream, --forest-deep, --sage, etc.) so EdgeCityClient and the new
 * section components share a single palette.
 */
export default function EdgeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      data-theme="edge"
      style={
        {
          "--edge-bg": "#f4ede0",
          "--edge-ink": "#29311e",
          "--edge-ink-soft": "rgba(26, 24, 20, 0.78)",
          "--edge-olive": "#0f1a12",
          "--edge-olive-hover": "#2d3f29",
          "--edge-sage": "#dde5cc",
          "--edge-sage-light": "#a8c0a1",
          "--edge-line": "rgba(26, 24, 20, 0.18)",
          "--edge-line-soft": "rgba(26, 24, 20, 0.08)",
          background: "var(--edge-bg)",
          color: "var(--edge-ink)",
          minHeight: "100vh",
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}
