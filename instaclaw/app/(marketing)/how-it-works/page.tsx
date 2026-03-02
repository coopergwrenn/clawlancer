import { createMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { CtaBanner } from "@/components/marketing/cta-banner";
import Link from "next/link";

export const metadata = createMetadata({
  title: "How InstaClaw Works — Deploy Your AI Agent in 60 Seconds",
  description:
    "Three simple steps to your own personal AI agent: sign up, connect your messaging app, and you're live. No coding required. Full dedicated VM with 20+ skills.",
  path: "/how-it-works",
});

const howToJsonLd = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  name: "How to Deploy Your Personal AI Agent with InstaClaw",
  description:
    "Get your own OpenClaw-powered AI agent running on a dedicated VM in under 60 seconds.",
  step: [
    {
      "@type": "HowToStep",
      position: 1,
      name: "Sign Up",
      text: "Join the waitlist and grab your invite. Once activated, your account automatically provisions a dedicated cloud instance with the full OpenClaw runtime pre-installed.",
    },
    {
      "@type": "HowToStep",
      position: 2,
      name: "Connect Your Messaging App",
      text: "Link your Telegram, Discord, Slack, or WhatsApp. Pick a plan. No coding, no configuration required.",
    },
    {
      "@type": "HowToStep",
      position: 3,
      name: "You're Live",
      text: "Your personal AI launches on its own dedicated machine with real computing power, persistent memory, and pre-loaded skills. It starts working immediately.",
    },
  ],
};

const steps = [
  {
    number: "1",
    title: "Sign Up",
    description:
      "Join the waitlist and grab your invite. Takes about 30 seconds.",
    details: [
      "Create your account with Google or email",
      "Invites are distributed in waves — we'll notify you when your spot opens",
      "Once activated, a dedicated cloud VM is automatically provisioned for you",
      "The full OpenClaw runtime comes pre-installed with all skills and configurations",
    ],
  },
  {
    number: "2",
    title: "Connect Your Messaging App",
    description:
      "Link your Telegram, Discord, Slack, or WhatsApp. Pick a plan. That's the whole setup.",
    details: [
      "Create a Telegram bot (or connect Discord/Slack/WhatsApp) — we walk you through it",
      "Paste your bot token into the dashboard",
      "Choose your plan: Starter ($29/mo), Pro ($99/mo), or Power ($299/mo)",
      "Optionally enable BYOK mode with your own Anthropic API key for lower prices",
    ],
  },
  {
    number: "3",
    title: "You're Live",
    description:
      "Your personal AI launches on its own dedicated machine and starts working immediately.",
    details: [
      "Dedicated Ubuntu VM with 3 vCPU, 4GB RAM, and 80GB SSD",
      "Full SSH access — install any software, run scripts, configure services",
      "20+ pre-installed skills: web search, email, calendar, file management, video creation, crypto trading, and more",
      "Persistent memory across conversations — your agent remembers everything",
      "Self-healing infrastructure that automatically recovers from failures",
      "Cron-based task scheduling for background automation",
    ],
  },
];

const skills = [
  "Web Search",
  "Email Management",
  "Calendar Management",
  "File Management",
  "Video Creation",
  "Social Media Posting",
  "Crypto Trading",
  "Polymarket Trading",
  "Website Monitoring",
  "Code Execution",
  "Image Generation",
  "PDF Processing",
  "Data Analysis",
  "Language Translation",
  "Task Scheduling",
  "Web Scraping",
  "RSS Feed Monitoring",
  "Note Taking",
  "Spreadsheet Management",
  "API Integration",
];

