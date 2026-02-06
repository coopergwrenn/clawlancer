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
    <form onSubmit={handleSubmit} className="flex gap-3 max-w-md mx-auto w-full">
      <input
        type="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        className="flex-1 px-4 py-3 rounded-lg text-sm outline-none transition-colors"
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          color: "var(--foreground)",
        }}
      />
      <button
        type="submit"
        disabled={state === "loading"}
        className="px-6 py-3 rounded-lg text-sm font-semibold transition-all cursor-pointer disabled:opacity-50 hover:shadow-[0_0_20px_rgba(255,255,255,0.2)]"
        style={{
          background: "#ffffff",
          color: "#000000",
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.background = "rgba(255, 255, 255, 0.9)")
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = "#ffffff")
        }
      >
        {state === "loading" ? "Joining..." : "Get Early Access"}
      </button>
      {state === "error" && (
        <p className="absolute mt-14 text-xs text-red-400">{errorMsg}</p>
      )}
    </form>
  );
}
