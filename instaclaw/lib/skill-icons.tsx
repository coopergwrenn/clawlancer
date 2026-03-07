/**
 * Skill icon system — orb-style icons matching the Marketplace tab aesthetic.
 *
 * - Generic skills: Lucide icon inside a colored gradient orb
 * - Brand SVG logos: simple-icons path rendered white inside a colored orb
 * - Brand image logos: image clipped to circle inside a colored orb
 */

import {
  Video,
  Palette,
  Mic,
  Mail,
  TrendingUp,
  Crosshair,
  ShoppingCart,
  AtSign,
  Search,
  Globe,
  Languages,
  Code,
  FolderOpen,
  MessageSquare,
  CandlestickChart,
  Briefcase,
} from "lucide-react";
import { type LucideIcon } from "lucide-react";

// ── Simple-icons brand SVG paths ────────────────────

interface BrandSvg {
  path: string;
  gradient?: [string, string];
}

const BRAND_SVGS: Record<string, BrandSvg> = {
  solana: {
    path: "m23.8764 18.0313-3.962 4.1393a.9201.9201 0 0 1-.306.2106.9407.9407 0 0 1-.367.0742H.4599a.4689.4689 0 0 1-.2522-.0733.4513.4513 0 0 1-.1696-.1962.4375.4375 0 0 1-.0314-.2545.4438.4438 0 0 1 .117-.2298l3.9649-4.1393a.92.92 0 0 1 .3052-.2102.9407.9407 0 0 1 .3658-.0746H23.54a.4692.4692 0 0 1 .2523.0734.4531.4531 0 0 1 .1697.196.438.438 0 0 1 .0313.2547.4442.4442 0 0 1-.1169.2297zm-3.962-8.3355a.9202.9202 0 0 0-.306-.2106.941.941 0 0 0-.367-.0742H.4599a.4687.4687 0 0 0-.2522.0734.4513.4513 0 0 0-.1696.1961.4376.4376 0 0 0-.0314.2546.444.444 0 0 0 .117.2297l3.9649 4.1394a.9204.9204 0 0 0 .3052.2102c.1154.049.24.0744.3658.0746H23.54a.469.469 0 0 0 .2523-.0734.453.453 0 0 0 .1697-.1961.4382.4382 0 0 0 .0313-.2546.4444.4444 0 0 0-.1169-.2297zM.46 6.7225h18.7815a.9411.9411 0 0 0 .367-.0742.9202.9202 0 0 0 .306-.2106l3.962-4.1394a.4442.4442 0 0 0 .117-.2297.4378.4378 0 0 0-.0314-.2546.453.453 0 0 0-.1697-.196.469.469 0 0 0-.2523-.0734H4.7596a.941.941 0 0 0-.3658.0745.9203.9203 0 0 0-.3052.2102L.1246 5.9687a.4438.4438 0 0 0-.1169.2295.4375.4375 0 0 0 .0312.2544.4512.4512 0 0 0 .1692.196.4689.4689 0 0 0 .2518.0739z",
    gradient: ["#9945FF", "#14F195"],
  },
  x: {
    path: "M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z",
  },
  google: {
    path: "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z",
  },
  notion: {
    path: "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
  },
  shopify: {
    path: "M15.337 23.979l7.216-1.561s-2.604-17.613-2.625-17.73c-.018-.116-.114-.192-.211-.192s-1.929-.136-1.929-.136-1.275-1.274-1.439-1.411c-.045-.037-.075-.057-.121-.074l-.914 21.104h.023zM11.71 11.305s-.81-.424-1.774-.424c-1.447 0-1.504.906-1.504 1.141 0 1.232 3.24 1.715 3.24 4.629 0 2.295-1.44 3.76-3.406 3.76-2.354 0-3.54-1.465-3.54-1.465l.646-2.086s1.245 1.066 2.28 1.066c.675 0 .975-.545.975-.932 0-1.619-2.654-1.694-2.654-4.359-.034-2.237 1.571-4.416 4.827-4.416 1.257 0 1.875.361 1.875.361l-.945 2.715-.02.01zM11.17.83c.136 0 .271.038.405.135-.984.465-2.064 1.639-2.508 3.992-.656.213-1.293.405-1.889.578C7.697 3.75 8.951.84 11.17.84V.83zm1.235 2.949v.135c-.754.232-1.583.484-2.394.736.466-1.777 1.333-2.645 2.085-2.971.193.501.309 1.176.309 2.1zm.539-2.234c.694.074 1.141.867 1.429 1.755-.349.114-.735.231-1.158.366v-.252c0-.752-.096-1.371-.271-1.871v.002zm2.992 1.289c-.02 0-.06.021-.078.021s-.289.075-.714.21c-.423-1.233-1.176-2.37-2.508-2.37h-.115C12.135.209 11.669 0 11.265 0 8.159 0 6.675 3.877 6.21 5.846c-1.194.365-2.063.636-2.16.674-.675.213-.694.232-.772.87-.075.462-1.83 14.063-1.83 14.063L15.009 24l.927-21.166z",
  },
  github: {
    path: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  },
  apple: {
    path: "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701",
  },
  trello: {
    path: "M21.147 0H2.853A2.86 2.86 0 000 2.853v18.294A2.86 2.86 0 002.853 24h18.294A2.86 2.86 0 0024 21.147V2.853A2.86 2.86 0 0021.147 0zM10.34 17.287a.953.953 0 01-.953.953h-4a.954.954 0 01-.954-.953V5.38a.953.953 0 01.954-.953h4a.954.954 0 01.953.953zm9.233-5.467a.944.944 0 01-.953.947h-4a.947.947 0 01-.953-.947V5.38a.953.953 0 01.953-.953h4a.954.954 0 01.953.953z",
  },
};

