"use client";

import { useState } from "react";

export function NotificationBar() {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <div className="notification-bar sticky top-0 z-50 flex items-center justify-center gap-4 px-4 py-3 text-sm"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <p style={{ color: "var(--foreground)" }}>
        We&apos;re just getting started. Get updates as new features drop.
      </p>
      <button
        onClick={() => {
          const input = document.getElementById("waitlist-email") as HTMLInputElement | null;
          if (!input) return;
          input.focus();
          const form = input.closest(".rounded-xl");
          if (form) {
            form.classList.add("waitlist-pulse");
            setTimeout(() => form.classList.remove("waitlist-pulse"), 800);
          }
        }}
        className="shrink-0 px-4 py-1.5 rounded-full text-xs font-medium transition-snappy hover:opacity-80 cursor-pointer"
        style={{
          border: "1px solid var(--foreground)",
          color: "var(--foreground)",
        }}
      >
        Get notified
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 ml-2 p-1 rounded-full hover:opacity-60 transition-snappy cursor-pointer"
        aria-label="Dismiss"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
