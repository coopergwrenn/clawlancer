"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Wallet,
  Shield,
  CreditCard,
  ExternalLink,
  LogOut,
  Coins,
  ChevronRight,
  Link2,
  Mail,
  Check,
  Zap,
} from "lucide-react";
import GoogleConnectCard from "@/components/google-connect-card";
import type { SubscriptionInfo } from "@/lib/supabase";

function LinkAccountSection() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleRedeem() {
    if (code.length < 8) return;
    setStatus("loading");
    setErrorMsg("");
    try {
      const res = await fetch("/api/link/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus("success");
        setTimeout(() => router.refresh(), 1000);
      } else {
        setStatus("error");
        setErrorMsg(data.error || "Invalid code");
      }
    } catch {
      setStatus("error");
      setErrorMsg("Failed to redeem code");
    }
  }

  if (status === "success") {
    return (
      <section className="animate-fade-in-up glass-card rounded-2xl border-success/20 p-4 stagger-4" style={{ opacity: 0 }}>
        <div className="flex items-center gap-2 text-success">
          <Shield size={16} />
          <span className="text-sm font-semibold">Account linked successfully!</span>
        </div>
      </section>
    );
  }

  return (
    <section className="animate-fade-in-up glass-card rounded-2xl p-4 stagger-4" style={{ opacity: 0 }}>
      <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted">
        Link instaclaw.io Account
      </h2>
      <p className="mb-3 text-xs text-muted">
        Have an existing InstaClaw account? Get a linking code from
        instaclaw.io → Settings → Connect World Wallet, then enter it here.
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="XXXX XXXX"
          maxLength={8}
          className="flex-1 rounded-xl border border-border bg-white/[0.04] px-3 py-2.5 text-center font-mono text-sm tracking-[0.2em] placeholder:text-muted/40 focus:border-accent focus:outline-none"
        />
        <button
          onClick={handleRedeem}
          disabled={code.length < 8 || status === "loading"}
          className="btn-primary rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-40"
        >
          {status === "loading" ? "..." : "Link"}
        </button>
      </div>
      {status === "error" && (
        <p className="mt-2 text-xs text-error">{errorMsg}</p>
      )}
    </section>
  );
}

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
  gmailConnected: initialGmailConnected,
  subscription,
}: {
  walletAddress: string;
  agent: { credit_balance: number; default_model?: string; [key: string]: unknown } | null;
  delegations: Delegation[];
  payments: Payment[];
  gmailConnected: boolean;
  subscription: SubscriptionInfo;
}) {
  const router = useRouter();
  const [gmailConnected, setGmailConnected] = useState(initialGmailConnected);

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

      {/* ── Connected Accounts ── */}
      <section className="animate-fade-in-up glass-card rounded-2xl p-4 stagger-1" style={{ opacity: 0 }}>
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted">
          Connected Accounts
        </h2>

        {gmailConnected ? (
          <div>
            <div className="flex items-center gap-3 rounded-xl bg-success/[0.06] p-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-success/10">
                <Mail size={16} className="text-success" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium">Google</p>
                <p className="text-[10px] text-success/70">Connected</p>
              </div>
              <Check size={16} className="text-success" />
            </div>
            <button
              onClick={async () => {
                if (!confirm("Disconnect Google? Your agent will lose personalized context.")) return;
                try {
                  const res = await fetch("/api/google/disconnect", { method: "POST" });
                  if (res.ok) {
                    setGmailConnected(false);
                    router.refresh();
                  }
                } catch {}
              }}
              className="mt-2 w-full text-center text-[11px] py-2 text-muted transition-colors hover:text-error"
            >
              Disconnect Google
            </button>
          </div>
        ) : (
          <GoogleConnectCard
            variant="settings"
            onConnectStart={() => {
              // Poll when user returns
              const interval = setInterval(async () => {
                try {
                  const res = await fetch("/api/google/status");
                  if (res.ok) {
                    const data = await res.json();
                    if (data.connected) {
                      setGmailConnected(true);
                      clearInterval(interval);
                    }
                  }
                } catch {}
              }, 3000);
              // Stop polling after 5 minutes
              setTimeout(() => clearInterval(interval), 300000);
            }}
            onDismiss={() => {}}
          />
        )}
      </section>

      {/* ── Subscription / Credits ── */}
      <section className="animate-fade-in-up glass-card rounded-2xl p-4 stagger-1" style={{ opacity: 0 }}>
        {subscription.hasSubscription ? (
          <>
            <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted">
              Subscription
            </h2>
            <div className="mb-3 flex items-center gap-3 rounded-xl bg-accent/[0.06] p-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/10">
                <Zap size={16} className="text-accent" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold capitalize">{subscription.tier} plan</p>
                <p className="text-[10px] text-muted">
                  {subscription.dailyLimit} daily credits — resets at midnight
                </p>
              </div>
            </div>
            <div className="mb-3 flex items-end justify-between">
              <div>
                <p className="text-[10px] text-muted mb-0.5">Daily usage</p>
                <p className="text-xl font-bold">{Math.round(subscription.dailyUsed)} <span className="text-sm text-muted font-normal">/ {subscription.dailyLimit}</span></p>
              </div>
              <div className="text-right">
                <p className="text-[10px] text-muted mb-0.5">Overflow credits</p>
                <p className="text-xl font-bold">{agent?.credit_balance ?? 0}</p>
              </div>
            </div>
            {subscription.currentPeriodEnd && (
              <p className="text-[10px] text-muted mb-3">
                Renews {new Date(subscription.currentPeriodEnd).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </p>
            )}
            <button
              onClick={async () => {
                try {
                  const res = await fetch("/api/subscription/checkout-url?tier=starter");
                  const data = await res.json();
                  if (data.url) window.open(data.url, "_blank");
                } catch {
                  window.open("https://instaclaw.io/upgrade?from=mini-app", "_blank");
                }
              }}
              className="glass-button flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-semibold"
            >
              Manage Subscription <ExternalLink size={11} />
            </button>
          </>
        ) : (
          <>
            <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted">
              Credits
            </h2>
            <div className="mb-4 flex items-end justify-between">
              <div>
                <p className="text-3xl font-bold">{agent?.credit_balance ?? 0}</p>
                <p className="text-[10px] text-muted">Current balance</p>
              </div>
              <p className="text-xs text-muted">{agent?.default_model ?? "—"}</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => router.push("/home")}
                className="btn-wld flex-1 rounded-xl py-2.5 text-sm font-bold"
              >
                Pay with WLD
              </button>
              <button
                onClick={async () => {
                try {
                  const res = await fetch("/api/subscription/checkout-url?tier=starter");
                  const data = await res.json();
                  if (data.url) window.open(data.url, "_blank");
                } catch {
                  window.open("https://instaclaw.io/upgrade?from=mini-app", "_blank");
                }
              }}
                className="glass-button flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-semibold"
              >
                Subscribe <ExternalLink size={11} />
              </button>
            </div>
          </>
        )}
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

      {/* ── Link Account ── */}
      <LinkAccountSection />

      {/* ── Debug — temporary ── */}
      <section className="animate-fade-in-up glass-card rounded-2xl p-4 stagger-4" style={{ opacity: 0, border: "1px solid rgba(220,103,67,0.3)" }}>
        <button
          onClick={() => router.push("/test-deeplinks")}
          className="btn-primary w-full rounded-xl py-3 text-sm font-semibold"
        >
          Test World Chat Deep Links
        </button>
        <p className="mt-2 text-[10px] text-center text-muted">Temporary — for debugging with World team</p>
      </section>

      {/* ── Links ── */}
      <section className="animate-fade-in-up glass-card rounded-2xl p-4 stagger-4" style={{ opacity: 0 }}>
        <h2 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted">
          More
        </h2>
        <button
          onClick={() => window.open("https://instaclaw.io", "_blank")}
          className="flex w-full items-center justify-between rounded-lg px-1 py-3 text-sm transition-colors hover:bg-white/[0.03]"
        >
          <span>Visit instaclaw.io</span>
          <ChevronRight size={14} className="text-muted" />
        </button>
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
