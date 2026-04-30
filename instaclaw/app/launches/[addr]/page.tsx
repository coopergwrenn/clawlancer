/**
 * Public landing page for a tokenized agent.
 *
 * Two purposes:
 *   1. Twitter unfurls this URL → next.js auto-wires the colocated
 *      opengraph-image.tsx as the og:image, producing the InstaClaw-
 *      branded share card (item #5).
 *   2. Humans who click the link land on a minimal celebration page
 *      with CTAs to the chart, Bankr launch page, and Basescan.
 *
 * We DO NOT gate this page behind auth — it's a public marketing surface
 * for the launched token.
 */

import { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSupabase } from "@/lib/supabase";

// 1 hour ISR cache. The underlying VM row's mutable fields (agent_name,
// bankr_token_image_url) change rarely, but we want a rename or PFP regen
// to propagate same-day. Pair with the OG image's matching 1h cache.
export const revalidate = 3600;

interface Props {
  params: Promise<{ addr: string }>;
}

interface TokenRow {
  bankr_token_symbol: string | null;
  bankr_token_image_url: string | null;
  bankr_token_launched_at: string | null;
  agent_name: string | null;
  telegram_bot_username: string | null;
}

function isValidEvmAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s);
}

function cleanAgentName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let name = raw.trim();
  if (name.startsWith("@")) name = name.slice(1);
  name = name.replace(/[_-]?bot$/i, "");
  name = name.replace(/[\r\n\t]+/g, " ").replace(/[_-]+/g, " ");
  name = name.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  return name.length >= 2 ? name : null;
}

async function loadToken(addr: string): Promise<TokenRow | null> {
  try {
    const { data } = await getSupabase()
      .from("instaclaw_vms")
      .select(
        "bankr_token_symbol, bankr_token_image_url, bankr_token_launched_at, agent_name, telegram_bot_username"
      )
      .ilike("bankr_token_address", addr)
      .maybeSingle();
    return (data as TokenRow | null) ?? null;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { addr } = await params;
  if (!isValidEvmAddress(addr)) return { title: "InstaClaw — Token Not Found" };

  const row = await loadToken(addr.toLowerCase());
  const ticker = (row?.bankr_token_symbol ?? "").toUpperCase() || "TOKEN";
  const agentName =
    cleanAgentName(row?.agent_name) ?? cleanAgentName(row?.telegram_bot_username) ?? "an autonomous AI agent";
  const title = `$${ticker} — autonomous AI agent on Base`;
  const description = `${agentName} just launched $${ticker} on Base. Self-funding from day one — trading fees flow back to the agent's wallet. Powered by InstaClaw + Bankr.`;
  const url = `https://instaclaw.io/launches/${addr.toLowerCase()}`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url,
      siteName: "InstaClaw",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
    alternates: { canonical: url },
  };
}

export default async function LaunchPage({ params }: Props) {
  const { addr } = await params;
  if (!isValidEvmAddress(addr)) notFound();
  const lowerAddr = addr.toLowerCase();

  const row = await loadToken(lowerAddr);
  const ticker = (row?.bankr_token_symbol ?? "").toUpperCase() || "TOKEN";
  const agentName =
    cleanAgentName(row?.agent_name) ?? cleanAgentName(row?.telegram_bot_username);
  const launchedAt = row?.bankr_token_launched_at;
  const imageUrl = row?.bankr_token_image_url;
  const initials = ticker.slice(0, 3);

  const dexscreener = `https://dexscreener.com/base/${lowerAddr}`;
  const bankrUrl = `https://bankr.bot/launches/${lowerAddr}`;
  const basescan = `https://basescan.org/token/${lowerAddr}`;

  return (
    <main className="min-h-screen bg-black text-white px-6 py-16 flex items-center justify-center">
      <div className="w-full max-w-xl mx-auto">
        <div className="flex items-center gap-3 mb-10 justify-center">
          <Link href="/" className="flex items-center gap-2 opacity-80 hover:opacity-100">
            <span
              className="w-8 h-8 rounded-md flex items-center justify-center text-sm font-bold"
              style={{ background: "#DC6743" }}
            >
              IC
            </span>
            <span className="text-sm tracking-wide">InstaClaw</span>
          </Link>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-8 flex flex-col items-center text-center">
          {imageUrl ? (
            // Use a plain img — Next.js Image isn't worth the config here
            // and we want zero next.config domain churn.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt={`${ticker} token logo`}
              width={144}
              height={144}
              className="rounded-2xl border border-white/10 object-cover"
            />
          ) : (
            <div
              className="w-36 h-36 rounded-2xl flex items-center justify-center text-4xl font-extrabold border border-white/10"
              style={{ background: "linear-gradient(135deg, #DC6743, #8a3a1f)" }}
            >
              {initials}
            </div>
          )}

          <h1 className="mt-6 text-5xl font-extrabold tracking-tight">${ticker}</h1>
          <p className="mt-3 text-white/60">
            deployed by <span className="text-white font-semibold">{agentName ?? "an autonomous AI agent"}</span>
          </p>
          <p className="mt-1 text-white/40 text-sm">on Base mainnet</p>

          <code className="mt-5 text-xs font-mono px-3 py-1.5 rounded bg-white/5 border border-white/10 break-all">
            {lowerAddr}
          </code>

          {launchedAt && (
            <p className="mt-4 text-xs text-white/40">
              launched {new Date(launchedAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </p>
          )}

          <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-2 w-full">
            <a
              href={bankrUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg py-2.5 px-3 text-sm font-semibold bg-white text-black hover:bg-white/90 transition"
            >
              Buy on Bankr
            </a>
            <a
              href={dexscreener}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg py-2.5 px-3 text-sm font-medium border border-white/15 hover:bg-white/5 transition"
            >
              View chart
            </a>
            <a
              href={basescan}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg py-2.5 px-3 text-sm font-medium border border-white/15 hover:bg-white/5 transition"
            >
              Basescan
            </a>
          </div>
        </div>

        <p className="mt-8 text-center text-sm text-white/50">
          Self-funding from day one — trading fees flow back to the agent&rsquo;s wallet to fund its own compute.
        </p>
        <p className="mt-2 text-center text-xs text-white/35">
          Tokenized via{" "}
          <a href="https://bankr.bot" target="_blank" rel="noopener noreferrer" className="underline hover:text-white/60">
            Bankr
          </a>
          {" · "}
          Deploy your own agent at{" "}
          <Link href="/" className="underline hover:text-white/60">
            instaclaw.io
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
