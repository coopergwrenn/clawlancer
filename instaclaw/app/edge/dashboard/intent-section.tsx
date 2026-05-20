"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IntentForm } from "./intent-form";
import type { CurrentIntent } from "@/lib/edge-dashboard-data";

/**
 * Adaptive intent-management section for /edge/dashboard (FUP-3b).
 *
 * Replaces the static `<IntentForm />` placement with a context-aware
 * UI that branches on whether the user has expressed any intent yet.
 *
 *   STATE A — no intent (currentIntent === null):
 *     Rare in practice — /edge/intents enforces a mandatory gate
 *     before /dashboard. Users only reach this state via the
 *     service-degradation escape hatch (Yanek's MCP down on /edge/intents
 *     → user skipped via the 30-min localStorage flag). UX: prominent
 *     panel with olive accent border + IntentForm visible by default +
 *     explicit prompt copy. This is the recovery affordance.
 *
 *   STATE B — has intent (currentIntent !== null):
 *     The 99.9% case. Compact display of the current intent text with
 *     an "Update intent" expand affordance. The form stays collapsed
 *     by default — the dashboard is for monitoring matches, not
 *     re-filling forms. Clicking Update reveals IntentForm; Cancel
 *     collapses it. After a successful submission, the form
 *     auto-collapses and router.refresh() re-fetches the dashboard's
 *     server-rendered data so the displayed intent text updates.
 *
 * Note on placement: /edge/dashboard's MatchHistorySection ALREADY
 * shows the current intent via CurrentIntentCard ("Your agent is
 * looking for…"). That card is the CONTEXT framing for the match
 * list. This section is the MANAGEMENT surface. Slight visible
 * redundancy between the two is intentional — two different
 * functional roles, two different UI affordances.
 *
 * Data source: the `currentIntent` prop is already wired by the
 * Consensus terminal via `fetchUserCurrentIntent` in
 * lib/edge-dashboard-data.ts. We don't fetch — we just adapt.
 */

interface IntentSectionProps {
  currentIntent: CurrentIntent | null;
}

export function IntentSection({ currentIntent }: IntentSectionProps) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);

  function handleSuccess() {
    setExpanded(false);
    // Invalidate the server-rendered dashboard data so the displayed
    // currentIntent reflects the new submission. Without this, the user
    // would see their old intent until they manually refresh.
    router.refresh();
  }

  // ── STATE A: no intent yet ───────────────────────────────────────────
  if (!currentIntent) {
    return (
      <section
        style={{
          marginBottom: "40px",
          padding: "24px",
          border: "2px solid var(--edge-olive)",
          borderRadius: "10px",
          background: "var(--edge-bg)",
        }}
      >
        <h2
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--edge-olive)",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            margin: "0 0 6px",
          }}
        >
          Add your first intent
        </h2>
        <p
          style={{
            fontSize: "14px",
            color: "var(--edge-ink-soft)",
            margin: "0 0 16px",
            lineHeight: 1.55,
          }}
        >
          Help your agent find the right people for you across the village.
          The more specific you are, the better the matches.
        </p>
        <IntentForm onSuccess={handleSuccess} />
      </section>
    );
  }

  // ── STATE B: has intent (compact view, expand to update) ─────────────
  return (
    <section style={{ marginBottom: "40px" }}>
      <h2
        style={{
          fontSize: "13px",
          fontWeight: 600,
          color: "var(--edge-ink-soft)",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          margin: "0 0 12px",
        }}
      >
        Manage your intent
      </h2>

      <div
        style={{
          padding: "20px",
          border: "1px solid var(--edge-line)",
          borderRadius: "10px",
          background: "rgba(255,255,255,0.5)",
        }}
      >
        <div
          style={{
            fontSize: "11px",
            fontWeight: 600,
            color: "var(--edge-ink-soft)",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            marginBottom: "6px",
          }}
        >
          Currently
        </div>
        <p
          style={{
            margin: "0 0 16px",
            fontSize: "15px",
            lineHeight: 1.55,
            color: "var(--edge-ink)",
            fontStyle: "italic",
          }}
        >
          &ldquo;{currentIntent.description}&rdquo;
        </p>

        {expanded ? (
          <div
            style={{
              marginTop: "8px",
              paddingTop: "16px",
              borderTop: "1px solid var(--edge-line)",
            }}
          >
            <IntentForm onSuccess={handleSuccess} />
            <button
              type="button"
              onClick={() => setExpanded(false)}
              style={{
                marginTop: "12px",
                background: "transparent",
                border: "none",
                color: "var(--edge-ink-soft)",
                fontSize: "13px",
                cursor: "pointer",
                textDecoration: "underline",
                textUnderlineOffset: "3px",
                padding: 0,
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            style={{
              padding: "9px 18px",
              fontSize: "13px",
              fontWeight: 500,
              background: "var(--edge-olive)",
              color: "var(--edge-bg)",
              border: "none",
              borderRadius: "7px",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            Update intent
            <span aria-hidden>→</span>
          </button>
        )}
      </div>

      <p
        style={{
          marginTop: "12px",
          fontSize: "12.5px",
          color: "var(--edge-ink-soft)",
          lineHeight: 1.55,
        }}
      >
        The more specific you are, the better the matches. You can submit a
        new intent once every 5 minutes.
      </p>
    </section>
  );
}
