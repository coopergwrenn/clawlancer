"use client";

import { type LucideIcon } from "lucide-react";

const SIZES = {
  sm: {
    outer: "w-7 h-7",
    icon: "w-3.5 h-3.5",
    highlight: { top: "2px", left: "4px", width: "12px", height: "7px" },
  },
  md: {
    outer: "w-10 h-10",
    icon: "w-5 h-5",
    highlight: { top: "3px", left: "5px", width: "16px", height: "9px" },
  },
  lg: {
    outer: "w-14 h-14",
    icon: "w-7 h-7",
    highlight: { top: "4px", left: "7px", width: "22px", height: "12px" },
  },
} as const;

export function SkillOrb({
  color,
  icon: Icon,
  size = "md",
  className = "",
}: {
  color: string;
  icon: LucideIcon;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const s = SIZES[size];

  return (
    <div
      className={`${s.outer} rounded-full shrink-0 relative flex items-center justify-center ${className}`}
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
      {/* Glass highlight reflection */}
      <div
        className="absolute rounded-full pointer-events-none z-10"
        style={{
          top: s.highlight.top,
          left: s.highlight.left,
          width: s.highlight.width,
          height: s.highlight.height,
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0) 100%)",
        }}
      />
      <Icon
        className={`${s.icon} relative z-[1]`}
        style={{ color: "rgba(255,255,255,0.9)" }}
        strokeWidth={2}
      />
    </div>
  );
}
