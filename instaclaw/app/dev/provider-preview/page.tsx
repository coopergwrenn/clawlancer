"use client";

/**
 * Dev-only preview for /onboarding/provider client. Renders the same
 * client component without the server-side auth gate, by monkey-patching
 * globalThis.fetch to satisfy the two endpoints the page calls
 * (provider-status, save-provider) with deterministic responses.
 *
 * Visit /dev/provider-preview?case=<key> to render each state.
 *
 *   case=byok-no-provider      (default) — show the configure UI
 *   case=byok-has-anthropic    — short-circuits forward; expect redirect
 *   case=byok-has-chatgpt      — short-circuits forward; expect redirect
 *   case=all-inclusive         — short-circuits to /deploying
 *   case=byok-channel          — configure UI + channel-aware redirect target
 *
 * NOT linked from anywhere in the app. Gated to dev so the page itself
 * is a no-op in production builds.
 */

import { useEffect, useRef, useState } from "react";
import { ProviderClient } from "@/app/(onboarding)/onboarding/provider/provider-client";

type Case =
  | "byok-no-provider"
  | "byok-has-anthropic"
  | "byok-has-chatgpt"
  | "all-inclusive"
  | "byok-channel";

interface MockStatus {
  pendingId: string | null;
  apiMode: "byok" | "all_inclusive" | null;
  channel: string | null;
  hasAnthropicKey: boolean;
  hasChatGPTOAuth: boolean;
  chatgptPlanType: string | null;
}

const CASES: Record<Case, MockStatus> = {
  "byok-no-provider": {
    pendingId: "00000000-0000-4000-8000-000000000001",
    apiMode: "byok",
    channel: null,
    hasAnthropicKey: false,
    hasChatGPTOAuth: false,
    chatgptPlanType: null,
  },
  "byok-has-anthropic": {
    pendingId: "00000000-0000-4000-8000-000000000002",
    apiMode: "byok",
    channel: null,
    hasAnthropicKey: true,
    hasChatGPTOAuth: false,
    chatgptPlanType: null,
  },
  "byok-has-chatgpt": {
    pendingId: "00000000-0000-4000-8000-000000000003",
    apiMode: "byok",
    channel: null,
    hasAnthropicKey: false,
    hasChatGPTOAuth: true,
    chatgptPlanType: "plus",
  },
  "all-inclusive": {
    pendingId: "00000000-0000-4000-8000-000000000004",
    apiMode: "all_inclusive",
    channel: null,
    hasAnthropicKey: false,
    hasChatGPTOAuth: false,
    chatgptPlanType: null,
  },
  "byok-channel": {
    pendingId: "00000000-0000-4000-8000-000000000005",
    apiMode: "byok",
    channel: "imessage",
    hasAnthropicKey: false,
    hasChatGPTOAuth: false,
    chatgptPlanType: null,
  },
};

export default function ProviderPreviewPage() {
  const [activeCase, setActiveCase] = useState<Case>("byok-no-provider");
  const [ready, setReady] = useState(false);
  // Restore original fetch on unmount so we don't poison the dev shell.
  const originalFetchRef = useRef<typeof fetch | null>(null);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;

    // Read case from URL the first time the component runs. We don't
    // sync the URL on toggle — re-mount the page via the link list to
    // pick up a new case (keeps the override logic simple and the
    // route stable for screenshot reproducibility).
    const url = new URL(window.location.href);
    const qsCase = url.searchParams.get("case") as Case | null;
    if (qsCase && qsCase in CASES) setActiveCase(qsCase);

    if (!originalFetchRef.current) {
      originalFetchRef.current = window.fetch.bind(window);
    }
    const origFetch = originalFetchRef.current;

    // Install fetch override. We intercept the two endpoints the
    // client uses and pass through everything else (Next dev RSC
    // requests, etc.) so the rest of the page works normally.
    window.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith("/api/onboarding/provider-status")) {
        const body = CASES[
          (new URL(window.location.href).searchParams.get(
            "case",
          ) as Case | null) ?? "byok-no-provider"
        ];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/onboarding/save-provider")) {
        // Pretend the save succeeded. The client then calls router.replace
        // to navigate forward — that's the only proof of behavior we need.
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    setReady(true);

    return () => {
      if (originalFetchRef.current) {
        window.fetch = originalFetchRef.current;
      }
    };
  }, []);

  // Production guard — keep the page inert.
  if (process.env.NODE_ENV === "production") {
    return (
      <p style={{ padding: 24, fontFamily: "monospace" }}>
        /dev/provider-preview is dev-only.
      </p>
    );
  }

  return (
    <div>
      {ready && <ProviderClient stripeSessionId="cs_test_devpreview_123" />}
      {/* Bottom-corner case picker. position: fixed so it overlays the
          page without affecting layout. Each link reloads the page
          with the case query param so the fetch override picks it up
          on initial render — the simplest reload-correctness path. */}
      <div
        style={{
          position: "fixed",
          bottom: 16,
          left: 16,
          background: "rgba(255,255,255,0.92)",
          padding: "10px 14px",
          borderRadius: 10,
          fontSize: 11,
          fontFamily: "monospace",
          boxShadow: "0 2px 12px rgba(0,0,0,0.12)",
          zIndex: 9999,
          maxWidth: 320,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          dev preview — case: <span style={{ color: "#DC6743" }}>{activeCase}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {(Object.keys(CASES) as Case[]).map((k) => (
            <a
              key={k}
              href={`/dev/provider-preview?case=${k}`}
              style={{
                color: k === activeCase ? "#DC6743" : "#333",
                textDecoration: "underline",
              }}
            >
              {k}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
