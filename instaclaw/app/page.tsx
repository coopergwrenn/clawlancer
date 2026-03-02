import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Comparison } from "@/components/landing/comparison";
import { UseCases } from "@/components/landing/use-cases";
import { Features } from "@/components/landing/features";
import { Testimonials } from "@/components/landing/testimonials";
import { Pricing } from "@/components/landing/pricing";
import { FAQ } from "@/components/landing/faq";
import { Footer } from "@/components/landing/footer";
import { LenisProvider } from "@/components/landing/lenis-provider";
import { ScrollReveal } from "@/components/landing/scroll-reveal";
import { NotificationBar } from "@/components/landing/notification-bar";
import { JsonLd } from "@/components/marketing/json-ld";

const homepageJsonLd = [
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "InstaClaw",
    url: "https://instaclaw.io",
    logo: "https://instaclaw.io/logo.png",
    description:
      "InstaClaw is a managed hosting platform for OpenClaw personal AI agents. Get a dedicated AI agent running on its own virtual machine, live in minutes.",
    sameAs: [
      "https://x.com/instaclaws",
      "https://instagram.com/instaclaw.io",
      "https://discord.gg/instaclaw",
    ],
    contactPoint: {
      "@type": "ContactPoint",
      email: "support@instaclaw.io",
      contactType: "customer support",
    },
  },
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "InstaClaw.io",
    url: "https://instaclaw.io",
  },
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "InstaClaw",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description:
      "A personal AI agent that works for you around the clock. Handles tasks, remembers everything, and gets smarter every day.",
    offers: [
      {
        "@type": "Offer",
        name: "Starter",
        price: "29",
        priceCurrency: "USD",
        description: "600 daily units, dedicated VM, all AI models, all channels",
      },
      {
        "@type": "Offer",
        name: "Pro",
        price: "99",
        priceCurrency: "USD",
        description: "1,000 daily units, priority support, early access to new features",
      },
      {
        "@type": "Offer",
        name: "Power",
        price: "299",
        priceCurrency: "USD",
        description: "2,500 daily units, upgraded server resources, dedicated support",
      },
    ],
  },
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "What is InstaClaw?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "InstaClaw is a personal AI that actually does things for you — not just chat. It can send emails, manage your calendar, search the web, organize files, and handle tasks around the clock. You talk to it through Telegram, Discord, Slack, or WhatsApp.",
        },
      },
      {
        "@type": "Question",
        name: "How is this different from ChatGPT?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "ChatGPT can only talk. InstaClaw can act. It has its own computer, so it can browse the web, run code, manage files, and use real tools on your behalf.",
        },
      },
      {
        "@type": "Question",
        name: "What can it actually do for me?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Sort and reply to your emails, research topics, manage your schedule, generate reports, post to social media, monitor websites, automate repetitive tasks, and much more. It comes pre-loaded with powerful skills and learns your preferences over time.",
        },
      },
      {
        "@type": "Question",
        name: "Do I need any technical knowledge?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Not at all. You just talk to it in plain English. Setup takes about 2 minutes — you create a Telegram bot, paste the token, pick a plan, and you're live.",
        },
      },
      {
        "@type": "Question",
        name: "What are skills?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Skills are superpowers you can add to your AI. Things like searching X/Twitter, monitoring websites, managing your inbox, or running safety checks. Every agent comes pre-loaded with the best skills.",
        },
      },
      {
        "@type": "Question",
        name: "What are credits?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Every message your AI handles uses a small number of units. Starter gives you 600 units/day, Pro gives you 1,000/day, and Power gives you 2,500/day — limits reset at midnight UTC.",
        },
      },
      {
        "@type": "Question",
        name: "Is my data private?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. Every user gets their own isolated server — your data never touches another user's environment. We don't train on your conversations or share your information.",
        },
      },
      {
        "@type": "Question",
        name: "Is there a free trial?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes — every plan comes with a 3-day free trial. Full access to everything, no restrictions.",
        },
      },
      {
        "@type": "Question",
        name: "What's BYOK mode?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Bring Your Own Key. If you already have an Anthropic API key, you can connect it directly and pay Anthropic for AI usage yourself. This cuts your InstaClaw price roughly in half.",
        },
      },
      {
        "@type": "Question",
        name: "What AI model does it use?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "InstaClaw runs on Claude by Anthropic. On All-Inclusive plans, we handle model selection automatically. On BYOK plans, you can choose your preferred Claude model.",
        },
      },
      {
        "@type": "Question",
        name: "Do I get full access to the server?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. You get your own dedicated server with full SSH access. You can install software, run custom scripts, and configure it however you want.",
        },
      },
      {
        "@type": "Question",
        name: "Can I cancel anytime?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes, no questions asked. Cancel from your dashboard whenever you want. No contracts, no cancellation fees.",
        },
      },
    ],
  },
];

export default function Home() {
  return (
    <LenisProvider>
      <JsonLd data={homepageJsonLd} />
      <main
        data-theme="landing"
        style={{
          '--background': '#f8f7f4',
          '--foreground': '#333334',
          '--muted': '#6b6b6b',
          '--card': '#ffffff',
          '--border': 'rgba(0, 0, 0, 0.1)',
          '--accent': '#DC6743',
          background: '#f8f7f4',
          color: '#333334',
        } as React.CSSProperties}
      >
        <NotificationBar />
        <Hero />
        <hr className="section-divider" />
        <ScrollReveal text="We believe everyone deserves a *personal* *AI* that actually does ~things.~ Not just chat. Not just suggest. Actually _take_ _action_ on your behalf. Literally anything." />
        <hr className="section-divider" />
        <UseCases />
        <hr className="section-divider" />
        <Testimonials />
        <hr className="section-divider" />
        <HowItWorks />
        <hr className="section-divider" />
        <ScrollReveal text="This sounds impossible, but it's *real.* An AI that works for you _while_ _you_ _sleep._ It remembers everything, handles real tasks on its own, and gets smarter the more you use it. Not a chatbot. A full personal system that never ~stops.~ All yours for *$29* a month. Don't believe us? Try it _free_ for three days." />
        <hr className="section-divider" />
        <Comparison />
        <hr className="section-divider" />
        <Features />
        <hr className="section-divider" />
        <Pricing />
        <hr className="section-divider" />
        <FAQ />
        <hr className="section-divider" />
        <Footer />
      </main>
    </LenisProvider>
  );
}
