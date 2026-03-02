import { createMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { CtaBanner } from "@/components/marketing/cta-banner";
import Link from "next/link";

export const metadata = createMetadata({
  title: "InstaClaw Quickstart Guide — Get Your AI Agent Running in Minutes",
  description:
    "Step-by-step guide to setting up your InstaClaw personal AI agent. Connect Telegram, personalize your system prompt, enable skills, configure BYOK, and more.",
  path: "/docs",
});

const docsJsonLd = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  name: "InstaClaw Quickstart Guide",
  description:
    "Complete guide to setting up and personalizing your InstaClaw personal AI agent.",
  step: [
    {
      "@type": "HowToStep",
      position: 1,
      name: "Create Your Account",
      text: "Sign up at instaclaw.io with Google or email. If you have an invite code, use it during signup.",
    },
    {
      "@type": "HowToStep",
      position: 2,
      name: "Connect Telegram",
      text: "Message @BotFather in Telegram to create a bot, copy the token, and paste it into your InstaClaw dashboard.",
    },
    {
      "@type": "HowToStep",
      position: 3,
      name: "Pick a Plan",
      text: "Choose Starter ($29/mo), Pro ($99/mo), or Power ($299/mo). All plans include a 3-day free trial.",
    },
    {
      "@type": "HowToStep",
      position: 4,
      name: "Personalize Your Agent",
      text: "Set a custom system prompt to define your agent's personality and behavior. Configure skills and API keys from the dashboard.",
    },
  ],
};

