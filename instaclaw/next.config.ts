import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  serverExternalPackages: ["node-ssh", "ssh2"],
  outputFileTracingIncludes: {
    "/api/**": [
      "./skills/**/*",

      // 2026-05-21: cloud-init self-test ENOENT post-mortem.
      //
      // The 2026-05-05 commit cb4d20c3 left an assertion in this file
      // claiming `./scripts/browser-relay-server/**/*` worked. It does
      // NOT. The hypothesis below the matchpool block (Next's `**`
      // requires ≥1 path segment) was correct but mis-applied: the
      // working `./skills/**/*` works because skills/ has nested skill
      // dirs underneath. `./scripts/browser-relay-server/` has NO
      // subdirs — only three flat files (browser-relay-server.js,
      // browser-relay-server.service, README.md). So `./scripts/
      // browser-relay-server/**/*` matches zero files, and
      // `browser-relay-server.js` is silently excluded from the
      // Vercel function bundle.
      //
      // Empirical surface: 2026-05-21 fresh signup hit
      //   `ENOENT: no such file or directory, open '/ROOT/instaclaw/
      //   scripts/browser-relay-server/browser-relay-server.js'`
      // when `lib/cloud-init-tarball.ts:getBrowserRelayServerJs()`
      // tried readFileSync. This was the THIRD same-class bug today:
      //   1. `instaclaw_vms.api_key` column INSERT in createUserVM
      //      (column never existed; tests mocked Supabase so undetected)
      //   2. AMBASSADOR_25_OFF coupon name 41 chars (Stripe 40-char cap)
      //   3. browser-relay-server.js not in function bundle (this)
      // Each was a latent code path never exercised in production
      // before today — that pattern is the real problem, not any
      // single bug.
      //
      // Fix: switch from the broken `<dir>/**/*` shape (requires ≥1
      // path segment of nesting) to `<dir>/*` (matches direct
      // children). Mirrors the working `./scripts/*.py` shape Cooper
      // documented below.
      "./scripts/browser-relay-server/*",

      // 2026-05-21: check-skill-updates.sh — same root cause.
      // Read at runtime by lib/cloud-init-tarball.ts:1214 via
      // getCheckSkillUpdatesSh() but never bundled. Lived directly in
      // scripts/ (not a subdir), so `./scripts/**/*` skipped it.
      // Wasn't observed in production yet ONLY because the tarball
      // builder threw on browser-relay-server.js FIRST and never
      // reached this getter. Glob-shape-with-name avoids the
      // "individual files don't trace" failure mode Cooper saw on
      // 2026-05-05.
      "./scripts/check-skill-updates*",

      // privacy-bridge.sh is read at runtime by lib/privacy-bridge-script.ts
      // (which the reconciler imports) and deployed to edge_city VMs.
      "./lib/privacy-bridge.sh",

      // Consensus matching engine VM-side scripts (Components 4, 7, 8, 9, 10).
      // Loaded lazily by lib/matchpool-scripts.ts on first reconcile call;
      // without this include Next's tracing skips them and the reconciler
      // throws on getTemplateContent for the matchpool keys.
      //
      // 2026-05-05: lazy-loaded matchpool .py scripts. Multiple glob shapes
      // tried — each silently dropped by Next 15's tracer:
      //   "./scripts/consensus_match_pipeline.py" (3f3443d2 — individual)
      //   "./scripts/consensus_*.py" (3f3443d2 — mid-name wildcard)
      //   "./scripts/**/*.py" (d28bf919 — recursive .py-only)
      //   "./scripts/**/*" (cb4d20c3 — recursive everything)
      //
      // Hypothesis: Next's glob requires `**` to match ≥1 path segment, so
      // `./scripts/**/*` only matches files in *subdirs* of scripts/. The
      // matchpool .py files live directly in `instaclaw/scripts/` (no subdir)
      // so every `**`-style glob misses them. Pair with a top-level `*.py`
      // glob to catch them.
      "./scripts/*.py",
      "./scripts/**/*",
    ],
  },
  async rewrites() {
    return [
      {
        source: "/.well-known/agent.json",
        destination: "/api/well-known/agent-json",
      },
    ];
  },
  async redirects() {
    return [
      // /edge-city was the original partner-portal URL. Renamed to /edge
      // on 2026-05-12 for a cleaner brand fit. Permanent redirect preserves
      // external links (sponsor emails, partner mailings, social shares)
      // that pointed at the old URL.
      { source: "/edge-city", destination: "/edge", permanent: true },
      { source: "/edge-city/:path*", destination: "/edge/:path*", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  disableLogger: true,
  automaticVercelMonitors: true,
});
