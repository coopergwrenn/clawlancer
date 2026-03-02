import { createMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { PricingToggle } from "@/components/marketing/pricing-toggle";
import { CtaBanner } from "@/components/marketing/cta-banner";
import Link from "next/link";

export const metadata = createMetadata({
  title: "InstaClaw Pricing — AI Agent Plans Starting at $29/month",
  description:
    "Simple, transparent pricing for your personal AI agent. Starter ($29/mo), Pro ($99/mo), and Power ($299/mo) plans — all with a 3-day free trial. BYOK available.",
  path: "/pricing",
});

const pricingJsonLd = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "InstaClaw Personal AI Agent",
  description:
    "A personal AI agent running on a dedicated VM with all Claude models, 20+ skills, and messaging via Telegram, Discord, Slack, or WhatsApp.",
  brand: { "@type": "Brand", name: "InstaClaw" },
  offers: [
    {
      "@type": "Offer",
      name: "Starter (All-Inclusive)",
      price: "29",
      priceCurrency: "USD",
      priceValidUntil: "2027-12-31",
      availability: "https://schema.org/InStock",
    },
    {
      "@type": "Offer",
      name: "Starter (BYOK)",
      price: "14",
      priceCurrency: "USD",
      priceValidUntil: "2027-12-31",
      availability: "https://schema.org/InStock",
    },
    {
      "@type": "Offer",
      name: "Pro (All-Inclusive)",
      price: "99",
      priceCurrency: "USD",
      priceValidUntil: "2027-12-31",
      availability: "https://schema.org/InStock",
    },
    {
      "@type": "Offer",
      name: "Pro (BYOK)",
      price: "39",
      priceCurrency: "USD",
      priceValidUntil: "2027-12-31",
      availability: "https://schema.org/InStock",
    },
    {
      "@type": "Offer",
      name: "Power (All-Inclusive)",
      price: "299",
      priceCurrency: "USD",
      priceValidUntil: "2027-12-31",
      availability: "https://schema.org/InStock",
    },
    {
      "@type": "Offer",
      name: "Power (BYOK)",
      price: "99",
      priceCurrency: "USD",
      priceValidUntil: "2027-12-31",
      availability: "https://schema.org/InStock",
    },
  ],
};

export default function PricingPage() {
  return (
    <>
      <JsonLd data={pricingJsonLd} />

      <section className="py-16 sm:py-24 px-4">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h1
              className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-6"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Simple, Transparent Pricing
            </h1>
            <p
              className="text-sm sm:text-base max-w-lg mx-auto"
              style={{ color: "#6b6b6b" }}
            >
              Every plan includes a dedicated VM, all AI models, and all
              messaging channels. Daily units reset at midnight UTC — use them on
              any model you like.
            </p>
          </div>

          <PricingToggle />

          {/* Comparison table */}
          <div className="mt-20">
            <h2
              className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] text-center mb-10"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              InstaClaw vs Self-Hosting Costs
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ color: "#333334" }}>
                <thead>
                  <tr
                    className="border-b"
                    style={{ borderColor: "rgba(0,0,0,0.1)" }}
                  >
                    <th className="text-left py-3 pr-4 font-semibold">Item</th>
                    <th className="text-left py-3 px-4 font-semibold">
                      Self-Hosting
                    </th>
                    <th className="text-left py-3 pl-4 font-semibold">
                      InstaClaw
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["VPS / Cloud VM", "$5-20/mo", "Included"],
                    ["AI API costs (Claude)", "$20-100+/mo", "Included (or BYOK)"],
                    ["Setup time", "2-8 hours", "2 minutes"],
                    ["Monitoring & uptime", "You manage it", "Self-healing fleet"],
                    ["SSL, DNS, reverse proxy", "You configure", "Included"],
                    ["Skills & updates", "Manual install", "Pre-loaded + auto-updates"],
                    ["Support", "GitHub issues", "Priority support (Pro+)"],
                  ].map(([item, self, instaclaw]) => (
                    <tr
                      key={item}
                      className="border-b"
                      style={{ borderColor: "rgba(0,0,0,0.06)" }}
                    >
                      <td className="py-3 pr-4">{item}</td>
                      <td className="py-3 px-4" style={{ color: "#6b6b6b" }}>
                        {self}
                      </td>
                      <td className="py-3 pl-4 font-medium">{instaclaw}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-center mt-6">
              <Link
                href="/compare/instaclaw-vs-self-hosting"
                className="text-sm underline transition-opacity hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                See full comparison →
              </Link>
            </p>
          </div>

          {/* Pricing FAQ */}
          <div className="mt-20">
            <h2
              className="text-2xl sm:text-3xl font-normal tracking-[-0.5px] text-center mb-10"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Pricing FAQ
            </h2>
            <div className="max-w-2xl mx-auto space-y-6 text-sm">
              {[
                {
                  q: "What happens when I run out of daily units?",
                  a: "Your agent pauses until midnight UTC when limits reset. You can also purchase credit packs (50/$5, 200/$15, 500/$30) that kick in instantly for overflow beyond daily limits.",
                },
                {
                  q: "Can I switch plans anytime?",
                  a: "Yes, upgrade or downgrade at any time. Changes take effect on your next billing cycle.",
                },
                {
                  q: "What's the difference between All-Inclusive and BYOK?",
                  a: "All-Inclusive includes AI model costs in your subscription. BYOK (Bring Your Own Key) lets you use your own Anthropic API key and pay Anthropic directly, cutting your InstaClaw subscription roughly in half.",
                },
                {
                  q: "Is there really a free trial?",
                  a: "Yes — every plan comes with a full 3-day free trial. No restrictions, no credit card tricks. Cancel anytime before it ends and you won't be charged.",
                },
              ].map(({ q, a }) => (
                <div key={q}>
                  <h3 className="font-semibold mb-1" style={{ color: "#333334" }}>
                    {q}
                  </h3>
                  <p style={{ color: "#6b6b6b" }}>{a}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="text-center mt-12 text-sm" style={{ color: "#6b6b6b" }}>
            <p>
              Have more questions?{" "}
              <Link
                href="/faq"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                Check the FAQ
              </Link>{" "}
              or{" "}
              <Link
                href="/how-it-works"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                see how it works
              </Link>
              .
            </p>
          </div>
        </div>
      </section>

      <CtaBanner />
    </>
  );
}
