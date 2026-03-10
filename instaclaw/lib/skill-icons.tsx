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

  CandlestickChart,
  Briefcase,
  Film,
  Coins,
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
    path: "M10.34 17.287a.953.953 0 01-.953.953h-4a.954.954 0 01-.954-.953V5.38a.953.953 0 01.954-.953h4a.954.954 0 01.953.953zm9.233-5.467a.944.944 0 01-.953.947h-4a.947.947 0 01-.953-.947V5.38a.953.953 0 01.953-.953h4a.954.954 0 01.953.953z",
  },
  slack: {
    path: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.27 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.163 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.163 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.163 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.27a2.527 2.527 0 0 1-2.52-2.523 2.527 2.527 0 0 1 2.52-2.52h6.315A2.528 2.528 0 0 1 24 15.163a2.528 2.528 0 0 1-2.522 2.523h-6.315z",
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

interface SkillOrbMulticolor {
  color: string;
  type: "brand-multicolor";
  brandKey: string;
}

type SkillOrbEntry = SkillOrbConfig | SkillOrbBrandSvg | SkillOrbBrandImage | SkillOrbMulticolor;

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
  "motion-graphics":       { color: "#0B84F3", type: "lucide", Icon: Film },
  "marketplace-earning":   { color: "#F59E0B", type: "lucide", Icon: Coins },

  // ── Brand SVG logos (white SVG path in orb) ──
  "solana-defi":           { color: "#7C3AED", type: "brand-svg", brandKey: "solana" },
  "x-twitter-search":      { color: "#000000", type: "brand-svg", brandKey: "x" },

  // ── Integration brand SVGs ──
  "google-workspace":      { color: "#4285F4", type: "brand-multicolor", brandKey: "google" },
  "notion":                { color: "#000000", type: "brand-svg", brandKey: "notion" },
  "shopify":               { color: "#7AB55C", type: "brand-svg", brandKey: "shopify" },
  "github":                { color: "#181717", type: "brand-svg", brandKey: "github" },
  "apple-notes":           { color: "#000000", type: "brand-svg", brandKey: "apple" },
  "apple-reminders":       { color: "#000000", type: "brand-svg", brandKey: "apple" },
  "trello":                { color: "#0079BF", type: "brand-svg", brandKey: "trello" },
  "slack":                 { color: "#4A154B", type: "brand-multicolor", brandKey: "slack" },

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

function BrandShell({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`w-7 h-7 rounded-full shrink-0 flex items-center justify-center ${className}`}
      style={{
        background: "#f3f4f6",
        boxShadow: "0 0 0 1px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.08)",
      }}
    >
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
      <BrandShell className={className}>
        <svg
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill={brand.gradient ? `url(#${gradientId})` : config.color}
          className="relative"
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
      </BrandShell>
    );
  }

  if (config.type === "brand-multicolor" && config.brandKey === "google") {
    return (
      <BrandShell className={className}>
        <svg width={14} height={14} viewBox="0 0 24 24" className="relative">
          {/* Blue - right side + horizontal bar */}
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
          {/* Green - bottom right arc */}
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
          {/* Yellow - bottom left arc */}
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
          {/* Red - top left arc */}
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
        </svg>
      </BrandShell>
    );
  }

  if (config.type === "brand-multicolor" && config.brandKey === "slack") {
    return (
      <BrandShell className={className}>
        <svg width={14} height={14} viewBox="0 0 24 24" className="relative">
          {/* Pink/Red — bottom-left vertical + dot */}
          <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z" fill="#E01E5A" />
          {/* Blue — top-left horizontal + dot */}
          <path d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z" fill="#36C5F0" />
          {/* Green — top-right vertical + dot */}
          <path d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.27 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.163 0a2.528 2.528 0 0 1 2.523 2.522v6.312z" fill="#2EB67D" />
          {/* Yellow — bottom-right horizontal + dot */}
          <path d="M15.163 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.163 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.27a2.527 2.527 0 0 1-2.52-2.523 2.527 2.527 0 0 1 2.52-2.52h6.315A2.528 2.528 0 0 1 24 15.163a2.528 2.528 0 0 1-2.522 2.523h-6.315z" fill="#ECB22E" />
        </svg>
      </BrandShell>
    );
  }

  if (config.type === "brand-image") {
    return (
      <div
        className={`w-7 h-7 rounded-full shrink-0 overflow-hidden ${className}`}
        style={{ boxShadow: "0 0 0 1px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.08)" }}
      >
        <img
          src={config.src}
          alt=""
          className="w-full h-full object-cover"
        />
      </div>
    );
  }

  return null;
}

/** Check if a slug has an orb icon */
export function hasSkillIcon(slug: string): boolean {
  return slug in SKILL_ORB_MAP;
}

// ── Inline brand logos for rich descriptions ────────

const INLINE_SIZE = 16;
const INLINE_RADIUS = 4;

