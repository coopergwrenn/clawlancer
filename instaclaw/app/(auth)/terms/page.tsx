import Link from "next/link";

export default function TermsOfService() {
  return (
    <main
      data-theme="landing"
      style={{
        "--background": "#f8f7f4",
        "--foreground": "#333334",
        "--muted": "#6b6b6b",
        "--accent": "#DC6743",
        background: "#f8f7f4",
        color: "#333334",
      } as React.CSSProperties}
    >
      <div className="max-w-3xl mx-auto px-4 py-16 sm:py-24">
        <Link
          href="/"
          className="text-sm hover:underline mb-8 inline-block"
          style={{ color: "var(--muted)" }}
        >
          &larr; Back to Home
        </Link>

        <h1
          className="text-4xl sm:text-5xl font-normal tracking-[-1px] leading-[1.05] mb-8"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Terms of Service
        </h1>
        <p className="text-sm mb-12" style={{ color: "var(--muted)" }}>
          Last updated: February 2026
        </p>

        <div
          className="space-y-8 text-sm leading-relaxed"
          style={{ color: "var(--foreground)" }}
        >
          <section>
            <h2 className="text-lg font-semibold mb-3">1. Acceptance of Terms</h2>
            <p>
              By accessing or using InstaClaw (&quot;the Service&quot;), you agree to be
              bound by these Terms of Service. If you do not agree to these terms,
              do not use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">2. Description of Service</h2>
            <p>
              InstaClaw provides hosted AI assistant instances powered by OpenClaw.
              Each subscriber receives a dedicated virtual machine with shell
              access, messaging integrations, and AI capabilities. The Service is
              provided on a subscription basis.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">3. Accounts and Registration</h2>
            <p>
              You must provide accurate information when creating an account. You
              are responsible for maintaining the security of your account
              credentials and for all activity that occurs under your account. You
              must be at least 18 years old to use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">4. Billing and Payment</h2>
            <p>
              Subscriptions are billed monthly. All plans include a 3-day free
              trial. After the trial period, your payment method will be charged
              automatically. You may cancel at any time from the billing page. No
              refunds are provided for partial months.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">5. Acceptable Use</h2>
            <p>You agree not to use the Service to:</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>Violate any applicable laws or regulations</li>
              <li>Send spam, phishing, or other unsolicited messages</li>
              <li>Harass, threaten, or harm others</li>
              <li>Distribute malware or engage in unauthorized access of systems</li>
              <li>Generate content that exploits or harms minors</li>
              <li>Circumvent rate limits or abuse shared infrastructure</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">6. BYOK (Bring Your Own Key)</h2>
            <p>
              If you use BYOK mode, you are responsible for your own Anthropic API
              key usage and billing. InstaClaw is not responsible for charges
              incurred on your Anthropic account.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">7. Service Availability</h2>
            <p>
              We strive for 99.9% uptime but do not guarantee uninterrupted
              service. We may perform maintenance or updates that temporarily
              affect availability. We are not liable for downtime or data loss.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">8. Termination</h2>
            <p>
              We reserve the right to suspend or terminate your account for
              violation of these terms. Upon cancellation or termination, your
              virtual machine and associated data will be deactivated and may be
              permanently deleted after 30 days.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">9. Limitation of Liability</h2>
            <p>
              The Service is provided &quot;as is&quot; without warranties of any kind.
              InstaClaw shall not be liable for any indirect, incidental, or
              consequential damages arising from your use of the Service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">10. Changes to Terms</h2>
            <p>
              We may update these terms from time to time. Continued use of the
              Service after changes constitutes acceptance of the new terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">11. Contact</h2>
            <p>
              For questions about these terms, contact us at{" "}
              <a
                href="mailto:support@instaclaw.io"
                className="underline hover:no-underline"
                style={{ color: "var(--accent)" }}
              >
                support@instaclaw.io
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
