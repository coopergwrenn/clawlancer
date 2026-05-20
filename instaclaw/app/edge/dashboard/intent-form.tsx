"use client";

/**
 * IntentForm — the "what are you looking for?" submit form for
 * /edge/dashboard. POSTs to /api/edge/express-intent, which calls
 * Yanek's create_intent MCP tool via createIndexIntent.
 *
 * UI states (5):
 *   • idle      — initial; user can type, submit disabled until 10+ chars
 *   • editing   — user is typing; live char counter, submit enabled when valid
 *   • submitting — POST in flight; button shows spinner; textarea disabled
 *   • success   — confirmation message; form clears for the next intent
 *   • error     — error message; user can edit + resubmit
 *
 * Styling matches the existing edge-dashboard-client.tsx pattern:
 *   • CSS variables from app/edge/layout.tsx (--edge-olive, --edge-ink,
 *     --edge-line, --edge-bg, --edge-ink-soft)
 *   • Inline-style props (the dashboard already uses this; Tailwind
 *     isn't loaded in this layout)
 *   • Mobile-first: textarea + button stack vertically below ~480px,
 *     side-by-side above. CSS-only via flex-wrap.
 *
 * Copy: lowercase per InstaClaw convention. Voice: forward-leaning,
 * declarative ("send it", "what are you looking for?") — matches the
 * dashboard's other CTAs ("Save", "Visible/Hidden").
 *
 * Error mapping:
 *   • 200 + status: "created" → success state, show response.message
 *   • 400 + status: "validation_error" → error state, show response.message
 *   • 403 + status: "not_eligible" → error state, show response.message
 *   • 429 + status: "rate_limited" → error state, show response.message
 *     with the retry-after countdown
 *   • 503 + status: "service_unavailable" → error state, show response.message
 *     (this is the Yanek-write-tool-bug case; user sees friendly "coming
 *     online soon" message, not the raw error)
 *   • Network error → error state with generic "couldn't reach the server"
 */
import { useState } from "react";
import { Loader2, Check, Send } from "lucide-react";

const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 500;

type SubmitState = "idle" | "submitting" | "success" | "error";

/**
 * Optional callback props for caller-owned success/error UI. Used by the
 * /edge/intents mandatory-intent gate to render its own page-level reveal
 * (matching the /edge/claim verify-state aesthetic) instead of this
 * component's inline success message. When BOTH are provided, the form
 * delegates the moment entirely to the caller — its internal `success`
 * and `error` states never render, so the page transition is the single
 * visible animation (no double-render).
 *
 * Default behavior (when callbacks are absent): the form owns success/error
 * UI via its internal message panel. /edge/dashboard's adaptive section
 * uses this default.
 */
interface IntentFormProps {
  onSuccess?: (intentId: string) => void;
  onError?: (errorStatus: string) => void;
}

