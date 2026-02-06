"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";

export default function SignupPage() {
  const [code, setCode] = useState("");
  const [validated, setValidated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function formatCode(value: string) {
    const clean = value.replace(/[^A-Za-z2-9]/g, "").toUpperCase().slice(0, 12);
    const parts = clean.match(/.{1,4}/g) ?? [];
    return parts.join("-");
  }

  async function handleValidate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/invite/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();

      if (data.valid) {
        setValidated(true);
      } else {
        setError(data.message || "Invalid invite code.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleSignIn() {
    // Store invite code in localStorage so it can be consumed after OAuth
    localStorage.setItem("instaclaw_invite_code", code);
    await signIn("google", { callbackUrl: "/connect" });
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md space-y-8 text-center">
        <div>
          <h1 className="text-3xl font-bold">Join InstaClaw</h1>
          <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>
            Enter your invite code to get started.
          </p>
        </div>

        {!validated ? (
          <form onSubmit={handleValidate} className="space-y-4">
            <input
              type="text"
              placeholder="XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(formatCode(e.target.value))}
              className="w-full px-4 py-3 rounded-lg text-sm text-center tracking-widest font-mono outline-none"
              style={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                color: "var(--foreground)",
              }}
            />
            <button
              type="submit"
              disabled={loading || code.length < 14}
              className="w-full px-6 py-3 rounded-lg text-sm font-semibold transition-all cursor-pointer disabled:opacity-50 hover:shadow-[0_0_20px_rgba(255,255,255,0.2)]"
              style={{ background: "#ffffff", color: "#000000" }}
            >
              {loading ? "Checking..." : "Validate Code"}
            </button>
            {error && (
              <p className="text-sm" style={{ color: "var(--error)" }}>
                {error}
              </p>
            )}
          </form>
        ) : (
          <div className="space-y-4">
            <div
              className="glass rounded-xl px-4 py-3 text-sm"
              style={{ color: "var(--success)" }}
            >
              Invite code accepted!
            </div>
            <button
              onClick={handleGoogleSignIn}
              className="w-full px-6 py-3 rounded-lg text-sm font-semibold transition-all cursor-pointer flex items-center justify-center gap-3 hover:shadow-[0_0_20px_rgba(255,255,255,0.2)]"
              style={{ background: "#ffffff", color: "#000000" }}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
              Continue with Google
            </button>
          </div>
        )}

        <p className="text-xs" style={{ color: "var(--muted)" }}>
          Don&apos;t have a code?{" "}
          <a href="/" className="underline hover:text-white transition-colors">
            Join the waitlist
          </a>
        </p>
      </div>
    </div>
  );
}
