"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, useRef } from "react";

/**
 * Wraps page content with a smooth fade + slide transition
 * when navigating between tabs. Uses CSS transitions with
 * a brief exit→enter cycle on route change.
 */
export default function PageTransition({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [displayChildren, setDisplayChildren] = useState(children);
  const [phase, setPhase] = useState<"visible" | "exiting" | "entering">("visible");
  const prevPathname = useRef(pathname);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (pathname === prevPathname.current) {
      // Same route — just update children (e.g., page refresh)
      setDisplayChildren(children);
      return;
    }

    // Route changed — run exit → swap → enter transition
    prevPathname.current = pathname;

    // Clear any pending timeout
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    // Phase 1: Exit (fade out + slight slide)
    setPhase("exiting");

    // Phase 2: Swap content after exit completes
    timeoutRef.current = setTimeout(() => {
      setDisplayChildren(children);
      setPhase("entering");

      // Phase 3: Enter complete
      timeoutRef.current = setTimeout(() => {
        setPhase("visible");
      }, 250);
    }, 120);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [pathname, children]);

  return (
    <div
      className="page-transition"
      style={{
        opacity: phase === "exiting" ? 0 : 1,
        transform:
          phase === "exiting"
            ? "translateY(6px) scale(0.99)"
            : phase === "entering"
              ? "translateY(0) scale(1)"
              : "translateY(0) scale(1)",
        transition:
          phase === "exiting"
            ? "opacity 0.12s ease-out, transform 0.12s ease-out"
            : "opacity 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)",
        willChange: "opacity, transform",
        minHeight: "100%",
      }}
    >
      {displayChildren}
    </div>
  );
}
