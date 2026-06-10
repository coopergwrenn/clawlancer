"use client";

/**
 * /economy/approve?id=<approval_id>  --  the session-rooted spend-approval page
 * (Frontier human_approved hardening, Surface 2, the human-facing side).
 *
 * The agent relays this URL to its human when a spend needs approval; the human
 * opens it in their logged-in browser (the dashboard layout enforces the session),
 * sees the EXACT spend the agent proposed (read server-side, not from the URL), and
 * taps Approve or Deny. Approving flips the pending row to `approved`; the agent's
 * re-authorize then honors + consumes it. Consent happens here, in the session — the
 * one channel the VM-resident agent cannot emit on.
 */

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ShieldCheck, AlertTriangle, Check, Hand, Loader2 } from "lucide-react";

interface ApprovalView {
  ok: boolean;
  reason?: string;
  id?: string;
  amount_usd?: number;
  category?: string | null;
  counterparty?: string | null;
  status?: string;
  expires_at?: string;
  agent_name?: string | null;
}

const CARD =
  "w-full max-w-md rounded-2xl border border-white/10 bg-[#161617] p-7 text-center shadow-xl";

function ApproveInner() {
  const params = useSearchParams();
  const id = params.get("id");

  const [view, setView] = useState<ApprovalView | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [result, setResult] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      setError("This approval link is missing its id.");
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/agent-economy/approve?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (res.status === 404) {
        setError("We couldn't find this approval, or it isn't yours.");
        setView(null);
      } else if (!res.ok) {
        setError("Couldn't load this approval. Please try again.");
      } else {
        const j = (await res.json()) as ApprovalView;
        setView(j);
        if (!j.ok && j.reason === "pending_setup") setError("Spend approvals are still being set up. Check back shortly.");
      }
    } catch {
      setError("Couldn't load this approval. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const act = useCallback(
    async (decision: "approve" | "deny") => {
      if (!id || acting) return;
      setActing(true);
      setError(null);
      try {
        const res = await fetch("/api/agent-economy/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, decision }),
        });
        const j = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: string; reason?: string };
        if (res.ok && j.ok) {
          setResult(decision === "approve" ? "approved" : "denied");
        } else if (j.reason === "terminal_state" || j.reason === "expired") {
          setError(
            j.status === "consumed"
              ? "This spend was already completed."
              : j.status === "expired"
                ? "This approval expired. Ask your agent to try again."
                : "This approval can no longer be changed.",
          );
          await load();
        } else if (j.reason === "state_changed") {
          await load();
        } else {
          setError("Couldn't record your decision. Please try again.");
        }
      } catch {
        setError("Couldn't record your decision. Please try again.");
      } finally {
        setActing(false);
      }
    },
    [id, acting, load],
  );

  const amt = typeof view?.amount_usd === "number" ? `$${view.amount_usd.toFixed(2)}` : "--";

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-5 py-10">
      <div className={CARD}>
        {loading ? (
          <div className="flex flex-col items-center gap-3 py-6 text-white/60">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="text-sm">Loading the spend…</span>
          </div>
        ) : result === "approved" ? (
          <>
            <Check className="mx-auto mb-3 h-8 w-8 text-emerald-400" />
            <h1 className="mb-2 text-lg font-semibold text-white">Approved</h1>
            <p className="text-sm leading-relaxed text-white/60">
              Your agent can complete this {amt} payment now. You can turn autonomous spending off any time from your
              dashboard.
            </p>
          </>
        ) : result === "denied" ? (
          <>
            <Hand className="mx-auto mb-3 h-8 w-8 text-amber-400" />
            <h1 className="mb-2 text-lg font-semibold text-white">Declined</h1>
            <p className="text-sm leading-relaxed text-white/60">
              Your agent will not make this payment. Nothing was charged.
            </p>
          </>
        ) : error ? (
          <>
            <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-amber-400" />
            <h1 className="mb-2 text-lg font-semibold text-white">Can&apos;t approve this</h1>
            <p className="text-sm leading-relaxed text-white/60">{error}</p>
          </>
        ) : view && view.ok && (view.status === "pending_approval" || view.status === "approved") ? (
          <>
            <ShieldCheck className="mx-auto mb-3 h-8 w-8 text-[#3b6cf6]" />
            <h1 className="mb-1 text-lg font-semibold text-white">Approve this payment?</h1>
            <p className="mb-5 text-sm text-white/50">
              {view.agent_name ? `${view.agent_name} ` : "Your agent "}wants to spend
            </p>
            <div className="mb-6 rounded-xl border border-white/10 bg-black/30 p-4 text-left">
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-xs uppercase tracking-wide text-white/40">Amount</span>
                <span className="text-xl font-semibold text-white">{amt}</span>
              </div>
              {view.category ? (
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-xs uppercase tracking-wide text-white/40">For</span>
                  <span className="text-sm text-white/80">{view.category}</span>
                </div>
              ) : null}
              {view.counterparty ? (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs uppercase tracking-wide text-white/40">To</span>
                  <span className="max-w-[60%] truncate text-sm text-white/80" title={view.counterparty}>
                    {view.counterparty}
                  </span>
                </div>
              ) : null}
            </div>
            {view.status === "approved" ? (
              <p className="mb-4 text-sm text-emerald-400/90">You already approved this. Your agent can proceed.</p>
            ) : null}
            <div className="flex gap-3">
              <button
                onClick={() => act("deny")}
                disabled={acting}
                className="flex-1 rounded-xl border border-white/15 bg-transparent py-2.5 text-sm font-medium text-white/80 transition hover:bg-white/5 disabled:opacity-50"
              >
                Decline
              </button>
              <button
                onClick={() => act("approve")}
                disabled={acting}
                className="flex-1 rounded-xl bg-[#3b6cf6] py-2.5 text-sm font-semibold text-white transition hover:bg-[#3460e0] disabled:opacity-50"
              >
                {acting ? "…" : "Approve"}
              </button>
            </div>
            <p className="mt-4 text-xs text-white/30">Only you can approve this — it&apos;s tied to your account.</p>
          </>
        ) : (
          <>
            <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-amber-400" />
            <h1 className="mb-2 text-lg font-semibold text-white">Nothing to approve</h1>
            <p className="text-sm leading-relaxed text-white/60">
              {view?.status === "consumed"
                ? "This spend was already completed."
                : view?.status === "denied"
                  ? "You already declined this spend."
                  : view?.status === "expired"
                    ? "This approval expired. Ask your agent to try again."
                    : "This approval is no longer available."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default function ApprovePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[70vh] items-center justify-center text-white/50">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <ApproveInner />
    </Suspense>
  );
}
