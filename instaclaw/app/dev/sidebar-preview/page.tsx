"use client";

/**
 * Dev-only visual preview for the Phase 1 SidebarShell.
 *
 * Lets us eyeball + screenshot the sidebar without standing up auth or the
 * real dashboard gates. Production-gated to a no-op string.
 *
 * Query params:
 *   ?path=/tasks      — set the active route (defaults to /tasks)
 *   ?edge=1           — render the edge_city pinned item
 *   ?hb=unhealthy     — heartbeat dot state (healthy | unhealthy | paused)
 *   ?tour=N           — mount SpotlightTour (sidebar mode) at step index N
 *
 * The real layout renders this rail desktop-only (lg+); this harness shows it
 * at any width for inspection.
 */

import { useEffect, useState } from "react";
import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import { SidebarShell } from "@/components/dashboard/sidebar-shell";
import SpotlightTour from "@/components/onboarding-wizard/SpotlightTour";

export default function SidebarPreview() {
  const [path, setPath] = useState("/tasks");
  const [edge, setEdge] = useState(false);
  const [hb, setHb] = useState<"healthy" | "unhealthy" | "paused" | null>(null);
  // ?tour=N mounts SpotlightTour (sidebar mode) at step index N so the
  // nav-item steps (History resurrection, Account-section) can be screenshotted
  // landing on real elements without standing up the full wizard + auth.
  const [tourStep, setTourStep] = useState<number | null>(null);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const p = new URLSearchParams(window.location.search);
    if (p.get("path")) setPath(p.get("path")!);
    if (p.get("edge") === "1") setEdge(true);
    const h = p.get("hb");
    if (h === "unhealthy" || h === "paused" || h === "healthy") setHb(h);
    const t = p.get("tour");
    if (t !== null) {
      const n = parseInt(t, 10);
      setTourStep(Number.isFinite(n) ? n : 0);
    }
  }, []);

  if (process.env.NODE_ENV === "production") {
    return (
      <p style={{ padding: 24, fontFamily: "monospace" }}>
        /dev/sidebar-preview is dev-only.
      </p>
    );
  }

  const mockSession = {
    user: {
      email: "coop@valtlabs.com",
      name: "Cooper",
      partner: edge ? "edge_city" : null,
    },
    expires: "2099-01-01T00:00:00.000Z",
  } as unknown as Session;

  return (
    <SessionProvider session={mockSession}>
      <div data-theme="dashboard">
        <SidebarShell
          pathname={path}
          session={mockSession}
          heartbeatHealth={hb}
        >
          {/* Placeholder page content so the content column has something to
              frame against — mimics a real dashboard page heading. */}
          <div>
            <h1
              className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              {path}
            </h1>
            <p className="mt-2 text-sm" style={{ color: "var(--muted)" }}>
              Sidebar preview — active route: <code>{path}</code>
            </p>
            <div className="mt-8 grid gap-5 sm:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="glass rounded-xl p-6 h-32"
                  style={{ border: "1px solid var(--border)" }}
                />
              ))}
            </div>
          </div>
        </SidebarShell>
        {tourStep !== null && (
          <SpotlightTour
            startStep={tourStep}
            navMode="sidebar"
            onStepChange={(s) => setTourStep(s)}
            onComplete={() => {}}
            onClose={() => setTourStep(null)}
            setMoreOpen={() => {}}
            navigateTo={() => {}}
          />
        )}
      </div>
    </SessionProvider>
  );
}