// ── Skill → orb config mapping ──────────────────────

interface SkillOrbConfig {
  color: string;
  type: "lucide";
  Icon: LucideIcon;
}

interface SkillOrbBrandSvg {
  color: string;
  type: "brand-svg";
  brandKey: string;
}

interface SkillOrbBrandImage {
  color: string;
  type: "brand-image";
  src: string;
}

type SkillOrbEntry = SkillOrbConfig | SkillOrbBrandSvg | SkillOrbBrandImage;

const SKILL_ORB_MAP: Record<string, SkillOrbEntry> = {
  // ── Generic skills (Lucide icon in orb) ──
  "ecommerce-marketplace": { color: "#4A90D9", type: "lucide", Icon: ShoppingCart },
  "language-teacher":      { color: "#2BB5A0", type: "lucide", Icon: Languages },
  "sjinn-video":           { color: "#E87461", type: "lucide", Icon: Video },
  "brand-design":          { color: "#E06B9E", type: "lucide", Icon: Palette },
  "voice-audio-production": { color: "#E5A13B", type: "lucide", Icon: Mic },
  "code-execution":        { color: "#4CAF7D", type: "lucide", Icon: Code },
  "web-browsing":          { color: "#4A90D9", type: "lucide", Icon: Globe },
  "file-management":       { color: "#7B8794", type: "lucide", Icon: FolderOpen },
  "email-outreach":        { color: "#6366F1", type: "lucide", Icon: Mail },
  "financial-analysis":    { color: "#10B981", type: "lucide", Icon: TrendingUp },
  "competitive-intelligence": { color: "#64748B", type: "lucide", Icon: Crosshair },
  "social-media-content":  { color: "#E06B9E", type: "lucide", Icon: AtSign },
  "web-search":            { color: "#06B6D4", type: "lucide", Icon: Search },
  "prediction-markets":    { color: "#F59E0B", type: "lucide", Icon: CandlestickChart },
  "freelance-digital":     { color: "#8B5CF6", type: "lucide", Icon: Briefcase },

  // ── Brand SVG logos (white SVG path in orb) ──
  "solana-defi":           { color: "#7C3AED", type: "brand-svg", brandKey: "solana" },
  "x-twitter-search":      { color: "#1C1C1E", type: "brand-svg", brandKey: "x" },

  // ── Integration brand SVGs ──
  "google-workspace":      { color: "#4285F4", type: "brand-svg", brandKey: "google" },
  "notion":                { color: "#2D2D2D", type: "brand-svg", brandKey: "notion" },
  "shopify":               { color: "#7AB55C", type: "brand-svg", brandKey: "shopify" },
  "github":                { color: "#2D2D2D", type: "brand-svg", brandKey: "github" },
  "apple-notes":           { color: "#2D2D2D", type: "brand-svg", brandKey: "apple" },
  "apple-reminders":       { color: "#2D2D2D", type: "brand-svg", brandKey: "apple" },
  "trello":                { color: "#0079BF", type: "brand-svg", brandKey: "trello" },
  "slack":                 { color: "#5A8FA5", type: "lucide", Icon: MessageSquare },

  // ── Brand image logos (image clipped inside orb) ──
  "higgsfield-video":      { color: "#E87461", type: "brand-image", src: "/skill-icons/higgsfield.jpg" },
  "virtuals-agdp":         { color: "#7C3AED", type: "brand-image", src: "/skill-icons/virtuals.png" },
  "clawlancer":            { color: "#E5A13B", type: "brand-image", src: "/skill-icons/clawlancer.png" },
};

