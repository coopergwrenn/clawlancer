import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Comparison } from "@/components/landing/comparison";
import { UseCases } from "@/components/landing/use-cases";
import { Features } from "@/components/landing/features";
import { Pricing } from "@/components/landing/pricing";
import { Footer } from "@/components/landing/footer";

export default function Home() {
  return (
    <main>
      <Hero />
      <HowItWorks />
      <Comparison />
      <UseCases />
      <Features />
      <Pricing />
      <Footer />
    </main>
  );
}
