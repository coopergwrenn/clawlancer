/**
 * Fixed-position sky gradient + soft cloud SVGs.
 * Sits behind every section so the page reads as one warm
 * sky-to-cream wash from top to bottom (edgeclaw-site signature).
 */
export function SkyBackdrop() {
  return (
    <div
      aria-hidden
      className="fixed inset-0 -z-10 pointer-events-none overflow-hidden"
    >
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, #d4e2e8 0%, #e8e6d4 22%, #f4ede0 45%, #f4ede0 70%, #ede2cf 100%)",
        }}
      />
      <svg
        className="absolute inset-0 w-full h-full opacity-[0.85]"
        viewBox="0 0 1600 900"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <radialGradient id="cloud1" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.95)" />
            <stop offset="60%" stopColor="rgba(255,251,240,0.4)" />
            <stop offset="100%" stopColor="rgba(255,251,240,0)" />
          </radialGradient>
          <radialGradient id="cloud2" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(232,238,240,0.7)" />
            <stop offset="100%" stopColor="rgba(232,238,240,0)" />
          </radialGradient>
        </defs>
        <ellipse cx="180" cy="200" rx="320" ry="80" fill="url(#cloud1)" />
        <ellipse cx="1380" cy="140" rx="380" ry="70" fill="url(#cloud1)" />
        <ellipse cx="900" cy="320" rx="260" ry="50" fill="url(#cloud2)" />
        <ellipse cx="1500" cy="500" rx="300" ry="60" fill="url(#cloud1)" />
        <ellipse cx="100" cy="600" rx="280" ry="55" fill="url(#cloud2)" />
        <ellipse cx="700" cy="780" rx="380" ry="70" fill="url(#cloud1)" />
      </svg>
    </div>
  );
}