// ── Orb render component ────────────────────────────

function OrbShell({
  color,
  children,
  className = "",
}: {
  color: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`w-7 h-7 rounded-full shrink-0 relative flex items-center justify-center ${className}`}
      style={{
        background: `radial-gradient(circle at 35% 35%, ${color}dd, ${color}88 40%, rgba(0,0,0,0.3) 100%)`,
        boxShadow: `
          inset 0 -3px 6px rgba(0,0,0,0.25),
          inset 0 3px 6px rgba(255,255,255,0.4),
          inset 0 0 4px rgba(0,0,0,0.15),
          0 2px 8px rgba(0,0,0,0.2),
          0 1px 3px rgba(0,0,0,0.15)
        `,
      }}
    >
      {/* Glass highlight */}
      <div
        className="absolute rounded-full pointer-events-none z-10"
        style={{
          top: "2px",
          left: "4px",
          width: "12px",
          height: "7px",
          background: "linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0) 100%)",
        }}
      />
      {children}
    </div>
  );
}

export function SkillIcon({
  slug,
  className = "",
}: {
  slug: string;
  size?: number;
  className?: string;
}) {
  const config = SKILL_ORB_MAP[slug];
  if (!config) return null;

  if (config.type === "lucide") {
    const { Icon } = config;
    return (
      <OrbShell color={config.color} className={className}>
        <Icon
          className="w-3.5 h-3.5 relative z-[1]"
          style={{ color: "rgba(255,255,255,0.9)" }}
          strokeWidth={2}
        />
      </OrbShell>
    );
  }

  if (config.type === "brand-svg") {
    const brand = BRAND_SVGS[config.brandKey];
    if (!brand) return null;
    const gradientId = `orb-grad-${config.brandKey}`;
    return (
      <OrbShell color={config.color} className={className}>
        <svg
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill={brand.gradient ? `url(#${gradientId})` : "rgba(255,255,255,0.9)"}
          className="relative z-[1]"
        >
          {brand.gradient && (
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor={brand.gradient[0]} />
                <stop offset="100%" stopColor={brand.gradient[1]} />
              </linearGradient>
            </defs>
          )}
          <path d={brand.path} />
        </svg>
      </OrbShell>
    );
  }

  if (config.type === "brand-image") {
    return (
      <OrbShell color={config.color} className={className}>
        <img
          src={config.src}
          alt=""
          className="w-5 h-5 rounded-full object-cover relative z-[1]"
        />
      </OrbShell>
    );
  }

  return null;
}

/** Check if a slug has an orb icon */
export function hasSkillIcon(slug: string): boolean {
  return slug in SKILL_ORB_MAP;
}
