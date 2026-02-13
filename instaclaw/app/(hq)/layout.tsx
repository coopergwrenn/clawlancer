"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { Lock, Loader2 } from "lucide-react";

export default function HQLayout({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/hq/verify")
      .then((r) => r.json())
      .then((d) => setAuthed(d.authenticated))
      .catch(() => setAuthed(false));
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/hq/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setAuthed(true);
      } else {
        setError("Wrong password");
      }
    } catch {
      setError("Connection error");
    } finally {
      setLoading(false);
    }
  }

  // Loading state
  if (authed === null) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-theme="dashboard">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: "var(--muted)" }} />
      </div>
    );
  }

  // Password prompt
  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-theme="dashboard">
        <form onSubmit={handleLogin} className="w-80 space-y-4 text-center">
          <div className="flex justify-center">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center"
              style={{ background: "rgba(0,0,0,0.04)" }}
            >
              <Lock className="w-5 h-5" style={{ color: "var(--muted)" }} />
            </div>
          </div>
          <h1 className="text-lg font-semibold">HQ Access</h1>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            className="w-full px-4 py-2.5 rounded-lg text-sm outline-none"
            style={{
              background: "#ffffff",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
            }}
          />
          {error && (
            <p className="text-sm" style={{ color: "var(--error)" }}>{error}</p>
          )}
          <button
            type="submit"
            disabled={loading || !password}
            className="w-full py-2.5 rounded-lg text-sm font-medium transition-opacity disabled:opacity-40"
            style={{ background: "rgba(0,0,0,0.08)", color: "var(--foreground)" }}
          >
            {loading ? "Verifying..." : "Enter"}
          </button>
        </form>
      </div>
    );
  }

  // Authenticated layout
  return (
    <div className="min-h-screen" data-theme="dashboard">
      <nav
        className="border-b transition-colors"
        style={{ borderColor: "var(--border)", background: "var(--background)" }}
      >
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link
            href="/hq"
            className="flex items-center gap-1 text-xl tracking-[-0.5px] transition-opacity hover:opacity-70"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            <Image src="/logo.png" alt="InstaClaw" width={44} height={44} unoptimized style={{ imageRendering: "pixelated" }} />
            Instaclaw <span style={{ color: "var(--muted)" }}>HQ</span>
          </Link>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