export default function HowItWorksPage() {
  return (
    <>
      <JsonLd data={howToJsonLd} />

      <section className="py-16 sm:py-24 px-4">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-16">
            <h1
              className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-6"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Deploy Your AI Agent in 60 Seconds
            </h1>
            <p
              className="text-sm sm:text-base max-w-lg mx-auto"
              style={{ color: "#6b6b6b" }}
            >
              Three steps. No coding. No configuration. Just a personal AI that
              works for you around the clock.
            </p>
          </div>

          {/* Steps */}
          <div className="space-y-0">
            {steps.map((step, i) => (
              <div key={step.number}>
                <div
                  className="h-px w-full"
                  style={{ background: "rgba(0,0,0,0.1)" }}
                />
                <div className="flex gap-6 sm:gap-10 py-10 sm:py-14 items-start">
                  <span
                    className="shrink-0 mt-1 flex items-center justify-center w-12 h-12 sm:w-14 sm:h-14 rounded-full"
                    style={{
                      background:
                        "radial-gradient(circle at 38% 32%, rgba(220,103,67,0.3), rgba(220,103,67,0.12) 55%, rgba(180,70,40,0.2) 100%)",
                      boxShadow:
                        "inset 0 2px 4px rgba(255,255,255,0.45), inset 0 -2px 4px rgba(0,0,0,0.12), 0 2px 6px rgba(220,103,67,0.1)",
                    }}
                  >
                    <span
                      className="text-xl sm:text-2xl font-medium tracking-[-0.5px]"
                      style={{
                        fontFamily: "var(--font-serif)",
                        color: "#DC6743",
                      }}
                    >
                      {step.number}
                    </span>
                  </span>
                  <div className="flex-1 min-w-0">
                    <h2
                      className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] mb-3"
                      style={{ fontFamily: "var(--font-serif)" }}
                    >
                      {step.title}
                    </h2>
                    <p
                      className="text-base leading-relaxed mb-4"
                      style={{ color: "#6b6b6b" }}
                    >
                      {step.description}
                    </p>
                    <ul className="space-y-2">
                      {step.details.map((detail) => (
                        <li
                          key={detail}
                          className="flex items-start gap-2 text-sm"
                        >
                          <svg
                            className="w-3.5 h-3.5 shrink-0 mt-0.5"
                            viewBox="0 0 16 16"
                            fill="none"
                          >
                            <path
                              d="M6 3l5 5-5 5"
                              stroke="#DC6743"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              opacity="0.6"
                            />
                          </svg>
                          <span style={{ color: "#6b6b6b" }}>{detail}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
                {i === steps.length - 1 && (
                  <div
                    className="h-px w-full"
                    style={{ background: "rgba(0,0,0,0.1)" }}
                  />
                )}
              </div>
            ))}
          </div>

          {/* Skills overview */}
          <div className="mt-20">
            <h2
              className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] text-center mb-8"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              20+ Pre-Loaded Skills
            </h2>
            <p
              className="text-sm text-center max-w-md mx-auto mb-8"
              style={{ color: "#6b6b6b" }}
            >
              Every InstaClaw agent comes ready to go with powerful skills — and
              you can teach it new ones just by talking to it.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {skills.map((skill) => (
                <span
                  key={skill}
                  className="px-3 py-1.5 rounded-full text-xs"
                  style={{
                    background: "rgba(220,103,67,0.08)",
                    color: "#333334",
                  }}
                >
                  {skill}
                </span>
              ))}
            </div>
          </div>

          {/* Telegram integration note */}
          <div className="mt-20 text-center">
            <h2
              className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] mb-4"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Talk to Your Agent Like a Friend
            </h2>
            <p
              className="text-sm max-w-md mx-auto"
              style={{ color: "#6b6b6b" }}
            >
              Message your AI through Telegram, Discord, Slack, or WhatsApp.
              Just type what you need — no commands, no syntax. It understands
              plain English and gets smarter the more you use it.
            </p>
          </div>

          <div className="text-center mt-12 text-sm" style={{ color: "#6b6b6b" }}>
            <p>
              <Link
                href="/pricing"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                View pricing
              </Link>{" "}
              ·{" "}
              <Link
                href="/docs"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                Read the docs
              </Link>{" "}
              ·{" "}
              <Link
                href="/use-cases"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                Explore use cases
              </Link>{" "}
              ·{" "}
              <Link
                href="/faq"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                FAQ
              </Link>
            </p>
          </div>
        </div>
      </section>

      <CtaBanner />
    </>
  );
}
