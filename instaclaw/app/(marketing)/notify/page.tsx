"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Mail, ArrowRight, Check } from "lucide-react";

export default function NotifyPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Something went wrong");
        return;
      }

      setSubmitted(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleDiscordClick() {
    if (submitted && email) {
      try {
        await fetch("/api/notify", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim() }),
        });
      } catch {
        // fire-and-forget
      }
    }
  }

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-4 py-20">
      <div className="max-w-md w-full space-y-10">
        {/* Logo */}
        <Link href="/" className="flex items-center justify-center gap-1.5">
          <Image
            src="/logo.png"
            alt="Instaclaw"
            width={36}
            height={36}
            unoptimized
            style={{ imageRendering: "pixelated" }}
          />
          <span
            className="text-lg tracking-[-0.5px]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Instaclaw
          </span>
        </Link>

        {/* Email Signup Section */}
        <div
          className="rounded-2xl p-6 sm:p-8 space-y-5"
          style={{
            background:
              "linear-gradient(-75deg, rgba(255,255,255,0.05), rgba(255,255,255,0.2), rgba(255,255,255,0.05))",
            backdropFilter: "blur(2px)",
            WebkitBackdropFilter: "blur(2px)",
            boxShadow: `
              rgba(0,0,0,0.05) 0px 2px 2px 0px inset,
              rgba(255,255,255,0.5) 0px -2px 2px 0px inset,
              rgba(0,0,0,0.1) 0px 2px 4px 0px,
              rgba(255,255,255,0.2) 0px 0px 1.6px 4px inset
            `,
          }}
        >
          <div className="space-y-2 text-center">
            <h1
              className="text-2xl sm:text-3xl font-normal tracking-[-0.5px]"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Stay in the loop.
            </h1>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              Get notified when we ship new features, open more spots, or drop
              something cool.
            </p>
          </div>

          {submitted ? (
            <div className="flex items-center justify-center gap-2 py-4">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center"
                style={{ background: "var(--accent)" }}
              >
                <Check className="w-3.5 h-3.5 text-white" />
              </div>
              <p className="text-sm font-medium" style={{ color: "var(--foreground)" }}>
                You&apos;re in! We&apos;ll keep you posted.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="relative">
                <Mail
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4"
                  style={{ color: "var(--muted)" }}
                />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@email.com"
                  required
                  className="w-full pl-10 pr-4 py-3 rounded-xl text-sm outline-none transition-all"
                  style={{
                    background: "rgba(255,255,255,0.5)",
                    border: "1px solid var(--border)",
                    color: "var(--foreground)",
                  }}
                />
              </div>
              {error && (
                <p className="text-xs text-red-500 px-1">{error}</p>
              )}
              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 rounded-xl text-sm font-semibold transition-all cursor-pointer disabled:opacity-60"
                style={{
                  background:
                    "linear-gradient(180deg, rgba(220,103,67,0.95) 0%, rgba(200,85,52,1) 100%)",
                  color: "#ffffff",
                  boxShadow: `
                    rgba(255,255,255,0.25) 0px 1px 1px 0px inset,
                    rgba(220,103,67,0.15) 0px -2px 4px 0px inset
                  `,
                }}
              >
                {loading ? "Signing up..." : "Notify me"}
              </button>
            </form>
          )}
        </div>

        {/* Discord CTA */}
        <div className="text-center space-y-3">
          <div
            className="w-full h-px"
            style={{ background: "var(--border)" }}
          />
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Want real-time updates and community chat?
          </p>
          <a
            href="https://discord.gg/instaclaw"
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleDiscordClick}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80"
            style={{
              background:
                "linear-gradient(-75deg, rgba(255,255,255,0.05), rgba(255,255,255,0.15), rgba(255,255,255,0.05))",
              boxShadow: `
                rgba(0,0,0,0.05) 0px 1px 1px 0px inset,
                rgba(255,255,255,0.4) 0px -1px 1px 0px inset,
                rgba(0,0,0,0.08) 0px 1px 3px 0px
              `,
              color: "var(--foreground)",
            }}
          >
            <svg width="18" height="14" viewBox="0 0 71 55" fill="currentColor" opacity={0.7}>
              <path d="M60.1 4.9A58.5 58.5 0 0 0 45.4.2a.2.2 0 0 0-.2.1 40.8 40.8 0 0 0-1.8 3.7 54 54 0 0 0-16.2 0A37.4 37.4 0 0 0 25.4.3a.2.2 0 0 0-.2-.1A58.4 58.4 0 0 0 10.5 4.9a.2.2 0 0 0-.1.1C1.5 18.7-.9 32.2.3 45.5v.2a58.9 58.9 0 0 0 17.7 9a.2.2 0 0 0 .3-.1 42.1 42.1 0 0 0 3.6-5.9.2.2 0 0 0-.1-.3 38.8 38.8 0 0 1-5.5-2.6.2.2 0 0 1 0-.4l1.1-.9a.2.2 0 0 1 .2 0 42 42 0 0 0 35.6 0 .2.2 0 0 1 .2 0l1.1.9a.2.2 0 0 1 0 .4 36.4 36.4 0 0 1-5.5 2.6.2.2 0 0 0-.1.3 47.3 47.3 0 0 0 3.6 5.9.2.2 0 0 0 .3.1 58.7 58.7 0 0 0 17.7-9 .2.2 0 0 0 .1-.2c1.4-15-2.3-28-9.9-39.6a.2.2 0 0 0-.1 0ZM23.7 37.3c-3.4 0-6.3-3.2-6.3-7s2.8-7 6.3-7 6.4 3.1 6.3 7-2.8 7-6.3 7Zm23.2 0c-3.4 0-6.3-3.2-6.3-7s2.8-7 6.3-7 6.4 3.1 6.3 7-2.8 7-6.3 7Z"/>
            </svg>
            Join our Discord
            <ArrowRight className="w-3.5 h-3.5" style={{ opacity: 0.5 }} />
          </a>
        </div>
      </div>
    </div>
  );
}