export function IntentForm({ onSuccess, onError }: IntentFormProps = {}) {
  const [description, setDescription] = useState<string>("");
  const [state, setState] = useState<SubmitState>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const trimmed = description.trim();
  const charCount = trimmed.length;
  const tooShort = charCount > 0 && charCount < DESCRIPTION_MIN;
  const tooLong = charCount > DESCRIPTION_MAX;
  const submittable = charCount >= DESCRIPTION_MIN && charCount <= DESCRIPTION_MAX && state !== "submitting";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!submittable) return;

    setState("submitting");
    setMessage(null);

    try {
      const res = await fetch("/api/edge/express-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        status?: string;
        message?: string;
        retryAfterSec?: number;
      };

      if (res.ok && data.status === "created") {
        // Caller-owned success path — delegate the UI moment entirely.
        // The page can unmount the form before our internal "success"
        // state ever renders, so no double-animation.
        if (onSuccess) {
          // intentId is optional in the response shape; pass-through.
          onSuccess(((data as { intentId?: string }).intentId) ?? "");
          return;
        }
        setState("success");
        setMessage(data.message ?? "your intent is registered.");
        setDescription("");
      } else {
        // Caller-owned error path — surface the upstream status code so the
        // caller can branch on service_unavailable (Yanek MCP down → reveal
        // skip-link escape hatch on /edge/intents).
        if (onError && data.status) {
          onError(data.status);
          // Fall through to set internal error state too — caller chooses
          // whether to reveal anything UI-side or hide it; we want the
          // default form-internal error UI to still appear so the user
          // sees feedback either way.
        }
        setState("error");
        setMessage(
          data.message ??
            "something went wrong — try again or refresh the page.",
        );
      }
    } catch {
      if (onError) onError("network");
      setState("error");
      setMessage("couldn't reach the server. check your connection and try again.");
    }
  }

  // Helper text below the textarea: char count + min hint
  const charCountColor = tooLong
    ? "#a83232"
    : tooShort
      ? "var(--edge-ink-soft)"
      : "var(--edge-ink-soft)";
  const charCountText = tooLong
    ? `${charCount} / ${DESCRIPTION_MAX} — too long`
    : tooShort
      ? `${charCount} / ${DESCRIPTION_MAX} — at least ${DESCRIPTION_MIN} characters`
      : `${charCount} / ${DESCRIPTION_MAX}`;

  return (
    <div
      style={{
        padding: "24px",
        border: "1px solid var(--edge-line)",
        borderRadius: "10px",
        background: "rgba(255,255,255,0.5)",
      }}
    >
      <h3
        style={{
          fontSize: "13px",
          fontWeight: 600,
          color: "var(--edge-ink-soft)",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          margin: "0 0 4px",
        }}
      >
        What are you looking for?
      </h3>
      <p
        style={{
          fontSize: "13.5px",
          color: "var(--edge-ink-soft)",
          margin: "0 0 14px",
          lineHeight: 1.55,
        }}
      >
        Tell the directory what you're working on or who you want to meet at
        Edge City. Your agent threads this into Index Network's discovery graph
        — when someone else's intent overlaps with yours, you both get a signal.
      </p>

      <form onSubmit={handleSubmit}>
        <textarea
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            // Clear stale success/error message once the user starts editing
            if (state === "success" || state === "error") {
              setState("idle");
              setMessage(null);
            }
          }}
          placeholder="i'm working on agentic browser automation and want to meet people researching multi-agent coordination protocols"
          rows={4}
          disabled={state === "submitting"}
          style={{
            width: "100%",
            padding: "12px 14px",
            fontSize: "14px",
            lineHeight: 1.55,
            border: `1px solid ${tooLong ? "#a83232" : "var(--edge-line)"}`,
            borderRadius: "7px",
            background: "var(--edge-bg)",
            color: "var(--edge-ink)",
            outline: "none",
            fontFamily: "inherit",
            resize: "vertical",
            minHeight: "100px",
            boxSizing: "border-box",
            opacity: state === "submitting" ? 0.6 : 1,
          }}
        />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            flexWrap: "wrap",
            marginTop: "10px",
          }}
        >
          <div
            style={{
              fontSize: "12px",
              color: charCountColor,
            }}
          >
            {charCountText}
          </div>
          <button
            type="submit"
            disabled={!submittable}
            style={{
              padding: "10px 18px",
              fontSize: "14px",
              fontWeight: 500,
              background: submittable ? "var(--edge-olive)" : "var(--edge-line)",
              color: "var(--edge-bg)",
              border: "none",
              borderRadius: "7px",
              cursor: submittable ? "pointer" : "not-allowed",
              opacity: state === "submitting" ? 0.6 : 1,
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            {state === "submitting" ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Sending…
              </>
            ) : state === "success" ? (
              <>
                <Check size={14} /> Sent
              </>
            ) : (
              <>
                <Send size={14} /> Send it
              </>
            )}
          </button>
        </div>

        {/* Status message — color-coded by state */}
        {message && (
          <div
            style={{
              marginTop: "12px",
              padding: "10px 12px",
              fontSize: "13px",
              lineHeight: 1.5,
              borderRadius: "7px",
              border: "1px solid",
              borderColor:
                state === "success"
                  ? "var(--edge-olive)"
                  : state === "error"
                    ? "#d99b9b"
                    : "var(--edge-line)",
              background:
                state === "success"
                  ? "rgba(120, 138, 70, 0.08)"
                  : state === "error"
                    ? "rgba(168, 50, 50, 0.06)"
                    : "transparent",
              color:
                state === "success"
                  ? "var(--edge-ink)"
                  : state === "error"
                    ? "#7a2424"
                    : "var(--edge-ink)",
            }}
          >
            {message}
          </div>
        )}
      </form>
    </div>
  );
}
