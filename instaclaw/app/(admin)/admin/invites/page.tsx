"use client";

import { useState, useEffect, useCallback } from "react";

interface Invite {
  id: string;
  code: string;
  email: string | null;
  max_uses: number;
  times_used: number;
  is_active: boolean;
  expires_at: string | null;
  created_at: string;
}

export default function AdminInvitesPage() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [count, setCount] = useState(1);
  const [generating, setGenerating] = useState(false);
  const [generatedCodes, setGeneratedCodes] = useState<string[]>([]);

  const fetchInvites = useCallback(async () => {
    try {
      const res = await fetch("/api/invite/generate");
      const data = await res.json();
      setInvites(data.invites ?? []);
    } catch {
      // Handle error
    }
  }, []);

  useEffect(() => {
    fetchInvites();
  }, [fetchInvites]);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setGenerating(true);
    setGeneratedCodes([]);
    try {
      const res = await fetch("/api/invite/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email || undefined, count }),
      });
      const data = await res.json();
      setGeneratedCodes(data.codes ?? []);
      setEmail("");
      fetchInvites();
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Invite Codes</h1>

      {/* Generate form */}
      <form onSubmit={generate} className="glass rounded-xl p-4 flex gap-3 items-end">
        <div className="flex-1">
          <label className="text-xs block mb-1" style={{ color: "var(--muted)" }}>
            Email (optional)
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user@example.com"
            className="w-full px-3 py-2 rounded-lg text-sm outline-none"
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
            }}
          />
        </div>
        <div className="w-24">
          <label className="text-xs block mb-1" style={{ color: "var(--muted)" }}>
            Count
          </label>
          <input
            type="number"
            min={1}
            max={50}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="w-full px-3 py-2 rounded-lg text-sm outline-none"
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
            }}
          />
        </div>
        <button
          type="submit"
          disabled={generating}
          className="px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer disabled:opacity-50"
          style={{ background: "#ffffff", color: "#000000" }}
        >
          {generating ? "Generating..." : "Generate"}
        </button>
      </form>

      {generatedCodes.length > 0 && (
        <div className="glass rounded-xl p-4 space-y-2">
          <p className="text-sm font-medium">Generated Codes:</p>
          <div className="space-y-1">
            {generatedCodes.map((code) => (
              <p key={code} className="font-mono text-sm tracking-wider">
                {code}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Invites table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ color: "var(--muted)" }}>
              <th className="text-left py-2 px-3">Code</th>
              <th className="text-left py-2 px-3">Email</th>
              <th className="text-left py-2 px-3">Uses</th>
              <th className="text-left py-2 px-3">Active</th>
              <th className="text-left py-2 px-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {invites.map((inv) => (
              <tr
                key={inv.id}
                className="border-t"
                style={{ borderColor: "var(--border)" }}
              >
                <td className="py-2 px-3 font-mono tracking-wider">
                  {inv.code}
                </td>
                <td className="py-2 px-3" style={{ color: "var(--muted)" }}>
                  {inv.email ?? "—"}
                </td>
                <td className="py-2 px-3">
                  {inv.times_used}/{inv.max_uses}
                </td>
                <td className="py-2 px-3">
                  <span
                    style={{
                      color: inv.is_active ? "var(--success)" : "var(--error)",
                    }}
                  >
                    {inv.is_active ? "Yes" : "No"}
                  </span>
                </td>
                <td className="py-2 px-3" style={{ color: "var(--muted)" }}>
                  {new Date(inv.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {invites.length === 0 && (
          <p className="text-center py-8 text-sm" style={{ color: "var(--muted)" }}>
            No invites generated yet.
          </p>
        )}
      </div>
    </div>
  );
}