function InlineBrand({ path, color, label, viewBox = "0 0 24 24" }: { path: string; color: string; label: string; viewBox?: string }) {
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: INLINE_SIZE, height: INLINE_SIZE, minWidth: INLINE_SIZE, minHeight: INLINE_SIZE, borderRadius: INLINE_RADIUS, background: color, verticalAlign: "middle", marginRight: 3 }}>
        <svg width={INLINE_SIZE * 0.65} height={INLINE_SIZE * 0.65} viewBox={viewBox} fill="white" style={{ display: "block", shapeRendering: "geometricPrecision" }}>
          <path d={path} />
        </svg>
      </span>
      {label}
    </span>
  );
}

function InlineImage({ src, label }: { src: string; label: string }) {
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: INLINE_SIZE, height: INLINE_SIZE, minWidth: INLINE_SIZE, minHeight: INLINE_SIZE, borderRadius: INLINE_RADIUS, overflow: "hidden", verticalAlign: "middle", marginRight: 3 }}>
        <img src={src} alt="" style={{ display: "block", width: INLINE_SIZE, height: INLINE_SIZE, objectFit: "cover" }} />
      </span>
      {label}
    </span>
  );
}

const POLYMARKET_PATH = "M375.84 389.422C375.84 403.572 375.84 410.647 371.212 414.154C366.585 417.662 359.773 415.75 346.15 411.927L127.22 350.493C119.012 348.19 114.907 347.038 112.534 343.907C110.161 340.776 110.161 336.513 110.161 327.988V184.012C110.161 175.487 110.161 171.224 112.534 168.093C114.907 164.962 119.012 163.81 127.22 161.507L346.15 100.072C359.773 96.2495 366.585 94.338 371.212 97.8455C375.84 101.353 375.84 108.428 375.84 122.578V389.422ZM164.761 330.463L346.035 381.337V279.595L164.761 330.463ZM139.963 306.862L321.201 256L139.963 205.138V306.862ZM164.759 181.537L346.035 232.406V130.663L164.759 181.537Z";
const GUMROAD_PATH = "M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0Zm-.007 5.12c4.48 0 5.995 3.025 6.064 4.744h-3.239c-.069-.962-.897-2.406-2.896-2.406-2.136 0-3.514 1.857-3.514 4.126 0 2.27 1.378 4.125 3.514 4.125 1.93 0 2.758-1.512 3.103-3.025h-3.103v-1.238h6.509v6.327h-2.855v-3.989c-.207 1.444-1.102 4.264-4.617 4.264-3.516 0-5.584-2.82-5.584-6.326 0-3.645 2.276-6.602 6.618-6.602z";
const FIVERR_PATH = "M23.004 15.588a.995.995 0 1 0 .002-1.99.995.995 0 0 0-.002 1.99zm-.996-3.705h-.85c-.546 0-.84.41-.84 1.092v2.466h-1.61v-3.558h-.684c-.547 0-.84.41-.84 1.092v2.466h-1.61v-4.874h1.61v.74c.264-.574.626-.74 1.163-.74h1.972v.74c.264-.574.625-.74 1.162-.74h.527v1.316zm-6.786 1.501h-3.359c.088.546.43.858 1.006.858.43 0 .732-.175.83-.487l1.425.4c-.351.848-1.22 1.364-2.255 1.364-1.748 0-2.549-1.355-2.549-2.515 0-1.14.703-2.505 2.45-2.505 1.856 0 2.471 1.384 2.471 2.408 0 .224-.01.37-.02.477zm-1.562-.945c-.04-.42-.342-.81-.889-.81-.508 0-.81.225-.908.81h1.797zM7.508 15.44h1.416l1.767-4.874h-1.62l-.86 2.837-.878-2.837H5.72l1.787 4.874zm-6.6 0H2.51v-3.558h1.524v3.558h1.591v-4.874H2.51v-.302c0-.332.235-.536.606-.536h.918V8.412H2.85c-1.162 0-1.943.712-1.943 1.755v.4H0v1.316h.908v3.558z";
const UPWORK_PATH = "M18.561 13.158c-1.102 0-2.135-.467-3.074-1.227l.228-1.076.008-.042c.207-1.143.849-3.06 2.839-3.06 1.492 0 2.703 1.212 2.703 2.703-.001 1.489-1.212 2.702-2.704 2.702zm0-8.14c-2.539 0-4.51 1.649-5.31 4.366-1.22-1.834-2.148-4.036-2.687-5.892H7.828v7.112c-.002 1.406-1.141 2.546-2.547 2.548-1.405-.002-2.543-1.143-2.545-2.548V3.492H0v7.112c0 2.914 2.37 5.303 5.281 5.303 2.913 0 5.283-2.389 5.283-5.303v-1.19c.529 1.107 1.182 2.229 1.974 3.221l-1.673 7.873h2.797l1.213-5.71c1.063.679 2.285 1.109 3.686 1.109 3 0 5.439-2.452 5.439-5.45 0-3-2.439-5.439-5.439-5.439z";

