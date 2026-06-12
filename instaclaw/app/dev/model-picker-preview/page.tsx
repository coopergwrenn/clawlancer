"use client";

/**
 * DEV-ONLY preview harness for ModelBrowserModal (D1 step c).
 * Not linked anywhere; renders one gate state per ?state= param for screenshots.
 *   ?state=credit        - credit user, Automatic selected
 *   ?state=credit-fable  - credit user, Fable selected
 *   ?state=byok          - BYOK user, full ladder
 *   ?state=loading       - api_mode resolving (fail-closed to credit)
 * Empty-search is captured by typing into the BYOK search in the harness.
 */

import { useState, useEffect } from "react";
import { ModelBrowserModal } from "@/components/model-browser-modal";

const CFG: Record<string, { apiMode: "byok" | "all_inclusive" | null; currentModel: string; loading?: boolean }> = {
  credit: { apiMode: "all_inclusive", currentModel: "automatic" },
  "credit-pin": { apiMode: "all_inclusive", currentModel: "claude-opus-4-8" },
  "credit-fable": { apiMode: "all_inclusive", currentModel: "claude-fable-5" },
  byok: { apiMode: "byok", currentModel: "claude-opus-4-8" },
  loading: { apiMode: null, currentModel: "automatic", loading: true },
};

export default function ModelPickerPreviewPage() {
  // Dev-only harness: never reachable in production (matches the sibling
  // app/dev/* preview pages' prod self-gate).
  const isProd = process.env.NODE_ENV === "production";

  // Read ?state= AFTER mount (useEffect) so server and client render the same
  // initial markup — reading window.location during render is a hydration
  // mismatch (the prior "1 Issue" in the dev overlay).
  const [c, setC] = useState(CFG.credit);
  const [selected, setSelected] = useState(CFG.credit.currentModel);
  useEffect(() => {
    const state = new URLSearchParams(window.location.search).get("state") || "credit";
    const next = CFG[state] ?? CFG.credit;
    setC(next);
    setSelected(next.currentModel);
  }, []);

  if (isProd) return null;

  return (
    <div
      data-theme="dashboard"
      style={{ minHeight: "100vh", background: "var(--background)" }}
      className="relative"
    >
      {/* faint composer-ish context behind, so the glass reads against real ground */}
      <div className="absolute inset-x-0 bottom-0 h-24 flex items-center justify-center" style={{ opacity: 0.5 }}>
        <div className="w-[92%] max-w-[640px] h-12 rounded-2xl" style={{ background: "var(--card)", boxShadow: "0 1px 2px rgba(0,0,0,0.04), 0 8px 24px -8px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.05)" }} />
      </div>

      {/* Readout: the exact value the modal emitted via onSelect, for the
          pick -> emitted-id round-trip proof. Dev harness only. */}
      <div id="ic-selected" data-selected={selected} className="fixed top-2 left-2 text-[11px] font-mono px-2 py-1 rounded" style={{ background: "rgba(0,0,0,0.06)", color: "var(--foreground)", zIndex: 200 }}>
        selected={selected}
      </div>

      <ModelBrowserModal
        open
        onClose={() => {}}
        apiMode={c.apiMode}
        currentModel={selected}
        loading={c.loading}
        onSelect={setSelected}
      />
    </div>
  );
}
