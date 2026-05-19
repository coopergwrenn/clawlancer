import Image from "next/image";
import Link from "next/link";

interface NavProps {
  /** CTA target — driven by user state (claim / resume / open agent) */
  ctaHref: string;
  ctaLabel: string;
  ctaExternal: boolean;
}

/**
 * Floating pill-style nav — sage-tinted brand on the left, dark forest CTA
 * on the right. Fixed to top so it stays visible over the map cinematic.
 */
export function Nav({ ctaHref, ctaLabel, ctaExternal }: NavProps) {
  const ctaClass =
    "pointer-events-auto inline-flex items-center gap-3 px-6 py-3.5 rounded-full text-[13px] font-semibold uppercase tracking-[0.06em] transition-all duration-200 shadow-[0_4px_20px_rgba(15,26,18,0.2)] hover:shadow-[0_8px_28px_rgba(15,26,18,0.28)] hover:-translate-y-0.5";
  const ctaStyle = {
    background: "var(--edge-olive)",
    color: "var(--cream)",
  } as React.CSSProperties;

  return (
    <nav className="fixed top-6 left-6 right-6 z-50 flex justify-between items-center pointer-events-none">
      <Link
        href="/edge"
        className="pointer-events-auto inline-flex items-center gap-2.5 px-4 py-2.5 rounded-full border border-white/50 backdrop-blur-md"
        style={{ background: "rgba(228, 240, 210, 0.67)" }}
        aria-label="Edge Esmeralda — Agent Village"
      >
        <Image
          src="/edge/EdgeEsmeraldaLogo.svg"
          alt="Edge Esmeralda"
          width={115}
          height={28}
          priority
          className="block"
        />
      </Link>

      {ctaExternal ? (
        <a
          href={ctaHref}
          target="_blank"
          rel="noopener noreferrer"
          className={ctaClass}
          style={ctaStyle}
        >
          <span>{ctaLabel}</span>
          <span aria-hidden>→</span>
        </a>
      ) : (
        <Link href={ctaHref} className={ctaClass} style={ctaStyle}>
          <span>{ctaLabel}</span>
          <span aria-hidden>→</span>
        </Link>
      )}
    </nav>
  );
}
