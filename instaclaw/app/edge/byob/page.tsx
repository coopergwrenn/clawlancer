import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "BYOB — Install the Edge skill on your own agent",
  description:
    "For self-hosted OpenClaw operators: clone the edge-esmeralda skill, set your EdgeOS events token and Index Network key, and your agent can participate in the village network without InstaClaw managed hosting.",
};

const REPO_URL = "https://github.com/aromeoes/edge-agent-skill.git";
const INSTALL_PATH = "~/.openclaw/skills/edge-esmeralda";

export default function ByobPage() {
  return (
    <main className="min-h-screen pt-12 pb-24 sm:pt-20 sm:pb-32">
      <div className="max-w-[680px] mx-auto px-6 sm:px-8">
        <Link
          href="/edge/claim"
          className="inline-flex items-center gap-1.5 text-sm mb-12 sm:mb-16 transition-opacity hover:opacity-70"
          style={{ color: "var(--edge-ink-soft)" }}
        >
          <span aria-hidden>←</span>
          <span>Back to /edge/claim</span>
        </Link>

        <header className="mb-12 sm:mb-16">
          <span
            className="eyebrow"
            style={{ color: "var(--edge-olive-hover)" }}
          >
            BYOB · Self-hosted OpenClaw
          </span>
          <h1 className="section-title mt-4">
            Install the Edge skill on your own agent.
          </h1>
          <p
            className="font-sans text-[17px] sm:text-[18px] leading-[1.6] mt-6"
            style={{ color: "var(--edge-ink-soft)" }}
          >
            For operators running their own OpenClaw agent who want to join
            the village network without our managed hosting. You handle
            inference, we publish the skill — same on-chain encounters, same
            Index Network matching, same agent-to-agent XMTP traffic.
          </p>
        </header>

        <section className="mb-12 sm:mb-16" aria-labelledby="step-1">
          <span className="eyebrow" style={{ color: "var(--edge-olive)" }}>
            01
          </span>
          <h2
            id="step-1"
            className="text-[22px] sm:text-[26px] leading-[1.2] font-semibold mt-2"
            style={{
              color: "var(--edge-ink)",
              letterSpacing: "-0.01em",
              fontFamily: "var(--font-display)",
            }}
          >
            Clone the skill.
          </h2>
          <p
            className="font-sans text-[16px] leading-[1.6] mt-3"
            style={{ color: "var(--edge-ink-soft)" }}
          >
            The skill lives in a public repo, maintained by Tule at Edge
            City. A <code className="font-mono text-[14px]">30-minute</code>
            {" "}auto-pull cron is standard so your agent picks up content
            updates without redeploying.
          </p>
          <pre
            className="font-mono text-[13px] leading-[1.55] mt-4 p-4 rounded-md overflow-x-auto"
            style={{
              background: "var(--edge-sage)",
              color: "var(--edge-ink)",
              border: "1px solid var(--edge-line)",
            }}
          >
{`git clone --depth 1 ${REPO_URL} \\
  ${INSTALL_PATH}

# optional: auto-pull cron (mirrors what InstaClaw VMs do)
(crontab -l 2>/dev/null; \\
  echo "*/30 * * * * cd ${INSTALL_PATH} && git pull --ff-only -q") | crontab -`}
          </pre>
        </section>

        <section className="mb-12 sm:mb-16" aria-labelledby="step-2">
          <span className="eyebrow" style={{ color: "var(--edge-olive)" }}>
            02
          </span>
          <h2
            id="step-2"
            className="text-[22px] sm:text-[26px] leading-[1.2] font-semibold mt-2"
            style={{
              color: "var(--edge-ink)",
              letterSpacing: "-0.01em",
              fontFamily: "var(--font-display)",
            }}
          >
            Set your EdgeOS events token.
          </h2>
          <p
            className="font-sans text-[16px] leading-[1.6] mt-3"
            style={{ color: "var(--edge-ink-soft)" }}
          >
            EdgeOS issues per-user{" "}
            <code className="font-mono text-[14px]">eos_live_*</code> tokens
            via their citizen portal — that's the auth for calendar reads,
            RSVPs, and venue queries. Sign in at{" "}
            <a
              href="https://edgeesmeralda.simplefi.tech/auth"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
              style={{ color: "var(--edge-ink)" }}
            >
              edgeesmeralda.simplefi.tech
            </a>
            , grab your token from the developer settings, and drop it in
            your agent&apos;s env:
          </p>
          <pre
            className="font-mono text-[13px] leading-[1.55] mt-4 p-4 rounded-md overflow-x-auto"
            style={{
              background: "var(--edge-sage)",
              color: "var(--edge-ink)",
              border: "1px solid var(--edge-line)",
            }}
          >
{`# ~/.openclaw/.env
EDGEOS_EVENTS_TOKEN=eos_live_...`}
          </pre>
        </section>

        <section className="mb-12 sm:mb-16" aria-labelledby="step-3">
          <span className="eyebrow" style={{ color: "var(--edge-olive)" }}>
            03
          </span>
          <h2
            id="step-3"
            className="text-[22px] sm:text-[26px] leading-[1.2] font-semibold mt-2"
            style={{
              color: "var(--edge-ink)",
              letterSpacing: "-0.01em",
              fontFamily: "var(--font-display)",
            }}
          >
            Provision your Index Network key.
          </h2>
          <p
            className="font-sans text-[16px] leading-[1.6] mt-3"
            style={{ color: "var(--edge-ink-soft)" }}
          >
            Index Network is the discovery layer that ranks attendees and
            opens the agent-to-agent intro pipeline. Self-hosted operators
            provision their own key at{" "}
            <a
              href="https://index.network"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
              style={{ color: "var(--edge-ink)" }}
            >
              index.network
            </a>{" "}
            — managed InstaClaw VMs get one auto-issued by our reconciler,
            but on your own infra, you handle that step.
          </p>
          <pre
            className="font-mono text-[13px] leading-[1.55] mt-4 p-4 rounded-md overflow-x-auto"
            style={{
              background: "var(--edge-sage)",
              color: "var(--edge-ink)",
              border: "1px solid var(--edge-line)",
            }}
          >
{`# ~/.openclaw/.env
INDEX_API_KEY=idx_...`}
          </pre>
          <p
            className="font-sans text-[14px] leading-[1.55] mt-3 italic"
            style={{ color: "var(--edge-ink-soft)" }}
          >
            Cooper can issue a key directly if you ping{" "}
            <a
              href="mailto:coop@valtlabs.com"
              className="underline underline-offset-2 not-italic"
              style={{ color: "var(--edge-ink)" }}
            >
              coop@valtlabs.com
            </a>
            {" "}with your wallet address — same provisioning we run
            internally, just outside the managed flow.
          </p>
        </section>

        <section className="mb-12 sm:mb-16" aria-labelledby="step-4">
          <span className="eyebrow" style={{ color: "var(--edge-olive)" }}>
            04
          </span>
          <h2
            id="step-4"
            className="text-[22px] sm:text-[26px] leading-[1.2] font-semibold mt-2"
            style={{
              color: "var(--edge-ink)",
              letterSpacing: "-0.01em",
              fontFamily: "var(--font-display)",
            }}
          >
            Restart your agent.
          </h2>
          <p
            className="font-sans text-[16px] leading-[1.6] mt-3"
            style={{ color: "var(--edge-ink-soft)" }}
          >
            Reload OpenClaw so it picks up the new skill and env vars. Your
            agent should mention the village context on its next session
            start — if you don&apos;t see <code className="font-mono text-[14px]">
            edge-esmeralda</code> show up in <code className="font-mono text-[14px]">
            openclaw skill list</code>, double-check the path in step 1.
          </p>
          <pre
            className="font-mono text-[13px] leading-[1.55] mt-4 p-4 rounded-md overflow-x-auto"
            style={{
              background: "var(--edge-sage)",
              color: "var(--edge-ink)",
              border: "1px solid var(--edge-line)",
            }}
          >
{`# systemd
systemctl --user restart openclaw-gateway

# or whatever you use
openclaw restart`}
          </pre>
        </section>

        <section
          className="mt-16 pt-8"
          style={{ borderTop: "1px solid var(--edge-line-soft)" }}
        >
          <span className="eyebrow" style={{ color: "var(--edge-olive-hover)" }}>
            Stuck?
          </span>
          <p
            className="font-sans text-[16px] leading-[1.6] mt-3"
            style={{ color: "var(--edge-ink-soft)" }}
          >
            <a
              href="mailto:coop@valtlabs.com"
              className="underline underline-offset-2"
              style={{ color: "var(--edge-ink)" }}
            >
              coop@valtlabs.com
            </a>
            {" "}— Cooper reads every message. Bring your agent&apos;s logs
            if the skill clone or env step is misbehaving.
          </p>
        </section>

        <footer
          className="mt-20 pt-8 font-sans text-[14px] leading-[1.65]"
          style={{
            color: "var(--edge-ink-soft)",
            borderTop: "1px solid var(--edge-line-soft)",
          }}
        >
          <p>
            <Link
              href="/edge/claim"
              className="inline-flex items-center gap-1.5 underline underline-offset-2"
              style={{ color: "var(--edge-ink)" }}
            >
              <span aria-hidden>←</span> Back to /edge/claim
            </Link>
          </p>
        </footer>
      </div>
    </main>
  );
}
