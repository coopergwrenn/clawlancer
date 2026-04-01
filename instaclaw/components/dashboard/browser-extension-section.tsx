"use client";

import { Globe } from "lucide-react";

interface Props {
  gatewayUrl: string;
}

export function BrowserExtensionSection({ gatewayUrl: _gatewayUrl }: Props) {
  return (
    <div>
      <h2
        className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        <Globe className="w-5 h-5" /> Connect Your Browser
      </h2>
      <div
        className="glass rounded-xl p-6 space-y-5"
        style={{ border: "1px solid var(--border)", opacity: 0.5, pointerEvents: "none" }}
      >
        {/* Coming Soon overlay */}
        <div className="flex items-center justify-center py-8">
          <div className="text-center">
            <p
              className="text-lg font-medium mb-1"
              style={{ color: "var(--muted)" }}
            >
              Coming Soon
            </p>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              Connect your Chrome browser so your agent can browse sites you&apos;re logged
              into — Instagram, Facebook, banking, and more.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
