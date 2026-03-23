"use client";

import { useState } from "react";
import { Link2, Copy, Check, Globe } from "lucide-react";

export function ConnectWorldWallet() {
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function generateCode() {
    setLoading(true);
    try {
      const res = await fetch("/api/link/generate", { method: "POST" });
      const data = await res.json();
      if (data.code) {
        setCode(data.code);
      }
    } catch (err) {
      console.error("Failed to generate linking code:", err);
    } finally {
      setLoading(false);
    }
  }

  function copyCode() {
    if (!code) return;
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      <h2
        className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        <Globe className="w-5 h-5" /> World Mini App
      </h2>
      <div
        className="glass rounded-xl p-6"
        style={{ border: "1px solid var(--border)" }}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex-1 mr-4">
            <p className="text-sm font-medium mb-1">Connect World Wallet</p>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              Link your instaclaw.io account to the World mini app so you can
              access the same agent from both platforms.
            </p>
          </div>
        </div>

        {!code ? (
          <button
            onClick={generateCode}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all"
            style={{
              background: "linear-gradient(180deg, rgba(220,103,67,0.95), rgba(200,85,52,1))",
              color: "#fff",
              opacity: loading ? 0.6 : 1,
            }}
          >
            <Link2 size={14} />
            {loading ? "Generating..." : "Generate Linking Code"}
          </button>
        ) : (
          <div>
            <div
              className="flex items-center justify-between rounded-lg px-4 py-3 mb-3"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid var(--border)" }}
            >
              <span className="font-mono text-2xl tracking-[0.3em] font-bold">
                {code}
              </span>
              <button
                onClick={copyCode}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all"
                style={{ background: "rgba(255,255,255,0.06)" }}
              >
                {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              Open the InstaClaw World mini app → Settings → &quot;Link instaclaw.io Account&quot;
              → paste this code. Expires in 10 minutes.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
