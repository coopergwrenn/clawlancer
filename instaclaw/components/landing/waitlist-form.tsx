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
      <div className="glow-wrap">
        <div className="glow-border">
          <div className="glow-spinner" />
          <div className="glow-content">
            <form onSubmit={handleSubmit} className="flex">
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="flex-1 px-4 py-3 text-sm outline-none bg-transparent"
                style={{
                  color: "var(--foreground)",
                }}
              />
              <button
                type="submit"
                disabled={state === "loading"}
                className="px-8 py-3 text-sm font-semibold transition-all cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
                style={{
                  background: "var(--accent)",
                  color: "#ffffff",
                  borderRadius: "calc(0.5rem - 2px)",
                  margin: "2px",
                }}
              >
                {state === "loading" ? "Joining..." : "Get Early Access"}
              </button>
            </form>
          </div>
        </div>
      </div>
      {state === "error" && (
        <p className="absolute mt-2 text-xs text-red-400 w-full text-center">{errorMsg}</p>
      )}
    </div>
  );
}
