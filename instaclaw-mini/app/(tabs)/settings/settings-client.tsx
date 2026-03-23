"use client";

import { useRouter } from "next/navigation";
import {
  Wallet,
  Shield,
  CreditCard,
  ExternalLink,
  LogOut,
  Coins,
  ChevronRight,
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
      <h1 className="mb-1 text-xl font-bold tracking-tight">Settings</h1>

      {/* ── Account ── */}
      <section className="animate-fade-in-up glass-card rounded-2xl p-4" style={{ opacity: 0 }}>
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted">
          Account
        </h2>
        <div className="flex items-center gap-3 rounded-xl bg-white/[0.03] p-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06]">
            <Wallet size={16} className="text-muted" />
          </div>
          <div className="flex-1">
            <p className="font-mono text-sm">
              {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
            </p>
            <p className="text-[10px] text-muted">World Wallet</p>
          </div>
        </div>
        {agent && (
          <div className="mt-2 flex items-center gap-3 rounded-xl bg-success/[0.06] p-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-success/10">
              <Shield size={16} className="text-success" />
            </div>
            <div>
              <p className="text-sm font-medium">World ID Verified</p>
              <p className="text-[10px] text-success/70">Orb verification</p>
            </div>
          </div>
        )}
      </section>

      {/* ── Credits ── */}
      <section className="animate-fade-in-up glass-card rounded-2xl p-4 stagger-1" style={{ opacity: 0 }}>
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted">
          Credits
        </h2>
        <div className="mb-4 flex items-end justify-between">
          <div>
            <p className="text-3xl font-bold">{agent?.credit_balance ?? 0}</p>
            <p className="text-[10px] text-muted">Current balance</p>
          </div>
          <p className="text-xs text-muted">{agent?.model ?? "—"}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => router.push("/home")}
            className="btn-wld flex-1 rounded-xl py-2.5 text-sm font-bold"
          >
            Stake WLD
          </button>
          <button
            onClick={() => window.open("https://instaclaw.io/billing", "_blank")}
            className="glass-button flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-semibold"
          >
            Subscribe <ExternalLink size={11} />
          </button>
        </div>
      </section>

      {/* ── WLD Delegations ── */}
      {delegations.length > 0 && (
        <section className="animate-fade-in-up glass-card rounded-2xl p-4 stagger-2" style={{ opacity: 0 }}>
          <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted">
            WLD Delegations
          </h2>
          <div className="flex flex-col gap-2">
            {delegations.slice(0, 5).map((d) => (
              <div
                key={d.id}
                className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2"
              >
                <div className="flex items-center gap-2.5">
                  <Coins size={14} className="text-wld" />
                  <span className="text-sm font-medium">{d.amount_wld} WLD</span>
                </div>
                <span className="text-xs text-muted">+{d.credits_granted} credits</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Payments ── */}
      {payments.length > 0 && (
        <section className="animate-fade-in-up glass-card rounded-2xl p-4 stagger-3" style={{ opacity: 0 }}>
          <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted">
            Credit Purchases
          </h2>
          <div className="flex flex-col gap-2">
            {payments.slice(0, 5).map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-lg bg-white/[0.02] px-3 py-2"
              >
                <div className="flex items-center gap-2.5">
                  <CreditCard size={14} className="text-usdc" />
                  <span className="text-sm font-medium">${p.amount_usdc} USDC</span>
                </div>
                <span className="text-xs text-muted">+{p.credits} credits</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Links ── */}
      <section className="animate-fade-in-up glass-card rounded-2xl p-4 stagger-4" style={{ opacity: 0 }}>
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted">
          More
        </h2>
        {[
          { label: "Full dashboard", url: "https://instaclaw.io/dashboard" },
          { label: "Link existing account", url: "https://instaclaw.io/settings" },
        ].map(({ label, url }) => (
          <button
            key={label}
            onClick={() => window.open(url, "_blank")}
            className="flex w-full items-center justify-between rounded-lg px-1 py-3 text-sm transition-colors hover:bg-white/[0.03]"
          >
            <span>{label}</span>
            <ChevronRight size={14} className="text-muted" />
          </button>
        ))}
      </section>

      {/* ── Sign Out ── */}
      <button
        onClick={handleSignOut}
        className="animate-fade-in-up glass-card flex items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-medium text-error stagger-5"
        style={{ opacity: 0 }}
      >
        <LogOut size={16} />
        Sign out
      </button>
    </div>
  );
}
