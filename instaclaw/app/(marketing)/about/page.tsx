import { createMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { CtaBanner } from "@/components/marketing/cta-banner";
import Link from "next/link";

export const metadata = createMetadata({
  title: "About InstaClaw — The Future of Personal AI Agents",
  description:
    "InstaClaw makes personal AI agents accessible to everyone. Founded by Cooper Wrenn, built on OpenClaw, powered by Anthropic's Claude. Learn our story.",
  path: "/about",
});

const aboutJsonLd = [
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "InstaClaw",
    url: "https://instaclaw.io",
    logo: "https://instaclaw.io/logo.png",
    founder: {
      "@type": "Person",
      name: "Cooper Wrenn",
    },
    description:
      "InstaClaw is a managed hosting platform for OpenClaw personal AI agents.",
  },
  {
    "@context": "https://schema.org",
    "@type": "Person",
    name: "Cooper Wrenn",
    jobTitle: "Founder",
    worksFor: {
      "@type": "Organization",
      name: "Wild West Bots LLC",
    },
  },
];

export default function AboutPage() {
  return (
    <>
      <JsonLd data={aboutJsonLd} />

      <section className="py-16 sm:py-24 px-4">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-16">
            <h1
              className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-6"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              About InstaClaw
            </h1>
            <p
              className="text-sm sm:text-base max-w-lg mx-auto"
              style={{ color: "#6b6b6b" }}
            >
              We believe everyone deserves a personal AI that actually does
              things. Not just chat. Not just suggest. Actually take action on
              your behalf.
            </p>
          </div>

          <div
            className="space-y-12 text-sm leading-relaxed"
            style={{ color: "#333334" }}
          >
            {/* Mission */}
            <section>
              <h2
                className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] mb-4"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                Our Mission
              </h2>
              <p style={{ color: "#6b6b6b" }}>
                AI is the most powerful technology of our generation, but most
                people only have access to chatbots — interfaces that talk but
                can&apos;t act. InstaClaw changes that. We give every user their own
                AI agent running on a dedicated machine with real computing
                power, persistent memory, and the ability to take action in the
                real world.
              </p>
              <p className="mt-4" style={{ color: "#6b6b6b" }}>
                Our goal is simple: make personal AI agents as easy to set up as
                creating a social media account. Sign up, connect your messaging
                app, and you&apos;re live — no coding, no servers, no configuration.
              </p>
            </section>

            {/* Founder */}
            <section>
              <h2
                className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] mb-4"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                The Founder
              </h2>
              <p style={{ color: "#6b6b6b" }}>
                InstaClaw was founded by Cooper Wrenn through Wild West Bots LLC.
                Cooper saw that OpenClaw — the open-source AI agent framework —
                had the potential to give everyone a truly personal AI, but the
                technical barrier to self-hosting was too high for most people.
                The setup process required provisioning servers, configuring
                dependencies, managing API keys, handling SSL certificates, and
                maintaining uptime — work that takes hours even for experienced
                developers.
              </p>
              <p className="mt-4" style={{ color: "#6b6b6b" }}>
                InstaClaw eliminates all of that. One signup, and you have a
                fully configured AI agent on a dedicated VM, accessible through
                the messaging apps you already use. The entire setup takes less
                than two minutes.
              </p>
            </section>

            {/* What makes us different */}
            <section>
              <h2
                className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] mb-4"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                What Makes InstaClaw Different
              </h2>
              <ul className="space-y-4" style={{ color: "#6b6b6b" }}>
                <li className="flex items-start gap-3">
                  <span
                    className="shrink-0 mt-1 w-1.5 h-1.5 rounded-full"
                    style={{ background: "#DC6743" }}
                  />
                  <div>
                    <strong style={{ color: "#333334" }}>
                      Dedicated virtual machines.
                    </strong>{" "}
                    Every user gets their own isolated server. No shared
                    resources, no data mixing, no noisy neighbors. Your AI&apos;s
                    conversations, files, and memory live on your machine only.
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <span
                    className="shrink-0 mt-1 w-1.5 h-1.5 rounded-full"
                    style={{ background: "#DC6743" }}
                  />
                  <div>
                    <strong style={{ color: "#333334" }}>
                      Self-healing fleet.
                    </strong>{" "}
                    Our infrastructure automatically monitors every VM and
                    recovers from failures without user intervention. Crashed
                    gateway? Auto-restart. Disk full? Auto-cleanup. Network
                    issue? Auto-reconnect. You never have to think about uptime.
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <span
                    className="shrink-0 mt-1 w-1.5 h-1.5 rounded-full"
                    style={{ background: "#DC6743" }}
                  />
                  <div>
                    <strong style={{ color: "#333334" }}>
                      20+ pre-loaded skills.
                    </strong>{" "}
                    Every agent comes ready to go with web search, email, calendar,
                    file management, video creation, social media, crypto trading,
                    and more. Plus, you can teach your agent new skills just by
                    talking to it.
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <span
                    className="shrink-0 mt-1 w-1.5 h-1.5 rounded-full"
                    style={{ background: "#DC6743" }}
                  />
                  <div>
                    <strong style={{ color: "#333334" }}>
                      Crypto-native.
                    </strong>{" "}
                    InstaClaw is integrated with the Virtuals Protocol ecosystem
                    through the $INSTACLAW token, and connected to the Clawlancer
                    AI agent marketplace on Base mainnet via the $CLAWLANCER
                    token. We&apos;re building at the intersection of AI and Web3.
                  </div>
                </li>
              </ul>
            </section>

            {/* Built on OpenClaw */}
            <section>
              <h2
                className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] mb-4"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                Built on OpenClaw
              </h2>
              <p style={{ color: "#6b6b6b" }}>
                InstaClaw is built on{" "}
                <a
                  href="https://openclaw.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:opacity-70"
                  style={{ color: "#DC6743" }}
                >
                  OpenClaw
                </a>
                , the open-source personal AI agent framework. OpenClaw gives AI
                agents their own compute environment with shell access,
                persistent memory, skill learning, and tool integration.
                InstaClaw handles everything else: provisioning, configuration,
                monitoring, updates, and support.
              </p>
              <p className="mt-4" style={{ color: "#6b6b6b" }}>
                Think of it like the difference between running your own email
                server and using Gmail. The underlying technology is powerful and
                open, but most people want it to just work — and that&apos;s what
                InstaClaw delivers.
              </p>
            </section>

            {/* Contact */}
            <section>
              <h2
                className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] mb-4"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                Get in Touch
              </h2>
              <p style={{ color: "#6b6b6b" }}>
                Have questions? Want to partner with us? Just want to say hi?
              </p>
              <ul className="mt-4 space-y-2" style={{ color: "#6b6b6b" }}>
                <li>
                  Email:{" "}
                  <a
                    href="mailto:support@instaclaw.io"
                    className="underline hover:opacity-70"
                    style={{ color: "#DC6743" }}
                  >
                    support@instaclaw.io
                  </a>
                </li>
                <li>
                  X/Twitter:{" "}
                  <a
                    href="https://x.com/instaclaws"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:opacity-70"
                    style={{ color: "#DC6743" }}
                  >
                    @instaclaws
                  </a>
                </li>
                <li>
                  Discord:{" "}
                  <a
                    href="/discord"
                    className="underline hover:opacity-70"
                    style={{ color: "#DC6743" }}
                  >
                    Join our community
                  </a>
                </li>
              </ul>
            </section>
          </div>

          <div
            className="text-center mt-16 text-sm"
            style={{ color: "#6b6b6b" }}
          >
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
                href="/blog"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                Read our blog
              </Link>{" "}
              ·{" "}
              <Link
                href="/how-it-works"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                How it works
              </Link>
            </p>
          </div>
        </div>
      </section>

      <CtaBanner />
    </>
  );
}
