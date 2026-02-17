"use client";

import HeartbeatCard from "@/components/dashboard/heartbeat-card";

export default function HeartbeatPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1
        className="text-2xl font-bold mb-1"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        Heartbeat
      </h1>
      <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>
        Your agent checks in on a regular heartbeat. Monitor its pulse and
        adjust how often it phones home.
      </p>
      <HeartbeatCard />
    </div>
  );
}
