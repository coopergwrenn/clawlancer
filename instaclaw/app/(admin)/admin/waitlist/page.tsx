"use client";

import { useState, useEffect, useCallback } from "react";

interface WaitlistEntry {
  id: string;
  email: string;
  position: number;
  created_at: string;
  invite_sent_at: string | null;
  invite_code: string | null;
}

export default function AdminWaitlistPage() {
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [sending, setSending] = useState(false);
  const [count, setCount] = useState(5);
  const [result, setResult] = useState("");

  const fetchWaitlist = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/stats?type=waitlist");
      const data = await res.json();
      setEntries(data.waitlist ?? []);
    } catch {
      // Handle error
    }
  }, []);

  useEffect(() => {
    fetchWaitlist();
  }, [fetchWaitlist]);

  async function sendInvites() {
    setSending(true);
    setResult("");
    try {
      const res = await fetch("/api/admin/send-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count }),
      });
      const data = await res.json();
      setResult(`Sent ${data.sent} invites.`);
      fetchWaitlist();
    } catch {
      setResult("Failed to send invites.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Waitlist</h1>

      {/* Send invites */}
      <div className="glass rounded-xl p-4 flex gap-3 items-end">
        <div className="w-24">
          <label className="text-xs block mb-1" style={{ color: "var(--muted)" }}>
            Count
          </label>
          <input
            type="number"
            min={1}
            max={100}
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
          onClick={sendInvites}
          disabled={sending}
          className="px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer disabled:opacity-50"
          style={{ background: "#ffffff", color: "#000000" }}
        >
          {sending ? "Sending..." : "Send Invites to Next in Line"}
        </button>
        {result && (
          <span className="text-sm" style={{ color: "var(--success)" }}>
            {result}
          </span>
        )}
      </div>

      {/* Waitlist table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ color: "var(--muted)" }}>
              <th className="text-left py-2 px-3">#</th>
              <th className="text-left py-2 px-3">Email</th>
              <th className="text-left py-2 px-3">Joined</th>
              <th className="text-left py-2 px-3">Invite Sent</th>
              <th className="text-left py-2 px-3">Code</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.id}
                className="border-t"
                style={{ borderColor: "var(--border)" }}
              >
                <td className="py-2 px-3">{entry.position}</td>
                <td className="py-2 px-3">{entry.email}</td>
                <td className="py-2 px-3" style={{ color: "var(--muted)" }}>
                  {new Date(entry.created_at).toLocaleDateString()}
                </td>
                <td className="py-2 px-3">
                  {entry.invite_sent_at ? (
                    <span style={{ color: "var(--success)" }}>
                      {new Date(entry.invite_sent_at).toLocaleDateString()}
                    </span>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>—</span>
                  )}
                </td>
                <td
                  className="py-2 px-3 font-mono text-xs"
                  style={{ color: "var(--muted)" }}
                >
                  {entry.invite_code ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 && (
          <p className="text-center py-8 text-sm" style={{ color: "var(--muted)" }}>
            Waitlist is empty.
          </p>
        )}
      </div>
    </div>
  );
}
