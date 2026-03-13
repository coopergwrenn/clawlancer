"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";

const SNAPPY = [0.23, 1, 0.32, 1] as const;

// Shared context so hero can read the same spots count
const SpotsContext = createContext<number | null>(null);

export function useSpotsCount() {
  return useContext(SpotsContext);
}

function getSpotTier(count: number) {
  if (count >= 10) return {
    orbBg: "radial-gradient(circle at 35% 30%, rgba(220,103,67,0.7), rgba(220,103,67,0.4) 50%, rgba(180,70,40,0.75) 100%)",
    glowBg: "radial-gradient(circle, rgba(220,103,67,0.4) 0%, transparent 70%)",
    text: `${count} Spots Open`,
  };
  if (count >= 3) return {
    orbBg: "radial-gradient(circle at 35% 30%, rgba(245,158,11,0.7), rgba(245,158,11,0.4) 50%, rgba(200,120,10,0.75) 100%)",
    glowBg: "radial-gradient(circle, rgba(245,158,11,0.4) 0%, transparent 70%)",
    text: `${count} Spots Open`,
  };
  if (count >= 1) return {
    orbBg: "radial-gradient(circle at 35% 30%, rgba(239,68,68,0.7), rgba(239,68,68,0.4) 50%, rgba(200,50,50,0.75) 100%)",
    glowBg: "radial-gradient(circle, rgba(239,68,68,0.4) 0%, transparent 70%)",
    text: `Almost gone — ${count} ${count === 1 ? "Spot" : "Spots"} Open`,
  };
  return {
    orbBg: "radial-gradient(circle at 35% 30%, rgba(140,140,140,0.4), rgba(100,100,100,0.25) 50%, rgba(60,60,60,0.5) 100%)",
    glowBg: "radial-gradient(circle, rgba(140,140,140,0.2) 0%, transparent 70%)",
    text: "Servers restocking — check back shortly",
  };
}

export function SpotsProvider({ children }: { children: React.ReactNode }) {
  const [spots, setSpots] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/spots")
      .then((r) => r.json())
      .then((d) => setSpots(d.available ?? 0))
      .catch(() => setSpots(null));
  }, []);

  return (
    <SpotsContext.Provider value={spots}>
      {children}
    </SpotsContext.Provider>
  );
}

export function SpotsCounter() {
  const spots = useSpotsCount();

  if (spots === null) return null;

  const tier = getSpotTier(spots);
  const isPulsing = spots >= 1 && spots <= 2;

  return (
    <AnimatePresence>
      <motion.span
        className="inline-flex items-center gap-2.5 px-6 py-2 rounded-full text-xs font-medium"
        style={{
          background: "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.05))",
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
          boxShadow: `
            rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset,
            rgba(255, 255, 255, 0.5) 0px -2px 2px 0px inset,
            rgba(0, 0, 0, 0.2) 0px 4px 2px -2px,
            rgba(255, 255, 255, 0.2) 0px 0px 1.6px 4px inset
          `,
          color: "var(--foreground)",
        }}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: SNAPPY }}
      >
        {/* Glass globe orb */}
        <span className="relative flex items-center justify-center w-5 h-5 rounded-full overflow-hidden shrink-0"
          style={{
            background: tier.orbBg,
            boxShadow: `
              inset 0 -2px 4px rgba(0,0,0,0.3),
              inset 0 2px 4px rgba(255,255,255,0.5),
              inset 0 0 3px rgba(0,0,0,0.15),
              0 1px 4px rgba(0,0,0,0.15)
            `,
            animation: isPulsing ? "globe-pulse 2s ease-in-out infinite" : undefined,
          }}
        >
          {/* Shimmer sweep */}
          <span
            className="absolute inset-0 rounded-full"
            style={{
              background: "linear-gradient(105deg, transparent 20%, rgba(255,255,255,0.4) 45%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0.4) 55%, transparent 80%)",
              backgroundSize: "300% 100%",
              animation: "globe-shimmer 4s linear infinite",
            }}
          />
          {/* Glass highlight */}
          <span
            className="absolute top-[2px] left-[3px] w-[8px] h-[5px] rounded-full pointer-events-none"
            style={{
              background: "linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0) 100%)",
            }}
          />
          {/* Soft breathing glow */}
          <span
            className="absolute inset-[-2px] rounded-full"
            style={{
              background: tier.glowBg,
              animation: "globe-glow 4s ease-in-out infinite",
            }}
          />
        </span>

        {tier.text}
      </motion.span>
    </AnimatePresence>
  );
}
