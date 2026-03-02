import { createMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { CtaBanner } from "@/components/marketing/cta-banner";
import Link from "next/link";

export const metadata = createMetadata({
  title: "InstaClaw vs Self-Hosting OpenClaw — Which Is Right For You?",
  description:
    "Honest comparison of InstaClaw managed hosting vs self-hosting OpenClaw. Compare costs, setup time, maintenance, skills, reliability, and more.",
  path: "/compare/instaclaw-vs-self-hosting",
});

const articleJsonLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: "InstaClaw vs Self-Hosting OpenClaw — Which Is Right For You?",
  description:
    "An honest comparison of managed hosting with InstaClaw vs self-hosting OpenClaw on your own infrastructure.",
  url: "https://instaclaw.io/compare/instaclaw-vs-self-hosting",
  publisher: {
    "@type": "Organization",
    name: "InstaClaw",
    url: "https://instaclaw.io",
  },
};

const rows = [
  { category: "Setup time", self: "2-8 hours", instaclaw: "~2 minutes" },
  { category: "Technical skill required", self: "Linux, SSH, Docker, DNS, SSL", instaclaw: "None" },
  { category: "Server cost", self: "$5-20/month (VPS)", instaclaw: "Included in plan" },
  { category: "AI API costs", self: "$20-100+/month (Anthropic)", instaclaw: "Included (or BYOK)" },
  { category: "Total monthly cost", self: "$25-120+/month + your time", instaclaw: "$29-299/month (all-in)" },
  { category: "Uptime monitoring", self: "You set up & manage", instaclaw: "Automatic, self-healing" },
  { category: "Crash recovery", self: "Manual intervention", instaclaw: "Auto-restart & recovery" },
  { category: "SSL & DNS", self: "You configure", instaclaw: "Included & managed" },
  { category: "Skills & updates", self: "Manual install & update", instaclaw: "Pre-loaded, auto-updated" },
  { category: "Number of skills", self: "Depends on your setup", instaclaw: "20+ pre-installed" },
  { category: "Messaging integration", self: "Manual bot setup", instaclaw: "Dashboard setup (2 min)" },
  { category: "Server access", self: "Full root access", instaclaw: "Full SSH access" },
  { category: "Custom software", self: "Install anything", instaclaw: "Install anything" },
  { category: "Data privacy", self: "Fully isolated (your server)", instaclaw: "Fully isolated (dedicated VM)" },
  { category: "Support", self: "GitHub issues / community", instaclaw: "Email + Discord (priority for Pro+)" },
  { category: "BYOK mode", self: "Native (you provide the key)", instaclaw: "Supported (encrypted on VM)" },
  { category: "Scalability", self: "Manual migration", instaclaw: "Upgrade plan in dashboard" },
];

export default function ComparisonPage() {
  return (
    <>
      <JsonLd data={articleJsonLd} />

      <section className="py-16 sm:py-24 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-16">
            <h1
              className="text-4xl sm:text-5xl font-normal tracking-[-1px] leading-[1.05] mb-6"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              InstaClaw vs Self-Hosting
            </h1>
            <p
              className="text-sm sm:text-base max-w-lg mx-auto"
              style={{ color: "#6b6b6b" }}
            >
              An honest comparison. Both paths give you a powerful personal AI
              agent — the difference is how much work you want to do yourself.
            </p>
          </div>

          {/* Comparison table */}
          <div className="overflow-x-auto mb-16">
            <table className="w-full text-sm" style={{ color: "#333334" }}>
              <thead>
                <tr
                  className="border-b"
                  style={{ borderColor: "rgba(0,0,0,0.1)" }}
                >
                  <th className="text-left py-3 pr-4 font-semibold w-1/3"></th>
                  <th className="text-left py-3 px-4 font-semibold w-1/3" style={{ color: "#6b6b6b" }}>
                    Self-Hosting
                  </th>
                  <th className="text-left py-3 pl-4 font-semibold w-1/3" style={{ color: "#DC6743" }}>
                    InstaClaw
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.category}
                    className="border-b"
                    style={{ borderColor: "rgba(0,0,0,0.06)" }}
                  >
                    <td className="py-3 pr-4 font-medium">{row.category}</td>
                    <td className="py-3 px-4" style={{ color: "#6b6b6b" }}>
                      {row.self}
                    </td>
                    <td className="py-3 pl-4 font-medium">{row.instaclaw}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Analysis */}
          <div className="space-y-10 text-sm leading-relaxed">
            <section>
              <h2
                className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                When to Self-Host
              </h2>
              <p style={{ color: "#6b6b6b" }}>
                Self-hosting makes sense if you&apos;re an experienced developer who
                enjoys managing infrastructure, you want maximum control over
                every aspect of your setup, you already have servers and
                DevOps workflows in place, or you want to contribute to
                OpenClaw development and need a deep understanding of the
                internals.
              </p>
              <p className="mt-4" style={{ color: "#6b6b6b" }}>
                Self-hosting gives you the same powerful AI agent, but you&apos;re
                responsible for provisioning, configuring, monitoring, updating,
                and recovering from failures. For someone comfortable with Linux
                administration, it&apos;s a viable option — but it does require
                ongoing time and attention.
              </p>
            </section>

            <section>
              <h2
                className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                When to Use InstaClaw
              </h2>
              <p style={{ color: "#6b6b6b" }}>
                InstaClaw makes sense if you want a personal AI agent without
                the technical overhead, you value your time and prefer to
                delegate infrastructure management, you don&apos;t have experience
                with Linux servers or DevOps, or you want a reliable,
                always-on agent without worrying about crashes or updates.
              </p>
              <p className="mt-4" style={{ color: "#6b6b6b" }}>
                InstaClaw handles everything: server provisioning, OpenClaw
                installation, SSL, DNS, monitoring, auto-recovery, skill
                updates, and support. You get the same full SSH access as
                self-hosting, but without the initial setup or ongoing
                maintenance.
              </p>
            </section>

            <section>
              <h2
                className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                The Cost Comparison
              </h2>
              <p style={{ color: "#6b6b6b" }}>
                At first glance, self-hosting looks cheaper: a $5-10/month VPS
                plus API costs. But the hidden cost is your time. Setting up
                takes 2-8 hours (worth $50-200+ at most professional rates).
                Ongoing maintenance — monitoring, debugging, updating, recovering
                from crashes — adds 1-2 hours per month minimum.
              </p>
              <p className="mt-4" style={{ color: "#6b6b6b" }}>
                InstaClaw&apos;s Starter plan at $29/month includes everything: the
                server, AI model access, 20+ pre-installed skills, self-healing
                monitoring, and support. For most people, the time saved is worth
                far more than the price difference. With BYOK mode at $14/month,
                the gap narrows even further.
              </p>
            </section>

            <section>
              <h2
                className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                The Bottom Line
              </h2>
              <p style={{ color: "#6b6b6b" }}>
                Both paths give you a powerful personal AI agent. The question is
                whether you want to spend your time managing infrastructure or
                using your agent. If you enjoy the technical challenge, self-host.
                If you want it to just work, use InstaClaw.
              </p>
            </section>
          </div>

          <div
            className="text-center mt-12 text-sm"
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
                href="/how-it-works"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                How it works
              </Link>{" "}
              ·{" "}
              <Link
                href="/docs"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                Quickstart guide
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
