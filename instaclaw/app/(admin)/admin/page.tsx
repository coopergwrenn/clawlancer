"use client";

import { useState, useEffect } from "react";

interface Stats {
  pool: {
    total_vms: number;
    ready_vms: number;
    assigned_vms: number;
    failed_vms: number;
    pending_users: number;
  };
  waitlist: number;
  users: number;
}

export default function AdminOverviewPage() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch("/api/admin/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  if (!stats) {
    return (
      <div className="text-center py-12">
        <p style={{ color: "var(--muted)" }}>Loading stats...</p>
      </div>
    );
  }

  const cards = [
    { label: "Total VMs", value: stats.pool.total_vms },
    { label: "Ready", value: stats.pool.ready_vms, color: "var(--success)" },
    { label: "Assigned", value: stats.pool.assigned_vms },
    { label: "Failed", value: stats.pool.failed_vms, color: "var(--error)" },
    { label: "Pending Users", value: stats.pool.pending_users },
    { label: "Waitlist", value: stats.waitlist },
    { label: "Total Users", value: stats.users },
  ];

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Admin Overview</h1>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="glass rounded-xl p-5">
            <p className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>
              {card.label}
            </p>
            <p
              className="text-3xl font-bold mt-1"
              style={{ color: card.color ?? "#ffffff" }}
            >
              {card.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
