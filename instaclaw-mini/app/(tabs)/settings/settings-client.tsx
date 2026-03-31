"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { MiniKit, Tokens } from "@worldcoin/minikit-js";
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
  Archive,
  RotateCw,
  ChevronDown,
} from "lucide-react";
import GoogleConnectCard from "@/components/google-connect-card";
import type { SubscriptionInfo } from "@/lib/supabase";

function ArchivedTasksSection() {
  const [open, setOpen] = useState(false);
  const [tasks, setArchivedTasks] = useState<{ id: string; title: string; description: string; archived_at: string }[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch("/api/tasks/list?archived=true&limit=50")
      .then((r) => r.json())
      .then((d) => setArchivedTasks(d.tasks || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open]);

  async function unarchive(taskId: string) {
    try {
      await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archive: false }),
      });
      setArchivedTasks((prev) => prev.filter((t) => t.id !== taskId));
    } catch {}
  }

  return (
    <section className="animate-fade-in-up glass-card rounded-2xl p-4 stagger-4" style={{ opacity: 0 }}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between"
      >
        <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted">
          Archived Tasks
        </h2>
        <ChevronDown
          size={14}
          className="text-muted transition-transform duration-300"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0)" }}
        />
      </button>

      <div
        style={{
          maxHeight: open ? "500px" : "0",
          opacity: open ? 1 : 0,
          overflow: "hidden",
          transition: "max-height 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.25s ease",
        }}
      >
        {loading ? (
          <div className="py-4 flex justify-center">
            <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "rgba(255,255,255,0.1)", borderTopColor: "transparent" }} />
          </div>
        ) : tasks.length === 0 ? (
          <p className="text-xs text-muted py-3">No archived tasks.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {tasks.map((task) => (
              <div key={task.id} className="flex items-center gap-3 rounded-lg bg-white/[0.02] px-3 py-2.5">
                <Archive size={14} className="shrink-0 text-muted" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{task.title}</p>
                  <p className="text-[10px] text-muted truncate">{task.description}</p>
                </div>
                <button
                  onClick={() => unarchive(task.id)}
                  className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium"
                  style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)", color: "#999" }}
                >
                  <RotateCw size={10} /> Restore
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

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

      {/* Upsell for users without an instaclaw.io account */}
      <div className="mt-4 pt-3" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <p className="text-xs text-muted mb-1.5">
          Don&apos;t have an instaclaw.io subscription?
        </p>
        <p className="text-[10px] text-muted mb-2.5" style={{ color: "#666" }}>
          Unlock your full web dashboard, daily credits, Telegram access, and advanced skill configuration.
        </p>
        <button
          onClick={() => { window.location.href = "https://instaclaw.io/upgrade?from=mini-app"; }}
          className="w-full flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-[12px] font-semibold transition-all"
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            color: "#ccc",
          }}
        >
          Sign up on instaclaw.io
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
      </div>
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

  const [paying, setPaying] = useState(false);

  const [showSignOutConfirm, setShowSignOutConfirm] = useState(false);
  const [syncingWorldId, setSyncingWorldId] = useState(false);
  const [worldIdSynced, setWorldIdSynced] = useState(false);

  async function handleSyncWorldId() {
    setSyncingWorldId(true);
    try {
      const res = await fetch("/api/proxy/world-id/propagate", { method: "POST" });
      const data = await res.json();
      if (data.propagated) setWorldIdSynced(true);
    } catch {}
    setSyncingWorldId(false);
  }

  async function handleSignOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/");
  }

  async function handleAddCredits() {
    if (paying) return;
    setPaying(true);
    MiniKit.commands.sendHapticFeedback({ hapticsType: "impact", style: "medium" });
    try {
      const res = await fetch("/api/delegate/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: "try_it" }),
      });
      const { reference, tokenAmount } = await res.json();
      const recipientAddress = process.env.NEXT_PUBLIC_RECIPIENT_ADDRESS?.trim();
      if (!recipientAddress) { setPaying(false); return; }

      const payResult = await MiniKit.commandsAsync.pay({
        reference,
        to: recipientAddress,
        tokens: [{ symbol: Tokens.WLD, token_amount: tokenAmount }],
        description: "Add credits to your InstaClaw agent",
      });

      if (payResult.finalPayload.status === "success") {
        await fetch("/api/delegate/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reference,
            transactionId: (payResult.finalPayload as Record<string, unknown>).transaction_id,
          }),
        });
        router.refresh();
      }
    } catch (err) {
      console.error("Payment error:", err);
    }
    setPaying(false);
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
            <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="#999" xmlns="http://www.w3.org/2000/svg">
              <path d="M18.1167 1.60446C16.2783 0.53482 14.2727 0 12.1 0C9.92731 0 7.92173 0.53482 6.08329 1.60446C4.24485 2.6741 2.7741 4.14485 1.70446 5.98329C0.634826 7.82173 0.100006 9.8273 0.100006 12C0.100006 14.1727 0.634826 16.1783 1.70446 18.0167C2.7741 19.8552 4.24485 21.3259 6.08329 22.3955C7.92173 23.4652 9.92731 24 12.1 24C14.2727 24 16.2783 23.4652 18.1167 22.3955C19.9552 21.3259 21.4259 19.8552 22.4956 18.0167C23.5652 16.1783 24.1 14.1727 24.1 12C24.1 9.8273 23.5652 7.82173 22.4956 5.98329C21.4259 4.14485 19.9552 2.6741 18.1167 1.60446ZM12.8354 16.3454C11.4649 16.3454 10.3953 15.9443 9.55962 15.1755C8.99137 14.6407 8.62369 14.0056 8.45656 13.2368H21.4259C21.2922 14.3398 20.958 15.376 20.49 16.3454H12.8688H12.8354ZM8.45656 10.7967C8.62369 10.0613 8.99137 9.39276 9.55962 8.85794C10.3953 8.08914 11.4649 7.68802 12.8354 7.68802H20.49C20.9914 8.65738 21.2922 9.6936 21.4259 10.7967H8.45656ZM3.97744 7.22006C4.8131 5.78273 5.94959 4.61282 7.38691 3.77716C8.82424 2.94151 10.3953 2.50696 12.1334 2.50696C13.8716 2.50696 15.4426 2.94151 16.88 3.77716C17.6153 4.2117 18.2504 4.71309 18.8521 5.31476H12.802C11.4315 5.31476 10.1947 5.6156 9.12508 6.18385C8.05544 6.75209 7.21978 7.55432 6.65154 8.55711C6.25042 9.25906 5.98302 10.0279 5.84931 10.8301H2.87438C3.00809 9.55989 3.4092 8.35655 4.0443 7.25348L3.97744 7.22006ZM16.8465 20.2228C15.4092 21.0585 13.8382 21.493 12.1 21.493C10.3618 21.493 8.79082 21.0585 7.35349 20.2228C5.91616 19.3872 4.77967 18.2173 3.94402 16.78C3.30892 15.6769 2.90781 14.507 2.7741 13.2368H5.74903C5.88274 14.039 6.15014 14.8078 6.55126 15.5097C7.15293 16.5125 7.98859 17.2813 9.0248 17.883C10.0944 18.4513 11.3312 18.7521 12.7017 18.7521H18.7184C18.1501 19.3203 17.5151 19.8217 16.8131 20.2228H16.8465Z" />
            </svg>
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
            <div className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background: "rgba(0,92,255,0.12)" }}>
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="10" fill="#005CFF"/>
                <path d="M17.3711 10.9277L13 12.6758V17.999H11V12.6758L6.62891 10.9277L7.37109 9.07031L12 10.9219L16.6289 9.07031L17.3711 10.9277Z" fill="white"/>
                <path d="M12.0389 9.31641C12.7293 9.31641 13.2891 8.75676 13.2891 8.0664C13.2891 7.37605 12.7293 6.81641 12.0389 6.81641C11.3484 6.81641 10.7887 7.37605 10.7887 8.0664C10.7887 8.75676 11.3484 9.31641 12.0389 9.31641Z" fill="white"/>
              </svg>
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium">World ID Verified</p>
              <p className="text-[10px] text-success/70">Orb verification</p>
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
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
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                  <path d="M5.84 14.09A6.97 6.97 0 0 1 5.47 12c0-.72.13-1.43.37-2.09V7.07H2.18A11.96 11.96 0 0 0 .96 12c0 1.94.46 3.77 1.22 5.33l3.66-2.84z" fill="#FBBC05"/>
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.09 14.97 0 12 0 7.7 0 3.99 2.47 2.18 6.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                </svg>
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
            <div className="flex gap-2">
              <button
                onClick={handleAddCredits}
                disabled={paying}
                className="btn-primary flex-1 flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-bold disabled:opacity-50"
              >
                <Zap size={14} fill="currentColor" /> {paying ? "Processing..." : "Top up with WLD"}
              </button>
              <button
                onClick={() => {
                  // Opens instaclaw.io billing in Chrome — user manages subscription there
                  window.location.href = "https://instaclaw.io/billing?from=mini-app";
                }}
                className="glass-button flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-semibold"
              >
                Manage <ExternalLink size={11} />
              </button>
            </div>
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
                onClick={handleAddCredits}
                disabled={paying}
                className="btn-primary flex-1 rounded-xl py-2.5 text-sm font-bold disabled:opacity-50"
              >
                {paying ? "Processing..." : "Pay with WLD"}
              </button>
              <button
                onClick={() => {
                  window.location.href = "https://instaclaw.io/upgrade?from=mini-app";
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
                  <Coins size={14} style={{ color: "#da7756" }} />
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

      {/* ── Archived Tasks ── */}
      <ArchivedTasksSection />

      {/* ── Debug — temporary ── */}
      <section className="animate-fade-in-up glass-card rounded-2xl p-4 stagger-4" style={{ opacity: 0, border: "1px solid rgba(218,119,86,0.3)" }}>
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
          onClick={() => { window.location.href = "https://instaclaw.io"; }}
          className="flex w-full items-center justify-between rounded-lg px-1 py-3 text-sm transition-colors hover:bg-white/[0.03]"
        >
          <span>Visit instaclaw.io</span>
          <ChevronRight size={14} className="text-muted" />
        </button>
      </section>

      {/* ── Sign Out ── */}
      {showSignOutConfirm ? (
        <div className="animate-fade-in-up glass-card rounded-2xl p-4 stagger-5" style={{ opacity: 0, border: "1px solid rgba(239,68,68,0.25)" }}>
          <p className="text-sm font-medium text-center mb-3">Are you sure you want to sign out?</p>
          <div className="flex gap-2">
            <button
              onClick={() => setShowSignOutConfirm(false)}
              className="flex-1 glass-button rounded-xl py-2.5 text-sm font-medium"
            >
              Cancel
            </button>
            <button
              onClick={handleSignOut}
              className="flex-1 flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold text-white"
              style={{ background: "rgba(239,68,68,0.8)", boxShadow: "0 2px 8px rgba(239,68,68,0.3)" }}
            >
              <LogOut size={14} />
              Sign Out
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowSignOutConfirm(true)}
          className="animate-fade-in-up flex items-center justify-center gap-2 rounded-2xl py-3.5 text-sm font-medium stagger-5"
          style={{ opacity: 0, color: "#ef4444", background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.15)" }}
        >
          <LogOut size={16} />
          Sign Out
        </button>
      )}
    </div>
  );
}
