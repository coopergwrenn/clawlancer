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
 *   ?mock=1           — stub the Sessions API (tasks/list + chat/conversations)
 *                       with sample data so the Sessions index can be eyeballed
 *                       without auth. Pair with ?c=<id> / ?t=<id> to preview the
 *                       active-row highlight + the traveling pill, e.g.
 *                       ?path=/tasks&mock=1&c=c1
 *
 * The real layout renders this rail desktop-only (lg+); this harness shows it
 * at any width for inspection.
 */

import { useEffect, useState } from "react";
import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import { SidebarShell } from "@/components/dashboard/sidebar-shell";
import SpotlightTour from "@/components/onboarding-wizard/SpotlightTour";
import CommandCenterPage from "@/app/(dashboard)/tasks/page";

/* ─── ?mock=1 — dev-only Sessions API stub ───────────────────────────────── */
// Installed synchronously during render (before SessionsSection's fetch effect,
// since child effects run before the parent's) so the first useSessions call
// hits the stub. Idempotent via a module-level flag.
let sessionsMockInstalled = false;
function installSessionsMockOnce() {
  if (sessionsMockInstalled) return;
  if (typeof window === "undefined") return;
  if (process.env.NODE_ENV === "production") return;
  if (new URLSearchParams(window.location.search).get("mock") !== "1") return;
  sessionsMockInstalled = true;

  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

  const conversations = [
    { id: "c1", title: "RFT5 launch plan", created_at: ago(2 * DAY), updated_at: ago(5 * MIN), is_archived: false, last_message_preview: "ticker + fee tier locked", message_count: 14 },
    { id: "c2", title: "Draft Q3 investor email with the updated ARR and the runway numbers", created_at: ago(3 * DAY), updated_at: ago(2 * HOUR), is_archived: false, last_message_preview: "", message_count: 6 },
    { id: "c3", title: "Weekend trip ideas", created_at: ago(5 * DAY), updated_at: ago(1 * DAY), is_archived: false, last_message_preview: "", message_count: 3 },
  ];
  const tasks = [
    { id: "t1", title: "Research AI agent frameworks", description: "compare the top 5", status: "completed", created_at: ago(1 * DAY), updated_at: ago(30 * MIN), is_recurring: false, tools_used: [] },
    { id: "t2", title: "Weekly market digest", description: "crypto + AI", status: "in_progress", created_at: ago(7 * DAY), updated_at: ago(10 * MIN), is_recurring: true, tools_used: [] },
    { id: "t3", title: "Monitor competitor pricing", description: "daily", status: "active", created_at: ago(10 * DAY), updated_at: ago(3 * HOUR), is_recurring: true, tools_used: [] },
    { id: "t4", title: "Fix the broken thing", description: "retry", status: "failed", created_at: ago(4 * DAY), updated_at: ago(2 * DAY), is_recurring: false, tools_used: [] },
  ];

  // A couple of messages for c1 so the deep-link open shows real chat content.
  const messages: Record<string, Array<{ id: string; role: string; content: string; created_at: string }>> = {
    c1: [
      { id: "m1", role: "user", content: "Lock the RFT5 ticker and the 0.5% fee tier.", created_at: ago(6 * MIN) },
      { id: "m2", role: "assistant", content: "Done — **RFT5**, 0.5% fee. Ready to launch on your go.", created_at: ago(5 * MIN) },
    ],
  };

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  const realFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/tasks/list")) return Promise.resolve(json({ tasks, total: tasks.length }));
    if (url.startsWith("/api/tasks/suggestions")) return Promise.resolve(json({ suggestions: [] }));
    if (url.includes("/api/chat/conversations/") && url.includes("/messages")) {
      const id = url.split("/api/chat/conversations/")[1]?.split("/")[0];
      return Promise.resolve(json({ messages: messages[id ?? ""] ?? [] }));
    }
    if (url.startsWith("/api/chat/conversations/")) {
      const id = url.split("/api/chat/conversations/")[1]?.split(/[?#]/)[0];
      const c = conversations.find((x) => x.id === id);
      return Promise.resolve(c ? json({ conversation: c }) : new Response("{}", { status: 404 }));
    }
    if (url.startsWith("/api/chat/conversations")) return Promise.resolve(json({ conversations }));
    if (url.startsWith("/api/tasks/")) {
      const id = url.split("/api/tasks/")[1]?.split(/[?#]/)[0];
      const t = tasks.find((x) => x.id === id);
      return Promise.resolve(t ? json({ task: t }) : new Response("{}", { status: 404 }));
    }
    if (url.startsWith("/api/vm/status"))
      return Promise.resolve(json({ status: "running", model: "claude-sonnet-4-6", channelsEnabled: [], hasDiscord: false, hasBraveSearch: false, gmailConnected: false, telegramBotUsername: null }));
    if (url.startsWith("/api/library/saved-messages")) return Promise.resolve(json({ ids: [] }));
    if (url.startsWith("/api/library")) return Promise.resolve(json({ items: [] }));
    return realFetch(input as RequestInfo, init);
  }) as typeof window.fetch;
}

export default function SidebarPreview() {
  // Install the ?mock=1 Sessions API stub synchronously, before SessionsSection
  // mounts and fires its first fetch.
  installSessionsMockOnce();

  const [path, setPath] = useState("/tasks");
  const [edge, setEdge] = useState(false);
  const [hb, setHb] = useState<"healthy" | "unhealthy" | "paused" | null>(null);
  // ?real=1 renders the REAL CommandCenterPage as the content (with ?mock=1
  // stubbing its APIs) so the deep-link OPEN can be eyeballed end-to-end.
  const [real, setReal] = useState(false);
  // ?tour=N mounts SpotlightTour (sidebar mode) at step index N so the
  // nav-item steps (History resurrection, Account-section) can be screenshotted
  // landing on real elements without standing up the full wizard + auth.
  const [tourStep, setTourStep] = useState<number | null>(null);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const p = new URLSearchParams(window.location.search);
    if (p.get("path")) setPath(p.get("path")!);
    if (p.get("edge") === "1") setEdge(true);
    if (p.get("real") === "1") setReal(true);
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
          {real ? (
            // Real Command Center page — proves the deep-link OPEN end-to-end:
            // ?c=<id> opens that conversation; the page reads the same URL the
            // sidebar row links to.
            <CommandCenterPage />
          ) : (
          /* Placeholder page content so the content column has something to
              frame against — mimics a real dashboard page heading. */
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
          )}
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
