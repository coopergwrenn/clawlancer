"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, useRef } from "react";

/**
 * Wraps page content with a smooth fade + slide transition.
 * Cancels any in-progress transition immediately on rapid taps
 * so switching feels snappy even when tapping quickly.
 */
export default function PageTransition({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [displayChildren, setDisplayChildren] = useState(children);
  const [animating, setAnimating] = useState(false);
  const prevPathname = useRef(pathname);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (pathname === prevPathname.current) {
      // Same route — just update children
      setDisplayChildren(children);
      return;
    }

    // Route changed — cancel any in-progress transition
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }

    prevPathname.current = pathname;

    // Swap content immediately, then animate in
    setDisplayChildren(children);
    setAnimating(true);

    // Clear animation flag after enter completes
    timeoutRef.current = setTimeout(() => {
      setAnimating(false);
    }, 200);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [pathname, children]);

  return (
    <div
      className={animating ? "page-enter" : ""}
      style={{
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
        flex: 1,
      }}
    >
      {displayChildren}
      <style>{`
        .page-enter {
          animation: pageIn 0.2s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @keyframes pageIn {
          from {
            opacity: 0.6;
            transform: translateY(4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}