export default function DocsPage() {
  return (
    <>
      <JsonLd data={docsJsonLd} />

      <section className="py-16 sm:py-24 px-4">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-16">
            <h1
              className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-6"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Quickstart Guide
            </h1>
            <p
              className="text-sm sm:text-base max-w-lg mx-auto"
              style={{ color: "#6b6b6b" }}
            >
              Everything you need to get your personal AI agent set up and
              running. The whole process takes about 2 minutes.
            </p>
          </div>

          <div className="space-y-16 text-sm leading-relaxed">
            {/* Step 1 */}
            <section>
              <div className="flex items-center gap-3 mb-4">
                <span
                  className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium"
                  style={{ background: "rgba(220,103,67,0.12)", color: "#DC6743" }}
                >
                  1
                </span>
                <h2
                  className="text-xl sm:text-2xl font-normal tracking-[-0.5px]"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  Create Your Account
                </h2>
              </div>
              <div style={{ color: "#6b6b6b" }}>
                <p>
                  Head to{" "}
                  <Link
                    href="/signup"
                    className="underline hover:opacity-70"
                    style={{ color: "#DC6743" }}
                  >
                    instaclaw.io/signup
                  </Link>{" "}
                  and sign up with Google or email.
                </p>
                <ul className="mt-3 space-y-1.5 list-disc pl-5">
                  <li>If you have an invite code, enter it during signup</li>
                  <li>If you&apos;re on the waitlist, we&apos;ll email you when your spot opens</li>
                  <li>Account creation is instant — no approval process once you have access</li>
                </ul>
              </div>
            </section>

            {/* Step 2 */}
            <section>
              <div className="flex items-center gap-3 mb-4">
                <span
                  className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium"
                  style={{ background: "rgba(220,103,67,0.12)", color: "#DC6743" }}
                >
                  2
                </span>
                <h2
                  className="text-xl sm:text-2xl font-normal tracking-[-0.5px]"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  Connect Telegram
                </h2>
              </div>
              <div style={{ color: "#6b6b6b" }}>
                <p>Telegram is the fastest way to talk to your agent. Here&apos;s how to set it up:</p>
                <ol className="mt-3 space-y-2 list-decimal pl-5">
                  <li>Open Telegram and search for <strong>@BotFather</strong></li>
                  <li>Send <code className="px-1.5 py-0.5 rounded text-xs" style={{ background: "rgba(0,0,0,0.05)" }}>/newbot</code> and follow the prompts to name your bot</li>
                  <li>BotFather will give you an API token — copy it</li>
                  <li>Go to your InstaClaw dashboard and paste the token</li>
                  <li>Click &quot;Connect&quot; — your agent is now live on Telegram</li>
                </ol>
                <p className="mt-3">
                  You can also connect Discord, Slack, or WhatsApp from the same
                  dashboard. All platforms share the same agent and memory.
                </p>
              </div>
            </section>

            {/* Step 3 */}
            <section>
              <div className="flex items-center gap-3 mb-4">
                <span
                  className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium"
                  style={{ background: "rgba(220,103,67,0.12)", color: "#DC6743" }}
                >
                  3
                </span>
                <h2
                  className="text-xl sm:text-2xl font-normal tracking-[-0.5px]"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  Pick a Plan
                </h2>
              </div>
              <div style={{ color: "#6b6b6b" }}>
                <p>Choose the plan that fits your usage:</p>
                <ul className="mt-3 space-y-2">
                  <li><strong style={{ color: "#333334" }}>Starter ($29/mo)</strong> — 600 daily units. Perfect for personal use.</li>
                  <li><strong style={{ color: "#333334" }}>Pro ($99/mo)</strong> — 1,000 daily units. For power users who need more.</li>
                  <li><strong style={{ color: "#333334" }}>Power ($299/mo)</strong> — 2,500 daily units. Maximum performance with upgraded resources.</li>
                </ul>
                <p className="mt-3">
                  All plans come with a <strong style={{ color: "#333334" }}>3-day free trial</strong>.
                  See{" "}
                  <Link href="/pricing" className="underline hover:opacity-70" style={{ color: "#DC6743" }}>
                    full pricing details
                  </Link>.
                </p>
              </div>
            </section>

            {/* Step 4 */}
            <section>
              <div className="flex items-center gap-3 mb-4">
                <span
                  className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium"
                  style={{ background: "rgba(220,103,67,0.12)", color: "#DC6743" }}
                >
                  4
                </span>
                <h2
                  className="text-xl sm:text-2xl font-normal tracking-[-0.5px]"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  Personalize Your Agent
                </h2>
              </div>
              <div style={{ color: "#6b6b6b" }}>
                <p>
                  Your agent works great out of the box, but you can customize it
                  to match your needs:
                </p>
                <ul className="mt-3 space-y-2">
                  <li>
                    <strong style={{ color: "#333334" }}>System prompt:</strong> Define
                    your agent&apos;s personality, tone, and instructions. Tell it who
                    you are, what you do, and how you want it to behave.
                  </li>
                  <li>
                    <strong style={{ color: "#333334" }}>Name:</strong> Give your
                    agent a custom name that shows up in conversations.
                  </li>
                  <li>
                    <strong style={{ color: "#333334" }}>Skills:</strong> Browse
                    and enable skills from the dashboard. Each skill adds new
                    capabilities to your agent.
                  </li>
                  <li>
                    <strong style={{ color: "#333334" }}>API keys:</strong> Add
                    keys for third-party services (encrypted at rest) to unlock
                    more capabilities.
                  </li>
                </ul>
              </div>
            </section>

            {/* BYOK Setup */}
            <section>
              <div className="flex items-center gap-3 mb-4">
                <span
                  className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium"
                  style={{ background: "rgba(220,103,67,0.12)", color: "#DC6743" }}
                >
                  5
                </span>
                <h2
                  className="text-xl sm:text-2xl font-normal tracking-[-0.5px]"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  BYOK Setup (Optional)
                </h2>
              </div>
              <div style={{ color: "#6b6b6b" }}>
                <p>
                  If you have your own Anthropic API key, you can switch to BYOK
                  (Bring Your Own Key) mode to reduce your subscription cost:
                </p>
                <ol className="mt-3 space-y-2 list-decimal pl-5">
                  <li>Get an API key from <a href="https://console.anthropic.com" target="_blank" rel="noopener noreferrer" className="underline hover:opacity-70" style={{ color: "#DC6743" }}>console.anthropic.com</a></li>
                  <li>Go to Settings in your InstaClaw dashboard</li>
                  <li>Paste your API key — it&apos;s encrypted and stored on your VM only</li>
                  <li>Switch your plan to the BYOK tier</li>
                </ol>
                <p className="mt-3">
                  In BYOK mode, all API calls go directly from your VM to
                  Anthropic. We never proxy or log them. You get full control
                  over model selection, rate limits, and token budgets.
                </p>
              </div>
            </section>

            {/* Tips */}
            <section>
              <h2
                className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                Tips for Getting the Most Out of Your Agent
              </h2>
              <ul className="space-y-3" style={{ color: "#6b6b6b" }}>
                <li className="flex items-start gap-2">
                  <span className="shrink-0 mt-0.5" style={{ color: "#DC6743" }}>1.</span>
                  <span><strong style={{ color: "#333334" }}>Be specific.</strong> Instead of &quot;help me with email&quot;, say &quot;check my inbox and summarize the 5 most important messages.&quot;</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="shrink-0 mt-0.5" style={{ color: "#DC6743" }}>2.</span>
                  <span><strong style={{ color: "#333334" }}>Teach it your workflows.</strong> Walk your agent through a task once, and it will remember how to do it next time.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="shrink-0 mt-0.5" style={{ color: "#DC6743" }}>3.</span>
                  <span><strong style={{ color: "#333334" }}>Use the system prompt.</strong> Tell your agent about yourself — your job, preferences, schedule, and priorities. The more context it has, the better it performs.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="shrink-0 mt-0.5" style={{ color: "#DC6743" }}>4.</span>
                  <span><strong style={{ color: "#333334" }}>Switch models strategically.</strong> Use Haiku for quick tasks (1 unit), Sonnet for complex reasoning (4 units), and Opus for your most demanding work (19 units).</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="shrink-0 mt-0.5" style={{ color: "#DC6743" }}>5.</span>
                  <span><strong style={{ color: "#333334" }}>Set up scheduled tasks.</strong> Ask your agent to check things regularly — &quot;every morning at 8am, summarize the news about AI.&quot;</span>
                </li>
              </ul>
            </section>

            {/* Troubleshooting */}
            <section>
              <h2
                className="text-xl sm:text-2xl font-normal tracking-[-0.5px] mb-4"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                Troubleshooting
              </h2>
              <div className="space-y-4" style={{ color: "#6b6b6b" }}>
                <div>
                  <p className="font-medium" style={{ color: "#333334" }}>
                    My agent isn&apos;t responding
                  </p>
                  <p className="mt-1">
                    Check your dashboard for health status. If the status shows
                    &quot;unhealthy&quot;, the self-healing system will auto-recover
                    within a few minutes. If it persists, contact support.
                  </p>
                </div>
                <div>
                  <p className="font-medium" style={{ color: "#333334" }}>
                    I ran out of daily units
                  </p>
                  <p className="mt-1">
                    Units reset at midnight UTC. You can also purchase credit
                    packs from the dashboard for instant overflow. Or consider
                    upgrading your plan.
                  </p>
                </div>
                <div>
                  <p className="font-medium" style={{ color: "#333334" }}>
                    My Telegram bot token isn&apos;t working
                  </p>
                  <p className="mt-1">
                    Make sure you copied the full token from @BotFather
                    (including the colon). Try revoking and creating a new token
                    if it still doesn&apos;t work.
                  </p>
                </div>
              </div>
            </section>
          </div>

          <div
            className="text-center mt-16 text-sm"
            style={{ color: "#6b6b6b" }}
          >
            <p>
              <Link
                href="/how-it-works"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                How it works
              </Link>{" "}
              ·{" "}
              <Link
                href="/faq"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                FAQ
              </Link>{" "}
              ·{" "}
              <Link
                href="/pricing"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                Pricing
              </Link>{" "}
              ·{" "}
              <Link
                href="/use-cases"
                className="underline hover:opacity-70"
                style={{ color: "#DC6743" }}
              >
                Use cases
              </Link>
            </p>
          </div>
        </div>
      </section>

      <CtaBanner />
    </>
  );
}
