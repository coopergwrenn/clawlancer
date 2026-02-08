"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";

const SNAPPY = [0.23, 1, 0.32, 1] as const;

export function SpotsCounter() {
  const [spots, setSpots] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/spots")
      .then((r) => r.json())
      .then((d) => setSpots(d.available ?? 0))
      .catch(() => setSpots(null));
  }, []);

  return (
    <AnimatePresence>
      {spots !== null && (
        <motion.span
          className="inline-flex items-center gap-2.5 px-4 py-1.5 rounded-full text-xs font-medium tracking-wide uppercase"
          style={{
            border: "1px solid var(--border)",
            color: "var(--foreground)",
          }}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: SNAPPY }}
        >
          {/* Pulsing live dot */}
          <span className="relative flex h-1.5 w-1.5">
            <span
              className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping"
              style={{ background: spots > 0 ? "var(--accent)" : "var(--muted)" }}
            />
            <span
              className="relative inline-flex h-1.5 w-1.5 rounded-full"
              style={{ background: spots > 0 ? "var(--accent)" : "var(--muted)" }}
            />
          </span>

          {spots} {spots === 1 ? "spot" : "spots"} open
        </motion.span>
      )}
    </AnimatePresence>
  );
}
