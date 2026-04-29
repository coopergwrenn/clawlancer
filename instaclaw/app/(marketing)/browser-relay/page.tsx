import Link from "next/link";
import { ExternalLink, ShieldAlert, Globe, MousePointerClick, Camera, Keyboard, Eye, Lock } from "lucide-react";
import { createMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { FaqAccordion } from "@/components/marketing/faq-accordion";
import { CtaBanner } from "@/components/marketing/cta-banner";

export const metadata = createMetadata({
  title: "Browser Relay — let your InstaClaw agent use your real Chrome browser",
  description:
    "Connect your InstaClaw agent to your Chrome browser so it can browse the sites you're already logged into — Gmail, banking, exchanges, internal tools. Beta. Includes a setup guide, security tips, FAQ, and troubleshooting.",
  path: "/browser-relay",
});

const browserRelayJsonLd = {
  "@context": "https://schema.org",
  "@type": "TechArticle",
  headline: "InstaClaw Browser Relay",
  description:
    "Connect your InstaClaw agent to your Chrome browser using the Browser Relay extension.",
  about: "Browser automation for personal AI agents",
  mainEntity: {
    "@type": "SoftwareApplication",
    name: "InstaClaw Browser Relay",
    applicationCategory: "BrowserApplication",
    operatingSystem: "Chrome 116+",
    url:
      "https://chromewebstore.google.com/detail/ondclglahfaiajfomkhmpdnocadfkdpo",
  },
};

const STORE_URL =
  "https://chromewebstore.google.com/detail/ondclglahfaiajfomkhmpdnocadfkdpo";

const faqItems = [
  {
    question: "Does it work on Firefox or Safari?",
    answer:
      "Not yet. Browser Relay requires Chrome 116 or later, or any Chromium-based browser that installs Chrome Web Store extensions (Edge, Brave). Firefox and Safari are not supported. We have no concrete timeline for adding them.",
  },
  {
    question: "What if my agent does something I didn't want it to do?",
    answer:
      "Open the extension popup and click Disconnect, or close the tab the agent is using. Either action stops the agent's browser session immediately. The agent can't reconnect on its own — you have to re-pair from the dashboard. We also recommend running in supervised mode for the first few tasks so you can approve each action before it happens.",
  },
  {
    question: "How do I disconnect?",
    answer:
      "Three ways. From your dashboard, the Connect Your Browser card has the gateway URL — clearing or rotating it kills the connection. From the extension itself, the popup has a Disconnect button. Or just close the tabs the agent has attached. Disconnecting from any of those routes is immediate; the agent loses access in under a second.",
  },
  {
    question: "Can the agent see all my tabs at once?",
    answer:
      "It can list your open tabs and read what's on the active one. It only acts on the tabs you've explicitly attached. The extension shows a small badge on attached tabs so you can see at a glance what the agent has access to.",
  },
  {
    question: "Does it record what I do in Chrome?",
    answer:
      "No. The relay only sends data when the agent is actively running a task. There's no passive logging of your browsing or keystrokes. When the agent isn't running, the extension is idle. You can verify this in the extension's source — it's open source and the same code we publish to the Chrome Web Store.",
  },
  {
    question: "Where is browser data stored?",
    answer:
      "Page contents the agent reads are processed in memory by the agent on your dedicated VM, sent to the model for that turn, and not persisted unless the agent explicitly saves something to a file. Screenshots are stored on your VM until cleaned up. Nothing is sent to InstaClaw servers beyond the same telemetry that any agent action produces (request count, error rates) — no page contents, no screenshots, no cookies.",
  },
  {
    question: "Will the agent share my logged-in sessions with anyone?",
    answer:
      "No. The relay runs locally between your Chrome and your dedicated VM over an authenticated WebSocket. Your session cookies stay in Chrome. The agent uses your existing logins to act in real time but does not export, copy, or share them.",
  },
  {
    question: "Why is this in beta?",
    answer:
      "Two reasons. First, the surface area is huge — every site behaves differently and we're still finding edge cases. Second, the security model is genuinely new for most people, and we want to learn how everyone uses it before turning it on by default. If you find a rough edge, email help@instaclaw.io.",
  },
];

const troubleshootingItems = [
  {
    question: "\"Extension Connected\" never shows up",
    answer:
      "Open the extension's options page and double-check the Gateway URL — it must match exactly the value shown in your dashboard's Connect Your Browser card, including the https:// prefix. Then check the Gateway Token: in the dashboard, click the copy icon next to the URL and you'll get the token. Paste it into the extension. If it still won't connect, your Chrome may be blocking the WebSocket — try disabling other extensions one at a time, especially privacy-focused ones (uBlock Origin, Privacy Badger).",
  },
  {
    question: "Permissions error / extension can't access pages",
    answer:
      "The extension needs the debugger, tabs, storage, alarms, and webNavigation permissions. Open chrome://extensions, find InstaClaw Browser Relay, click Details, and verify all permissions are granted. If a permission was denied, remove and reinstall the extension to re-prompt. Note: Chrome will show a yellow \"Started debugging this browser\" banner whenever the agent is using a tab — this is Chrome's standard warning, not a problem.",
  },
  {
    question: "Agent says \"relay not connected\" but the extension shows green",
    answer:
      "Usually this means a token mismatch — your VM's gateway token rotated and the extension still has the old one. Open the dashboard, copy the current gateway URL fresh, and paste it back into the extension. If that doesn't fix it, restart your VM's gateway from the dashboard. The extension will reconnect automatically within ~10 seconds.",
  },
  {
    question: "It worked yesterday and stopped today",
    answer:
      "The most common cause is a Chrome update that disabled the extension's service worker. Open chrome://extensions, find InstaClaw Browser Relay, toggle it off and back on. If that doesn't help, the extension version may have changed — Chrome will auto-update extensions, and a new version sometimes needs the connection to be re-paired. Reload the extension and re-paste the gateway URL.",
  },
  {
    question: "The agent is doing something I don't want — how do I stop it now?",
    answer:
      "Click the extension icon and hit Disconnect. The agent loses its connection in under a second. If you can't reach the extension, just close the Chrome tab — the agent's actions are tied to the tab and won't continue elsewhere. From your dashboard, you can also revoke the gateway token, which kills any reconnection attempt.",
  },
];

export default function BrowserRelayPage() {
  return (
    <>
      <JsonLd data={browserRelayJsonLd} />

      {/* Hero */}
      <section className="pt-16 sm:pt-24 pb-10 px-4">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-10">
            <span
              className="inline-block text-[11px] uppercase tracking-[0.14em] font-medium px-2.5 py-1 rounded-full mb-5"
              style={{
                background: "rgba(245,158,11,0.1)",
                color: "#b8770b",
                border: "1px solid rgba(245,158,11,0.25)",
              }}
            >
              Beta · Chrome 116+
            </span>
            <h1
              className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-6"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Browser Relay
            </h1>
            <p
              className="text-base sm:text-lg max-w-xl mx-auto leading-relaxed"
              style={{ color: "#6b6b6b" }}
            >
              Let your InstaClaw agent use the Chrome browser you&apos;re already
              logged into. Email, banking, exchanges, internal tools — anywhere
              you&apos;re signed in, your agent can act on your behalf.
            </p>
          </div>
        </div>
      </section>

      {/* Beta safety callout */}
      <section className="px-4 mb-16">
        <div className="max-w-3xl mx-auto">
          <div
            className="rounded-xl p-5 flex gap-4"
            style={{
              background: "rgba(245,158,11,0.06)",
              border: "1px solid rgba(245,158,11,0.25)",
            }}
          >
            <ShieldAlert
              className="w-5 h-5 shrink-0 mt-0.5"
              style={{ color: "#b8770b" }}
              aria-hidden="true"
            />
            <div className="text-sm leading-relaxed">
              <p className="font-medium mb-1" style={{ color: "#333334" }}>
                Browser Relay is in beta with real risks. Read this before
                connecting accounts you care about.
              </p>
              <p style={{ color: "#6b6b6b" }}>
                Your agent gets the same access you have in your browser — it
                can read what you can read, click what you can click, and submit
                what you can submit. That makes it powerful, and it makes it
                worth being deliberate about which tabs you attach. The
                guidelines below are the same ones we follow internally.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* What it does */}
      <section className="px-4 mb-20">
        <div className="max-w-3xl mx-auto">
          <h2
            className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] mb-3"
            style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
          >
            What your agent can do
          </h2>
          <p className="text-sm sm:text-base mb-8" style={{ color: "#6b6b6b" }}>
            Once connected, your agent uses the same Chrome window you do. No
            new login flows, no API keys, no scraping workarounds.
          </p>

          <div className="grid sm:grid-cols-2 gap-4">
            <Capability
              icon={<Globe className="w-4 h-4" />}
              title="Navigate"
              body="Open URLs, follow links, jump between tabs the same way you do."
            />
            <Capability
              icon={<MousePointerClick className="w-4 h-4" />}
              title="Click & interact"
              body="Click buttons, expand menus, scroll long pages, dismiss modals."
            />
            <Capability
              icon={<Keyboard className="w-4 h-4" />}
              title="Type & fill forms"
              body="Type into inputs, fill multi-step forms, paste from your files."
            />
            <Capability
              icon={<Camera className="w-4 h-4" />}
              title="Screenshot & read"
              body="Capture what's on screen, extract structured data, summarize pages."
            />
          </div>
        </div>
      </section>

      {/* Setup */}
      <section className="px-4 mb-20">
        <div className="max-w-3xl mx-auto">
          <h2
            className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] mb-10"
            style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
          >
            Set it up
          </h2>

          <div className="space-y-12 text-sm leading-relaxed">
            <Step n={1} title="Install the extension">
              <p style={{ color: "#6b6b6b" }} className="mb-4">
                The official extension is{" "}
                <span className="font-medium" style={{ color: "#333334" }}>
                  InstaClaw Browser Relay
                </span>{" "}
                in the Chrome Web Store. Manifest v3, takes about ten seconds.
              </p>
              <a
                href={STORE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all"
                style={{
                  background: "#DC6743",
                  color: "#fff",
                  boxShadow: "0 2px 8px rgba(220,103,67,0.3)",
                }}
              >
                Open Chrome Web Store <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </Step>

            <Step n={2} title="Copy your Gateway URL from the dashboard">
              <p style={{ color: "#6b6b6b" }} className="mb-3">
                Go to{" "}
                <Link
                  href="/settings"
                  className="underline underline-offset-2"
                  style={{ color: "#333334" }}
                >
                  Settings → Connect Your Browser
                </Link>
                . Click the copy icon next to the Gateway URL. The URL doubles
                as your auth token — don&apos;t share it.
              </p>
              <p className="text-xs" style={{ color: "#6b6b6b" }}>
                If you don&apos;t see the section yet, your VM may still be
                provisioning. Refresh after a minute.
              </p>
            </Step>

            <Step n={3} title="Paste it into the extension">
              <p style={{ color: "#6b6b6b" }} className="mb-3">
                Click the extension&apos;s icon, then{" "}
                <span className="font-medium" style={{ color: "#333334" }}>
                  Options
                </span>
                . Paste the Gateway URL. Save.
              </p>
              <p className="text-xs" style={{ color: "#6b6b6b" }}>
                Within about ten seconds your dashboard&apos;s status indicator
                flips from{" "}
                <span className="font-medium">Not Connected</span> to{" "}
                <span className="font-medium" style={{ color: "#22a155" }}>
                  Extension Connected · Live
                </span>
                . If it stays gray, see the troubleshooting section below.
              </p>
            </Step>

            <Step n={4} title="Try it out">
              <p style={{ color: "#6b6b6b" }} className="mb-3">
                Message your agent:
              </p>
              <pre
                className="text-xs sm:text-sm rounded-lg p-3 mb-3 font-mono whitespace-pre-wrap"
                style={{
                  background: "#f3f1ec",
                  border: "1px solid rgba(0,0,0,0.06)",
                  color: "#333334",
                }}
              >
                open dexscreener and tell me what trending tokens look like
                today
              </pre>
              <p style={{ color: "#6b6b6b" }}>
                The agent will open the page, take a screenshot, and report
                back. Start with low-stakes queries like this before you give
                it your inbox.
              </p>
            </Step>
          </div>
        </div>
      </section>

      {/* Security */}
      <section className="px-4 mb-20">
        <div className="max-w-3xl mx-auto">
          <h2
            className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] mb-3 flex items-center gap-3"
            style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
          >
            <Lock className="w-6 h-6" style={{ color: "#DC6743" }} />
            Use it responsibly
          </h2>
          <p className="text-sm sm:text-base mb-8" style={{ color: "#6b6b6b" }}>
            Same energy as letting a friend borrow your laptop while you&apos;re
            in the room. Powerful, but pay attention.
          </p>

          <div className="space-y-5 text-sm leading-relaxed">
            <SafetyTip
              n={1}
              title="Start with tabs that don't matter"
              body="Search results, news, public docs, dexscreener. Get a feel for how the agent navigates before you point it at Gmail or your bank."
            />
            <SafetyTip
              n={2}
              title="Watch for prompt injection from the page"
              body="A site can hide instructions in its content trying to get your agent to do something else — open another tab, transfer funds, exfiltrate text. Run in supervised mode for sensitive sessions so you approve each action; if something looks off, disconnect."
            />
            <SafetyTip
              n={3}
              title="Detach before high-stakes actions"
              body="Large purchases, wire transfers, sending high-impact emails. Disconnect or close the tab first, do the action manually, then re-attach. The agent doesn't need to be involved in every step."
            />
            <SafetyTip
              n={4}
              title="Treat the gateway URL like a password"
              body="Anyone with your Gateway URL can drive your agent's browser session. Don't paste it into untrusted tools or share it in chats. If it leaks, rotate the token from your dashboard — the old one stops working immediately."
            />
            <SafetyTip
              n={5}
              title="Found something off? Tell us"
              body={
                <>
                  Email{" "}
                  <a
                    href="mailto:help@instaclaw.io?subject=Browser%20Relay%20issue"
                    className="underline underline-offset-2"
                    style={{ color: "#DC6743" }}
                  >
                    help@instaclaw.io
                  </a>
                  . Quick replies on weekdays. Include what you were trying to
                  do and what happened — screenshots welcome.
                </>
              }
            />
          </div>
        </div>
      </section>

      {/* Privacy note */}
      <section className="px-4 mb-20">
        <div className="max-w-3xl mx-auto">
          <div
            className="rounded-xl p-6 flex gap-4"
            style={{
              background: "#fff",
              border: "1px solid rgba(0,0,0,0.08)",
            }}
          >
            <Eye
              className="w-5 h-5 shrink-0 mt-0.5"
              style={{ color: "#DC6743" }}
              aria-hidden="true"
            />
            <div className="text-sm leading-relaxed">
              <h3 className="font-medium mb-2" style={{ color: "#333334" }}>
                What we see, what we don&apos;t
              </h3>
              <p style={{ color: "#6b6b6b" }}>
                Your browser session stays between your Chrome and your
                dedicated VM. We don&apos;t see the pages your agent visits, the
                screenshots it takes, or the cookies it uses. Standard agent
                telemetry (request count, error rates) still applies — no
                page contents.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* FAQs */}
      <section className="px-4 mb-20">
        <div className="max-w-3xl mx-auto">
          <h2
            className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] mb-8"
            style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
          >
            FAQ
          </h2>
          <FaqAccordion items={faqItems} />
        </div>
      </section>

      {/* Troubleshooting */}
      <section className="px-4 mb-24">
        <div className="max-w-3xl mx-auto">
          <h2
            className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] mb-3"
            style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
          >
            Troubleshooting
          </h2>
          <p className="text-sm mb-8" style={{ color: "#6b6b6b" }}>
            Common problems and what to try first. If none of these fix it,
            email{" "}
            <a
              href="mailto:help@instaclaw.io?subject=Browser%20Relay%20issue"
              className="underline underline-offset-2"
              style={{ color: "#DC6743" }}
            >
              help@instaclaw.io
            </a>
            .
          </p>
          <FaqAccordion items={troubleshootingItems} />
        </div>
      </section>

      <CtaBanner
        heading="Ready to try it?"
        description="Get your agent set up, install the extension, and you're browsing in under five minutes."
      />
    </>
  );
}

