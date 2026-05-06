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
      // 2026-05-05: switched from individual file paths to a **/* glob.
      // Individual file entries ("./scripts/consensus_match_pipeline.py") and
      // mid-name wildcards ("./scripts/consensus_*.py") were both silently
      // dropped by Next 15's tracer — every cv=82 VM that survived long
      // enough to reach stepFiles hit `ENOENT '/ROOT/instaclaw/scripts/
      // consensus_match_pipeline.py'` and pushFailed → cv held. Hidden under
      // the reconcile-fleet 300s timeout until the batch=10→3 fix landed.
      // The only shape that works in this codebase is `<dir>/**/*` (see the
      // working `./skills/**/*` and `./scripts/browser-relay-server/**/*`
      // entries above). Use the same shape here.
      "./scripts/**/*.py",
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
