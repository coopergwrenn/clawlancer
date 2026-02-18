"use client";

import HeartbeatCard from "@/components/dashboard/heartbeat-card";

export default function HeartbeatPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-10" data-tour="page-heartbeat">
      {/* ── Page Header ── */}
      <div>
        <h1
          className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Heartbeat
        </h1>
        <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
          Your agent&apos;s pulse. See when it last checked in and control how
          often it does.
        </p>
      </div>

      {/* ── Heartbeat Card ── */}
      <HeartbeatCard />

      {/* ── How It Works ── */}
      <div
        className="glass rounded-xl p-6"
        style={{ border: "1px solid var(--border)" }}
      >
        <h2
          className="text-lg font-normal tracking-[-0.3px] mb-4"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          How it works
        </h2>
        <div className="space-y-3 text-sm" style={{ color: "var(--muted)" }}>
          <p>
            On a regular schedule, your agent wakes up, checks for new messages,
            reviews pending tasks, and processes anything that needs attention.
            Think of it like your agent glancing at its phone.
          </p>
          <p>
            Heartbeats run on a{" "}
            <strong style={{ color: "var(--foreground)" }}>
              separate pool of 200 daily credits
            </strong>{" "}
            that don&apos;t count against your visible limit. Your regular
            credits stay untouched.
          </p>
          <p>
            More frequent heartbeats mean a more responsive agent, but use more
            of that pool. At 1h, your agent uses roughly 160 of 200 credits per
            day. At 12h, it barely uses any.
          </p>
        </div>
      </div>
    </div>
  );
}