/* ── Local components ─────────────────────────────────────────────── */

function Capability({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div
      className="rounded-xl p-5"
      style={{ background: "#fff", border: "1px solid rgba(0,0,0,0.08)" }}
    >
      <div
        className="inline-flex items-center justify-center w-8 h-8 rounded-lg mb-3"
        style={{ background: "rgba(220,103,67,0.1)", color: "#DC6743" }}
      >
        {icon}
      </div>
      <h3 className="text-sm font-medium mb-1" style={{ color: "#333334" }}>
        {title}
      </h3>
      <p className="text-xs leading-relaxed" style={{ color: "#6b6b6b" }}>
        {body}
      </p>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-3 mb-4">
        <span
          className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium"
          style={{ background: "rgba(220,103,67,0.12)", color: "#DC6743" }}
        >
          {n}
        </span>
        <h3
          className="text-lg sm:text-xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
        >
          {title}
        </h3>
      </div>
      <div className="pl-11">{children}</div>
    </section>
  );
}

function SafetyTip({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <span
        className="shrink-0 flex items-center justify-center w-7 h-7 rounded-full text-xs font-medium mt-0.5"
        style={{
          background: "rgba(245,158,11,0.12)",
          color: "#b8770b",
        }}
      >
        {n}
      </span>
      <div>
        <h3 className="font-medium mb-1" style={{ color: "#333334" }}>
          {title}
        </h3>
        <p style={{ color: "#6b6b6b" }}>{body}</p>
      </div>
    </div>
  );
}
