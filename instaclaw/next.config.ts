import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  serverExternalPackages: ["node-ssh", "ssh2"],
  outputFileTracingIncludes: {
    "/api/**": [
      "./skills/**/*",
      // browser-relay-server.js + systemd unit file are read at runtime by
      // configureOpenClaw (lib/ssh.ts) so the reconciler can deploy them
      // to each VM. Without this include, Next's tracing skips the subtree
      // and fs.existsSync returns false in production → silent skip → relay
      // never deploys fleet-wide.
      "./scripts/browser-relay-server/**/*",
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
      // working `./skills/**/*` and `./scripts/browser-relay-server/**/*`
      // both point at directories with nested file structure. The matchpool
      // .py files live directly in `instaclaw/scripts/` (no subdir) so
      // every `**`-style glob misses them. Pair with a top-level `*.py`
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