const SHOPIFY_PATH = "M15.337 23.979l7.216-1.561s-2.604-17.613-2.625-17.73c-.018-.116-.114-.192-.211-.192s-1.929-.136-1.929-.136-1.275-1.274-1.439-1.411c-.045-.037-.075-.057-.121-.074l-.914 21.104h.023zM11.71 11.305s-.81-.424-1.774-.424c-1.447 0-1.504.906-1.504 1.141 0 1.232 3.24 1.715 3.24 4.629 0 2.295-1.44 3.76-3.406 3.76-2.354 0-3.54-1.465-3.54-1.465l.646-2.086s1.245 1.066 2.28 1.066c.675 0 .975-.545.975-.932 0-1.619-2.654-1.694-2.654-4.359-.034-2.237 1.571-4.416 4.827-4.416 1.257 0 1.875.361 1.875.361l-.945 2.715-.02.01zM11.17.83c.136 0 .271.038.405.135-.984.465-2.064 1.639-2.508 3.992-.656.213-1.293.405-1.889.578C7.697 3.75 8.951.84 11.17.84V.83zm1.235 2.949v.135c-.754.232-1.583.484-2.394.736.466-1.777 1.333-2.645 2.085-2.971.193.501.309 1.176.309 2.1zm.539-2.234c.694.074 1.141.867 1.429 1.755-.349.114-.735.231-1.158.366v-.252c0-.752-.096-1.371-.271-1.871v.002zm2.992 1.289c-.02 0-.06.021-.078.021s-.289.075-.714.21c-.423-1.233-1.176-2.37-2.508-2.37h-.115C12.135.209 11.669 0 11.265 0 8.159 0 6.675 3.877 6.21 5.846c-1.194.365-2.063.636-2.16.674-.675.213-.694.232-.772.87-.075.462-1.83 14.063-1.83 14.063L15.009 24l.927-21.166z";
const EBAY_PATH = "M6.056 12.132v-4.92h1.2v3.026c.59-.703 1.402-.906 2.202-.906 1.34 0 2.828.904 2.828 2.855 0 .233-.015.457-.06.668.24-.953 1.274-1.305 2.896-1.344.51-.018 1.095-.018 1.56-.018v-.135c0-.885-.556-1.244-1.53-1.244-.72 0-1.245.3-1.305.81h-1.275c.136-1.29 1.5-1.62 2.686-1.62 1.064 0 1.995.27 2.415 1.02l-.436-.84h1.41l2.055 4.125 2.055-4.126H24l-3.72 7.305h-1.346l1.07-2.04-2.33-4.38c.13.255.2.555.2.93v2.46c0 .346.01.69.04 1.005H16.8a6.543 6.543 0 01-.046-.765c-.603.734-1.32.96-2.32.96-1.48 0-2.272-.78-2.272-1.695 0-.15.015-.284.037-.405-.3 1.246-1.36 2.086-2.767 2.086-.87 0-1.694-.315-2.2-.93 0 .24-.015.494-.04.734h-1.18c.02-.39.04-.855.04-1.245v-1.05h-4.83c.065 1.095.818 1.74 1.853 1.74.718 0 1.355-.3 1.568-.93h1.24c-.24 1.29-1.61 1.725-2.79 1.725C.95 15.009 0 13.822 0 12.232c0-1.754.982-2.91 3.116-2.91 1.688 0 2.93.886 2.94 2.806v.005zm9.137.183c-1.095.034-1.77.233-1.77.95 0 .465.36.97 1.305.97 1.26 0 1.935-.69 1.935-1.814v-.13c-.45 0-.99.006-1.484.022h.012zm-6.06 1.875c1.11 0 1.876-.806 1.876-2.02s-.768-2.02-1.893-2.02c-1.11 0-1.89.806-1.89 2.02s.765 2.02 1.875 2.02h.03zm-4.35-2.514c-.044-1.125-.854-1.546-1.725-1.546-.944 0-1.694.474-1.815 1.546z";

/** Returns a rich JSX description with inline brand logos for specific skills, or null for default text */
export function getRichDescription(slug: string): React.ReactNode | null {
  if (slug === "ecommerce-marketplace") {
    return (
      <>
        Lists and sells products on{" "}
        <InlineImage src="/skill-icons/shopify.png" label="Shopify" />
        ,{" "}
        <InlineImage src="/skill-icons/ebay.png" label="eBay" />
        , and marketplaces
      </>
    );
  }
  if (slug === "prediction-markets") {
    return (
      <>
        Trade on{" "}
        <InlineImage src="/skill-icons/polymarket.png" label="Polymarket" />
        {" "}and{" "}
        <InlineImage src="/skill-icons/kalshi.png" label="Kalshi" />
        {" "}on the world&apos;s largest prediction markets
      </>
    );
  }
  if (slug === "freelance-digital") {
    return (
      <>
        Sell services and digital products on{" "}
        <InlineImage src="/skill-icons/gumroad.png" label="Gumroad" />
        ,{" "}
        <InlineImage src="/skill-icons/fiverr.png" label="Fiverr" />
        , and{" "}
        <InlineImage src="/skill-icons/upwork.png" label="Upwork" />
      </>
    );
  }
  return null;
}
