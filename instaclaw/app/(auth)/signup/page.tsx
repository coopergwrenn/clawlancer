"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import Image from "next/image";
import Link from "next/link";

export default function SignupPage() {
  const [code, setCode] = useState("");
  const [validated, setValidated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function formatCode(value: string) {
    const clean = value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 12);
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
    // Store invite code in a server-set HttpOnly cookie (survives OAuth redirects reliably)
    await fetch("/api/invite/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    await signIn("google", { callbackUrl: "/connect" });
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{
        background: "#f8f7f4",
        color: "#333334",
      }}
    >
      <div className="w-full max-w-md space-y-10">
        {/* Logo */}
        <Link href="/" className="flex items-center justify-center gap-2">
          <Image src="/logo.png" alt="Instaclaw" width={40} height={40} unoptimized style={{ imageRendering: "pixelated" }} />
          <span
            className="text-2xl tracking-[-0.5px]"
            style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
          >
            Instaclaw
          </span>
        </Link>

        {/* Heading */}
        <div className="text-center space-y-3">
          <h1
            className="text-4xl sm:text-5xl font-normal tracking-[-1px]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Join Instaclaw
          </h1>
          <p className="text-base" style={{ color: "#6b6b6b" }}>
            Enter your invite code to get started.
          </p>
        </div>

        {!validated ? (
          <form onSubmit={handleValidate} className="space-y-5">
            <div>
              <input
                type="text"
                placeholder="XXXX-XXXX-XXXX"
                value={code}
                onChange={(e) => setCode(formatCode(e.target.value))}
                className="w-full px-4 py-4 rounded-lg text-base text-center tracking-widest font-mono outline-none transition-colors"
                style={{
                  background: "#ffffff",
                  border: "1px solid rgba(0, 0, 0, 0.1)",
                  color: "#333334",
                }}
              />
            </div>

            <button
              type="submit"
              disabled={loading || code.length < 14}
              className="w-full px-6 py-4 rounded-lg text-base font-semibold transition-all cursor-pointer disabled:opacity-50"
              style={{
                background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                backdropFilter: "blur(2px)",
                WebkitBackdropFilter: "blur(2px)",
                boxShadow: "rgba(255,255,255,0.2) 0px 2px 2px 0px inset, rgba(255,255,255,0.3) 0px -1px 1px 0px inset, rgba(220,103,67,0.35) 0px 4px 16px 0px, rgba(255,255,255,0.08) 0px 0px 1.6px 4px inset",
                color: "#ffffff",
              }}
            >
              {loading ? "Checking..." : "Validate Code"}
            </button>

            {error && (
              <p className="text-sm text-center" style={{ color: "#ef4444" }}>
                {error}
              </p>
            )}
          </form>
        ) : (
          <div className="space-y-5">
            {/* Success message */}
            <div
              className="px-5 py-4 rounded-lg text-center text-base"
              style={{
                background: "#ffffff",
                border: "2px solid #22c55e",
                color: "#22c55e",
              }}
            >
              ✓ Invite code accepted
            </div>

            {/* Google sign-in */}
            <button
              onClick={handleGoogleSignIn}
              className="w-full px-6 py-4 rounded-lg text-base font-semibold transition-all cursor-pointer flex items-center justify-center gap-3"
              style={{
                background: "#ffffff",
                color: "#333334",
                border: "1px solid rgba(0, 0, 0, 0.1)",
              }}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.10z"
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

        {/* Back to waitlist */}
        <p className="text-sm text-center" style={{ color: "#6b6b6b" }}>
          Don&apos;t have a code?{" "}
          <Link
            href="/"
            className="underline transition-opacity hover:opacity-70"
            style={{ color: "#333334" }}
          >
            Join the waitlist
          </Link>
        </p>
      </div>
    </div>
  );
}
