"use client";

import { useRouter } from "next/navigation";
import {
  Wallet,
  Shield,
  CreditCard,
  ExternalLink,
  LogOut,
  Coins,
} from "lucide-react";

interface Delegation {
  id: string;
  amount_wld: number;
  credits_granted: number;
  status: string;
  delegated_at: string;
}

interface Payment {
  id: string;
  pack: string;
  credits: number;
  amount_usdc: number;
  status: string;
  created_at: string;
}

export default function SettingsClient({
  walletAddress,
  agent,
  delegations,
  payments,
}: {
  walletAddress: string;
  agent: { credit_balance: number; model: string } | null;
  delegations: Delegation[];
  payments: Payment[];
}) {
  const router = useRouter();

  async function handleSignOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/");
  }

  return (
    <div className="flex flex-col gap-4 p-4 pb-8">
      <h1 className="text-xl font-bold">Settings</h1>

      {/* Account */}
      <section className="rounded-2xl border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold text-muted">Account</h2>
        <div className="flex items-center gap-3">
          <Wallet size={16} className="text-muted" />
          <span className="text-sm font-mono">
            {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
          </span>
        </div>
        {agent && (
          <div className="mt-2 flex items-center gap-3">
            <Shield size={16} className="text-success" />
            <span className="text-sm">World ID Verified</span>
          </div>
        )}
      </section>

      {/* Credits */}
      <section className="rounded-2xl border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold text-muted">Credits</h2>
        <p className="text-2xl font-bold">{agent?.credit_balance ?? 0}</p>
        <p className="mb-3 text-xs text-muted">Current balance</p>
        <div className="flex gap-2">
          <button
            onClick={() => router.push("/home")}
            className="flex-1 rounded-xl bg-wld py-2.5 text-sm font-bold text-black"
          >
            Stake WLD
          </button>
          <button
            onClick={() =>
              window.open("https://instaclaw.io/billing", "_blank")
            }
            className="flex flex-1 items-center justify-center gap-1 rounded-xl border border-border py-2.5 text-sm font-semibold"
          >
            Subscribe <ExternalLink size={12} />
          </button>
        </div>
      </section>

      {/* WLD Delegation History */}
      {delegations.length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold text-muted">
            WLD Delegations
          </h2>
          <div className="flex flex-col gap-2">
            {delegations.slice(0, 5).map((d) => (
              <div
                key={d.id}
                className="flex items-center justify-between text-sm"
              >
                <div className="flex items-center gap-2">
                  <Coins size={14} className="text-wld" />
                  <span>{d.amount_wld} WLD</span>
                </div>
                <span className="text-xs text-muted">
                  +{d.credits_granted} credits
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Payment History */}
      {payments.length > 0 && (
        <section className="rounded-2xl border border-border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold text-muted">
            Credit Purchases
          </h2>
          <div className="flex flex-col gap-2">
            {payments.slice(0, 5).map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between text-sm"
              >
                <div className="flex items-center gap-2">
                  <CreditCard size={14} className="text-usdc" />
                  <span>${p.amount_usdc} USDC</span>
                </div>
                <span className="text-xs text-muted">
                  +{p.credits} credits
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Links */}
      <section className="rounded-2xl border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-semibold text-muted">More</h2>
        <button
          onClick={() =>
            window.open("https://instaclaw.io/dashboard", "_blank")
          }
          className="flex w-full items-center justify-between py-2 text-sm"
        >
          <span>Full dashboard on instaclaw.io</span>
          <ExternalLink size={14} className="text-muted" />
        </button>
        <button
          onClick={() =>
            window.open("https://instaclaw.io/settings", "_blank")
          }
          className="flex w-full items-center justify-between py-2 text-sm"
        >
          <span>Link existing InstaClaw account</span>
          <ExternalLink size={14} className="text-muted" />
        </button>
      </section>

      {/* Sign out */}
      <button
        onClick={handleSignOut}
        className="flex items-center justify-center gap-2 rounded-2xl border border-border py-3 text-sm font-medium text-error"
      >
        <LogOut size={16} />
        Sign out
      </button>
    </div>
  );
}
