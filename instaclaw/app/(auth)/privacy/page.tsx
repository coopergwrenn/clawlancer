import Link from "next/link";

export default function PrivacyPolicy() {
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
          Privacy Policy
        </h1>
        <p className="text-sm mb-12" style={{ color: "var(--muted)" }}>
          Last updated: February 2026
        </p>

        <div
          className="space-y-8 text-sm leading-relaxed"
          style={{ color: "var(--foreground)" }}
        >
          <section>
            <h2 className="text-lg font-semibold mb-3">1. Information We Collect</h2>
            <p>When you use InstaClaw, we collect:</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>
                <strong>Account information:</strong> Name, email address, and
                Google account ID provided during sign-up.
              </li>
              <li>
                <strong>Payment information:</strong> Processed securely by Stripe.
                We do not store your credit card details.
              </li>
              <li>
                <strong>Bot configuration:</strong> Messaging platform tokens,
                system prompts, and environment variables you provide.
              </li>
              <li>
                <strong>Usage data:</strong> Conversation counts, feature usage,
                and error logs for service improvement.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">2. How We Use Your Information</h2>
            <p>We use your information to:</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>Provide and maintain the Service</li>
              <li>Process payments and manage subscriptions</li>
              <li>Send service-related communications (billing, health alerts, etc.)</li>
              <li>Improve the Service and fix issues</li>
              <li>Comply with legal obligations</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">3. Data Storage and Security</h2>
            <p>
              Your AI assistant runs on a dedicated virtual machine. Conversations
              and files are stored on your VM instance. API keys and sensitive
              tokens are encrypted at rest using AES-256-GCM. We use SSH with
              private key authentication for all server access.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">4. Third-Party Services</h2>
            <p>We use the following third-party services:</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>
                <strong>Stripe:</strong> Payment processing (
                <a
                  href="https://stripe.com/privacy"
                  className="underline hover:no-underline"
                  style={{ color: "var(--accent)" }}
                >
                  Stripe Privacy Policy
                </a>
                )
              </li>
              <li>
                <strong>Google:</strong> Authentication (
                <a
                  href="https://policies.google.com/privacy"
                  className="underline hover:no-underline"
                  style={{ color: "var(--accent)" }}
                >
                  Google Privacy Policy
                </a>
                )
              </li>
              <li>
                <strong>Anthropic:</strong> AI model provider (
                <a
                  href="https://www.anthropic.com/privacy"
                  className="underline hover:no-underline"
                  style={{ color: "var(--accent)" }}
                >
                  Anthropic Privacy Policy
                </a>
                )
              </li>
              <li>
                <strong>Hetzner:</strong> Server infrastructure (
                <a
                  href="https://www.hetzner.com/legal/privacy-policy"
                  className="underline hover:no-underline"
                  style={{ color: "var(--accent)" }}
                >
                  Hetzner Privacy Policy
                </a>
                )
              </li>
              <li>
                <strong>Sentry:</strong> Error tracking and monitoring
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">5. Data Retention</h2>
            <p>
              We retain your account data for as long as your account is active.
              Upon cancellation, your virtual machine is deactivated immediately.
              VM data (conversations, files, configurations) may be permanently
              deleted 30 days after cancellation.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">6. Your Rights</h2>
            <p>You have the right to:</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>Access the personal data we hold about you</li>
              <li>Request correction of inaccurate data</li>
              <li>Request deletion of your account and associated data</li>
              <li>Export your conversation history and files via the dashboard</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">7. Cookies</h2>
            <p>
              We use essential cookies for authentication and session management.
              We do not use tracking cookies or third-party advertising cookies.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">8. Children&apos;s Privacy</h2>
            <p>
              The Service is not intended for users under 18 years of age. We do
              not knowingly collect personal information from children.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">9. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. We will notify
              you of significant changes via email or through the Service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-3">10. Contact</h2>
            <p>
              For privacy-related questions or requests, contact us at{" "}
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
