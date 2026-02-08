"use client";

import { useState } from "react";

export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">(
    "idle"
  );
  const [position, setPosition] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setState("loading");
    setErrorMsg("");

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, source: "landing" }),
      });
      const data = await res.json();

      if (!res.ok) {
        setState("error");
        setErrorMsg(data.message || "Something went wrong.");
        return;
      }

      setPosition(data.position ?? null);
      setState("success");
    } catch {
      setState("error");
      setErrorMsg("Network error. Please try again.");
    }
  }

  if (state === "success") {
    return (
      <div className="glass rounded-xl px-6 py-4 text-center">
        <p className="text-lg font-medium">You&apos;re on the list!</p>
        {position && (
          <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
            You&apos;re #{position} in line.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="relative max-w-md mx-auto w-full">
      <form onSubmit={handleSubmit} className="flex gap-3">
        <input
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="flex-1 px-6 py-3 text-sm outline-none rounded-xl"
          style={{
            color: "var(--foreground)",
            background: "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.05))",
            backdropFilter: "blur(2px)",
            WebkitBackdropFilter: "blur(2px)",
            boxShadow: `
              rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset,
              rgba(255, 255, 255, 0.5) 0px -2px 2px 0px inset,
              rgba(0, 0, 0, 0.1) 0px 2px 4px 0px,
              rgba(255, 255, 255, 0.2) 0px 0px 1.6px 4px inset
            `,
          }}
        />
        <div className="glow-wrap shrink-0">
          <div className="glow-border">
            <div className="glow-spinner" />
            <div className="glow-content">
              <button
                type="submit"
                disabled={state === "loading"}
                className="px-8 py-3 text-sm font-semibold transition-all cursor-pointer disabled:opacity-50 whitespace-nowrap"
                style={{
                  background: "linear-gradient(-75deg, var(--accent), color-mix(in srgb, var(--accent) 85%, white), var(--accent))",
                  color: "#ffffff",
                  backdropFilter: "blur(2px)",
                  WebkitBackdropFilter: "blur(2px)",
                  boxShadow: `
                    rgba(0, 0, 0, 0.1) 0px 2px 2px 0px inset,
                    rgba(255, 255, 255, 0.3) 0px -2px 2px 0px inset,
                    rgba(0, 0, 0, 0.15) 0px 2px 4px 0px,
                    rgba(255, 255, 255, 0.15) 0px 0px 1.6px 2px inset
                  `,
                }}
              >
                {state === "loading" ? "Joining..." : "Get Early Access"}
              </button>
            </div>
          </div>
        </div>
      </form>
      {state === "error" && (
        <p className="absolute mt-2 text-xs text-red-400 w-full text-center">{errorMsg}</p>
      )}
    </div>
  );
}
