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

export default function Home() {
  return (
    <LenisProvider>
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
        <HowItWorks />
        <hr className="section-divider" />
        <ScrollReveal text="This sounds impossible, but it's *real.* An AI that works for you _while_ _you_ _sleep._ It remembers everything, handles real tasks on its own, and gets smarter the more you use it. Not a chatbot. A full personal system that never ~stops.~ All yours for *$29* a month. Don't believe us? Try it _free_ for seven days." />
        <hr className="section-divider" />
        <Comparison />
        <hr className="section-divider" />
        <Features />
        <hr className="section-divider" />
        <Testimonials />
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
