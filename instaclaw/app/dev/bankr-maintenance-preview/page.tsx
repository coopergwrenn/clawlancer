"use client";

/**
 * Dev preview for the Bankr maintenance UI.
 *
 * Renders the three variants of <BankrMaintenanceNotice /> side-by-side
 * (card + inline + banner) plus the two affected dashboard components
 * (BankrWalletCard + AgentWalletFundingCard) in both NORMAL and
 * MAINTENANCE states with mocked props.
 *
 * Why this exists: the dashboard cards are gated behind NextAuth, so
 * screenshotting the actual user-facing UI requires either a real
 * session cookie or a mocked auth surface. This page bypasses that —
 * it renders the components directly with fixture data so the design
 * can be reviewed without authenticating.
 *
 * Path: /dev/bankr-maintenance-preview (no auth required; under
 * top-level /dev/ outside any route group). Delete this directory
 * once the maintenance window is over.
 */

import { BankrMaintenanceNotice } from "@/components/dashboard/bankr-maintenance-notice";
import { BankrWalletCard } from "@/components/dashboard/bankr-wallet-card";
import { AgentWalletFundingCard } from "@/components/dashboard/agent-wallet-funding-card";

const MOCK_EVM = "0x742d35Cc6634C0532925a3b8D5c9E6B1f9C5C8a7";

export default function BankrMaintenancePreviewPage() {
  // Force light-mode CSS variables locally so screenshots match what users
  // see on the dashboard (dark text on cream). Without these, the page
  // inherits root --foreground which may evaluate to white in dark mode.
  const lightVars = {
    "--foreground": "#1a1714",
    "--muted": "#6b6660",
    "--border": "rgba(0,0,0,0.10)",
    color: "#1a1714",
    background: "#faf8f5",
  } as React.CSSProperties;
  return (
    <div className="min-h-screen p-8" style={lightVars}>
      <div className="max-w-7xl mx-auto space-y-12">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Bankr maintenance UI — dev preview</h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Three variants of the notice + two affected dashboard cards in both
            normal and maintenance states. Cooper review surface — not linked from
            navigation. Delete after maintenance window ends.
          </p>
        </header>

        {/* ────── Section 1: Notice variants ────── */}
        <section className="space-y-4">
          <h2 className="text-lg font-medium">Notice variants</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                Variant: card (replaces Tokenize CTA on dashboard)
              </p>
              <BankrMaintenanceNotice variant="card" />
            </div>
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                Variant: inline (inside AgentWalletFundingCard)
              </p>
              <BankrMaintenanceNotice variant="inline" />
            </div>
            <div className="space-y-2 md:col-span-2">
              <p className="text-xs uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                Variant: banner (above-fold pill on marketing /token)
              </p>
              <div>
                <BankrMaintenanceNotice variant="banner" />
              </div>
            </div>
          </div>
        </section>

        {/* ────── Section 2: BankrWalletCard before/after ────── */}
        <section className="space-y-4">
          <h2 className="text-lg font-medium">BankrWalletCard — pre-launch state</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                BEFORE (maintenance OFF) — normal tokenize CTA
              </p>
              <BankrWalletCard
                walletId="wallet_mock_123"
                evmAddress={MOCK_EVM}
                tokenAddress={null}
                tokenSymbol={null}
                tokenImageUrl={null}
                tokenizationPlatform={null}
                agentName="testagent"
                freshLaunch={null}
                worldIdVerified={false}
                bankrMaintenance={false}
              />
            </div>
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                AFTER (maintenance ON) — graceful pause
              </p>
              <BankrWalletCard
                walletId="wallet_mock_123"
                evmAddress={MOCK_EVM}
                tokenAddress={null}
                tokenSymbol={null}
                tokenImageUrl={null}
                tokenizationPlatform={null}
                agentName="testagent"
                freshLaunch={null}
                worldIdVerified={false}
                bankrMaintenance={true}
              />
            </div>
          </div>
        </section>

        {/* ────── Section 2b: BankrWalletCard NO-WALLET state ──────
            The shelpinc/vm-1019 bug-fix case: when walletId AND evmAddress
            are both null + maintenance is ON, show the no-wallet maintenance
            card explaining provisioning will resume. Pre-fix this returned
            null (invisible). */}
        <section className="space-y-4">
          <h2 className="text-lg font-medium">BankrWalletCard — no-wallet (unprovisioned) state</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                BEFORE FIX (maintenance ON, no wallet) — returned null, card was invisible
              </p>
              <div
                className="rounded-xl p-5"
                style={{ border: "1px dashed var(--border)", color: "var(--muted)" }}
              >
                (component returned null — user saw nothing here)
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                AFTER FIX (maintenance ON, no wallet) — explains provisioning
              </p>
              <BankrWalletCard
                walletId={null}
                evmAddress={null}
                tokenAddress={null}
                tokenSymbol={null}
                tokenImageUrl={null}
                tokenizationPlatform={null}
                agentName="testagent"
                freshLaunch={null}
                worldIdVerified={false}
                bankrMaintenance={true}
              />
            </div>
          </div>
        </section>

        {/* ────── Section 3: AgentWalletFundingCard before/after ────── */}
        <section className="space-y-4">
          <h2 className="text-lg font-medium">AgentWalletFundingCard</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                BEFORE (maintenance OFF)
              </p>
              <AgentWalletFundingCard evmAddress={MOCK_EVM} bankrMaintenance={false} />
            </div>
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                AFTER (maintenance ON)
              </p>
              <AgentWalletFundingCard evmAddress={MOCK_EVM} bankrMaintenance={true} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
